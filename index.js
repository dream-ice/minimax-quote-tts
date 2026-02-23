import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const MODULE_NAME = 'minimax_quote_tts';
const PROXY_ENDPOINT = '/api/minimax/generate-voice';
const LLM_PROXY = '/api/minimax/proxy';
const DEFAULT_API_HOST = 'https://api.minimax.io';

const TARGET_TYPE = { CURRENT_CHARACTER: 'current_character', CURRENT_USER: 'current_user', CUSTOM: 'custom' };
const API_FORMATS = { OAI: 'openai', GOOGLE: 'google' };
const MODEL_OPTIONS = [
    { value: 'speech-02-hd', label: 'speech-02-hd (高画质)' },
    { value: 'speech-02-turbo', label: 'speech-02-turbo (极速)' },
    { value: 'speech-01', label: 'speech-01 (标准)' },
];

const defaults = {
    enabled: true, autoPlay: true, showMessageButton: true, onlyCharacter: true,
    apiKey: '', groupId: '', apiHost: DEFAULT_API_HOST, model: 'speech-02-hd', voiceId: 'male-qn-qingse',
    speed: 1, vol: 1, pitch: 0, emotion: '', audioFormat: 'mp3',
    maxQuotesPerMessage: 4, minLength: 1, maxLength: 300, ignoreCodeBlocks: true,
    characterBindingsMap: {}, formatterPresets: [], formatterTemplates: [],
    formatterEnabled: false, formatterApiUrl: '', formatterApiKey: '', formatterModel: '', formatterFormat: API_FORMATS.OAI,
    formatterSystemPrompt: '请以严格的 JSON 格式返回：{"segments":[{"text":"...","speaker":"...","emotion":"...","speed":1.0,"vol":1.0,"pitch":0}]}. 仅保留可朗读的内容。',
    serverHistory: {},
};

let playbackQueue = [], isPlaying = false, clickTimer = null;
let activeAudio = new Audio();
const localAudioCache = new Map();

function s() { return extension_settings[MODULE_NAME]; }

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const settings = extension_settings[MODULE_NAME];
    for (const key in defaults) { if (settings[key] === undefined) settings[key] = JSON.parse(JSON.stringify(defaults[key])); }
}

function simpleHash(t) {
    if (!t) return 0;
    let h = 0; for (let i = 0; i < t.length; i++) h = ((h << 5) - h) + t.charCodeAt(i), h |= 0;
    return Math.abs(h);
}

function buildMessageKey(ctx, id, m) {
    return `${ctx.chatId || 'no-chat'}:${id}:${m?.swipe_id || 0}:${simpleHash(m?.mes)}`;
}

function getMessageData(id) {
    const ctx = getContext(); const m = ctx?.chat?.[id];
    return { ctx, message: m, key: m ? buildMessageKey(ctx, id, m) : '' };
}

function normalizeOaiUrl(url) {
    let u = (url || '').trim().replace(/\/+$/, ''); if (!u) return '';
    if (!u.endsWith('/chat/completions') && !u.includes('google')) u += '/chat/completions';
    return u;
}

// --- ST Server Sync ---
async function uploadToSTServer(blob, filename) {
    try {
        const reader = new FileReader();
        const base64 = await new Promise(r => { reader.onloadend = () => r(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
        const res = await fetch('/api/files/upload', {
            method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `minimax_${filename}`, data: base64 })
        });
        const data = await res.json(); return data.path;
    } catch (e) { return null; }
}

async function getAudioFromSTServer(path) {
    try { const res = await fetch(path, { headers: getRequestHeaders() }); return res.ok ? await res.blob() : null; } catch (e) { return null; }
}

async function proxyFetch(url, options = {}) {
    const res = await fetch(LLM_PROXY, {
        method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body || null })
    });
    if (res.status === 404) throw new Error('接口 404，请确保重启后端！');
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) throw new Error(data?.error || (typeof data === 'string' ? data : `HTTP ${res.status}`));
    return data;
}

async function getAudioBlob(item) {
    const cacheKey = `tts_${simpleHash(item.text)}_${simpleHash(JSON.stringify(item.options))}`;
    if (localAudioCache.has(cacheKey)) return localAudioCache.get(cacheKey);
    if (item.serverPath) {
        const res = await fetch(item.serverPath, { headers: getRequestHeaders() });
        if (res.ok) { const b = await res.blob(); localAudioCache.set(cacheKey, b); return b; }
    }
    const set = s();
    const res = await fetch(PROXY_ENDPOINT, {
        method: 'POST', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: item.text, apiHost: set.apiHost, model: item.options.model, voiceId: item.options.voiceId,
            speed: item.options.speed, volume: item.options.vol, pitch: item.options.pitch,
            format: item.options.audioFormat, emotion: item.options.emotion,
            apiKey: (set.apiKey || '').trim(), groupId: (set.groupId || '').trim(),
        }),
    });
    if (!res.ok) throw new Error('API 失败');
    const blob = await res.blob(); localAudioCache.set(cacheKey, blob);
    uploadToSTServer(blob, `${cacheKey}.${item.options.audioFormat}`).then(path => { if(path) item.serverPath = path; });
    return blob;
}

// --- Player ---
async function playNext() {
    if (playbackQueue.length === 0) { isPlaying = false; return; }
    isPlaying = true; const item = playbackQueue.shift();
    try {
        const blob = await getAudioBlob(item);
        const url = URL.createObjectURL(blob);
        activeAudio.src = url;
        activeAudio.onended = () => { URL.revokeObjectURL(url); playNext(); };
        activeAudio.onerror = () => { URL.revokeObjectURL(url); playNext(); };
        await activeAudio.play();
    } catch (e) { playNext(); }
}

async function formatWithSecondaryApi(m) {
    const set = s(), format = set.formatterFormat, prompt = set.formatterSystemPrompt;
    let url = normalizeOaiUrl(set.formatterApiUrl);
    try {
        let text;
        if (format === API_FORMATS.OAI) {
            const data = await proxyFetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...(set.formatterApiKey ? { 'Authorization': `Bearer ${set.formatterApiKey.trim()}` } : {}) },
                body: { model: set.formatterModel, messages: [{ role: 'system', content: prompt }, { role: 'user', content: m.mes }], temperature: 0.1 }
            });
            text = data.choices?.[0]?.message?.content;
        } else {
            const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${set.formatterModel}:generateContent?key=${set.formatterApiKey.trim()}`;
            const data = await proxyFetch(gUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { contents: [{ role: 'user', parts: [{ text: `System Prompt: ${prompt}\n\nUser Message: ${m.mes}` }] }] } });
            text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        }
        const match = text.match(/\{[\s\S]*\}/); if (!match) throw new Error('AI 无有效 JSON');
        return JSON.parse(match[0])?.segments || null;
    } catch (e) { throw e; }
}

function findCharacterBinding(speakerName) {
    if (!speakerName) return null;
    const set = s(), ctx = getContext(), name = speakerName.toLowerCase();
    const id = ctx.characterId || ctx.character_id || ctx.name2 || 'global';
    const bindings = set.characterBindingsMap[id] || [];
    return bindings.find(b => {
        const bName = (b.targetType === TARGET_TYPE.CUSTOM ? b.customName : (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 : ctx.name1))?.toLowerCase();
        return bName === name;
    });
}

function buildSynthesisOptions(seg, m) {
    const set = s(); const b = findCharacterBinding(seg?.speaker || m?.name);
    return {
        model: seg?.model || b?.model || set.model, voiceId: seg?.voiceId || b?.voiceId || set.voiceId,
        speed: Number(seg?.speed || set.speed), vol: Number(set.vol || 1.0), pitch: Number(set.pitch || 0),
        emotion: seg?.emotion || set.emotion || undefined, audioFormat: set.audioFormat || 'mp3',
    };
}

async function generateMessageSpeech(id, forced = false) {
    const { message, key } = getMessageData(id); if (!message || (s().onlyCharacter && message.is_user)) return false;
    let h = s().serverHistory[key]; if (!forced && h?.versions?.length) return true;
    try {
        const raw = s().formatterEnabled ? await formatWithSecondaryApi(message) : message.mes.replace(/```[\s\S]*?```/g, ' ').match(/[^\s"“”「」『』]+(?=["“”「」『』])/g)?.map(t => ({ text: t, speaker: message.name })) || [{ text: message.mes, speaker: message.name }];
        const items = raw.map(seg => ({ text: seg.text, speaker: seg.speaker || message.name, options: buildSynthesisOptions(seg, message), serverPath: null }));
        if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
        s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
        s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
        saveSettingsDebounced(); refreshAllMessageButtons(); return true;
    } catch (e) { toastr.error('生成失败: ' + e.message); return false; }
}

async function playGeneratedMessage(id) {
    const { key } = getMessageData(id); const h = s().serverHistory[key];
    if (!h?.versions[h.activeIndex]) return false;
    playbackQueue = [...JSON.parse(JSON.stringify(h.versions[h.activeIndex].items))];
    activeAudio.pause(); activeAudio.src = '';
    if (!isPlaying) playNext();
    setTimeout(() => saveSettingsDebounced(), 2000);
    return true;
}

function refreshAllMessageButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const id = el.getAttribute('mesid'), { key } = getMessageData(id);
        const extra = el.querySelector('.extraMesButtons'); if (!extra) return;
        let btn = el.querySelector('.mes_quote_tts');
        if (!btn) { btn = document.createElement('div'); btn.className = 'mes_button mes_quote_tts fa-solid fa-volume-high'; extra.appendChild(btn); }
        btn.classList.toggle('ready', !!(s().serverHistory[key]?.versions?.length > 0));
    });
}

function openParamsEditor(id) {
    const { key } = getMessageData(id); let h = s().serverHistory[key]; if (!h?.versions?.length) return;
    const render = () => {
        const v = h.versions[h.activeIndex];
        const rows = v.items.map((it, i) => `
            <div class="minimax-tts-editor-item">
                <div style="font-size:0.8rem; opacity:0.6; margin-bottom:4px;">说话人: <input class="edit-v" data-prop="speaker" data-idx="${i}" value="${it.speaker || ''}" style="width:100px; height:20px !important; display:inline-block; border:none !important; background:none !important; color:inherit !important; padding:0 !important;"></div>
                <textarea class="text_pole" readonly style="width:100%; height:40px; margin-bottom:8px; background:rgba(0,0,0,0.2) !important;">${it.text}</textarea>
                <div class="minimax-tts-editor-grid">
                    <div class="minimax-tts-editor-row-flex"><label>模型</label><select class="text_pole edit-v" data-prop="model" data-idx="${i}">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
                    <div class="minimax-tts-editor-row-flex"><label>语音</label><input class="text_pole edit-v" data-prop="voiceId" data-idx="${i}" value="${it.options.voiceId}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>情感</label><input class="text_pole edit-v" data-prop="emotion" data-idx="${i}" value="${it.options.emotion||''}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>语速</label><input class="text_pole edit-v" data-prop="speed" type="number" step="0.1" data-idx="${i}" value="${it.options.speed}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音量</label><input class="text_pole edit-v" data-prop="vol" type="number" step="0.1" data-idx="${i}" value="${it.options.vol}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音调</label><input class="text_pole edit-v" data-prop="pitch" type="number" step="1" data-idx="${i}" value="${it.options.pitch}"></div>
                </div>
            </div>`).join('');
        const html = `<div id="minimax_quote_tts_editor" class="minimax-tts-editor-mask"><div class="minimax-tts-editor-dialog">
            <div class="minimax-tts-editor-header">
                <div style="font-weight:bold; font-size:1.1rem; flex:1">版本历史 ${h.activeIndex+1}/${h.versions.length}</div>
                <div style="display:flex; gap:10px; align-items:center; justify-content:center; flex:1">
                    <button class="menu_button v-prev" style="width:40px;"> < </button>
                    <button class="menu_button v-next" style="width:40px;"> > </button>
                </div>
                <div style="text-align:right;"><button class="menu_button editor-close">关闭面板</button></div>
            </div>
            <div class="minimax-tts-editor-body">${rows}</div>
            <div class="minimax-tts-editor-actions">
                <button class="menu_button editor-save-only" style="height:40px;">保存修改</button>
                <button class="menu_button editor-confirm" style="height:40px;">确认并选择此版本</button>
            </div>
        </div></div>`;
        $('#minimax_quote_tts_editor').remove(); $('body').append(html);
        $('#minimax_quote_tts_editor .v-prev').on('click', () => { if(h.activeIndex>0){ h.activeIndex--; render(); } });
        $('#minimax_quote_tts_editor .v-next').on('click', () => { if(h.activeIndex<h.versions.length-1){ h.activeIndex++; render(); } });
        $('#minimax_quote_tts_editor .editor-close').on('click', () => $('#minimax_quote_tts_editor').remove());
        $('#minimax_quote_tts_editor .edit-v').on('change input', function(){ 
            const p = $(this).data('prop'), idx = $(this).data('idx'), val = $(this).val();
            if(p === 'speaker'){ v.items[idx].speaker = val; const b = findCharacterBinding(val); if(b){ v.items[idx].options.model = b.model || s().model; v.items[idx].options.voiceId = b.voiceId || s().voiceId; render(); } }
            else { v.items[idx].options[p] = val; } v.items[idx].serverPath = null;
        });
        $('#minimax_quote_tts_editor .editor-save-only').on('click', () => { saveSettingsDebounced(); toastr.success('已保存'); });
        $('#minimax_quote_tts_editor .editor-confirm').on('click', () => { saveSettingsDebounced(); $('#minimax_quote_tts_editor').remove(); refreshAllMessageButtons(); });
        $('#minimax_quote_tts_editor select.edit-v').each(function(){ $(this).val(v.items[$(this).data('idx')].options.model); });
    }; render();
}

function createUi() {
    const html = `
<div id="minimax_quote_tts_panel" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>MiniMax语音</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content"><div class="minimax-quote-tts-panel-inner" style="padding:10px;">
            <div class="minimax-quote-tts-section-title"><b>MiniMax 配置</b></div>
            <div class="minimax-quote-tts-row"><label>API Key</label><input id="m_key" type="password"></div>
            <div class="minimax-quote-tts-row"><label>Group ID</label><input id="m_gid" type="text"></div>
            <div class="minimax-quote-tts-row"><label>默认模型</label><select id="m_model">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
            <div class="minimax-quote-tts-row"><label>默认语音ID</label><input id="m_voice" type="text"></div>
            <div class="minimax-quote-tts-row"><label>基础语速</label><input id="m_speed" type="number" step="0.1"></div>
            <div class="minimax-quote-tts-row"><label>基础音量</label><input id="m_vol" type="number" step="0.1"></div>
            <div class="minimax-quote-tts-row"><label>自动播放</label><div class="checkbox-container"><input id="m_autoplay" type="checkbox"></div></div>
            <div class="minimax-quote-tts-row"><button id="m_test_minimax" class="menu_button">测试 MiniMax 语音</button></div>
            <hr>
            <div class="minimax-quote-tts-section-title"><b>副 API 格式化 (LLM)</b> <div class="checkbox-container"><input id="m_f_en" type="checkbox"> &nbsp;开启</div></div>
            <div class="minimax-quote-tts-row"><label>配置预设</label><select id="m_f_presets"></select><button id="m_f_save_p" class="menu_button">保存</button><button id="m_f_upd_p" class="menu_button">更新</button><button id="m_f_del_p" class="menu_button">删除</button></div>
            <div class="minimax-quote-tts-row"><label>接口格式</label><select id="m_f_format"><option value="${API_FORMATS.OAI}">OpenAI</option><option value="${API_FORMATS.GOOGLE}">Google Gemini</option></select></div>
            <div class="minimax-quote-tts-row"><label>API 地址</label><input id="m_f_url" type="text"></div>
            <div class="minimax-quote-tts-row"><label>API 密钥</label><input id="m_f_key" type="password"></div>
            <div class="minimax-quote-tts-row"><label>AI 模型</label><input id="m_f_model" type="text"><select id="m_f_model_sel" style="display:none"></select><button id="m_f_fetch" class="menu_button">获取</button><button id="m_f_test_conn" class="menu_button">测试</button></div>
            <div class="minimax-quote-tts-row"><label>提示词模板</label><select id="m_f_templates"></select><button id="m_f_save_t" class="menu_button">保存</button><button id="m_f_upd_t" class="menu_button">更新</button><button id="m_f_del_t" class="menu_button">删除</button></div>
            <div class="minimax-quote-tts-row"><label>提示词</label><textarea id="m_f_prompt"></textarea></div>
            <hr>
            <div class="minimax-quote-tts-section-title"><b>角色绑定 (当前角色专用)</b> <button id="m_add_b" class="menu_button">添加绑定</button></div>
            <div id="m_b_rows"></div>
        </div></div></div>`;
    $('#extensions_settings').append(html);
    const selP = $('#m_f_presets'), selT = $('#m_f_templates');
    const upPresets = () => { selP.empty().append('<option value="-1">-- 新建预设 --</option>'); s().formatterPresets.forEach((p, i) => selP.append(`<option value="${i}">${p.name}</option>`)); };
    const upTemplates = () => { selT.empty().append('<option value="-1">-- 新建模板 --</option>'); s().formatterTemplates.forEach((t, i) => selT.append(`<option value="${i}">${t.name}</option>`)); };
    const sync = () => {
        const set = s(); set.apiKey = $('#m_key').val(); set.groupId = $('#m_gid').val(); set.model = $('#m_model').val();
        set.voiceId = $('#m_voice').val(); set.speed = Number($('#m_speed').val()); set.vol = Number($('#m_vol').val()); set.autoPlay = $('#m_autoplay').prop('checked');
        set.formatterEnabled = $('#m_f_en').prop('checked'); set.formatterFormat = $('#m_f_format').val();
        set.formatterApiUrl = $('#m_f_url').val(); set.formatterApiKey = $('#m_f_key').val();
        set.formatterModel = ($('#m_f_model_sel').is(':visible') ? $('#m_f_model_sel').val() : $('#m_f_model').val());
        set.formatterSystemPrompt = $('#m_f_prompt').val(); saveSettingsDebounced();
    };
    const renderB = () => {
        const c = getContext(), id = c.characterId || c.character_id || c.name2 || 'global';
        if (!s().characterBindingsMap[id]) s().characterBindingsMap[id] = [];
        $('#m_b_rows').empty();
        s().characterBindingsMap[id].forEach((b, i) => {
            const row = $(`<div style="display:grid; grid-template-columns:1.2fr 1fr 1fr 1fr auto; gap:4px; margin-bottom:4px; align-items:center;">
                <select class="text_pole b-type"><option value="${TARGET_TYPE.CURRENT_CHARACTER}">${c.name2||'角色'}</option><option value="${TARGET_TYPE.CURRENT_USER}">${c.name1||'你'}</option><option value="${TARGET_TYPE.CUSTOM}">自定义</option></select>
                <input class="text_pole b-name" placeholder="名" value="${b.customName||''}" style="${b.targetType==='custom'?'':'display:none'}">
                <select class="text_pole b-model">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select>
                <input class="text_pole b-voice" placeholder="ID" value="${b.voiceId}">
                <button class="menu_button b-del">×</button>
            </div>`);
            row.find('.b-type').val(b.targetType).on('change', function(){ b.targetType=$(this).val(); renderB(); sync(); });
            row.find('.b-name').on('input', function(){ b.customName=$(this).val(); sync(); });
            row.find('.b-model').val(b.model || s().model).on('change', function(){ b.model=$(this).val(); sync(); });
            row.find('.b-voice').on('input', function(){ b.voiceId=$(this).val(); sync(); });
            row.find('.b-del').on('click', () => { s().characterBindingsMap[id].splice(i, 1); renderB(); sync(); }); $('#m_b_rows').append(row);
        });
    };
    $('#m_f_save_p').on('click', () => { const n = prompt('预设名:'); if(!n) return; s().formatterPresets.push({name:n, url:s().formatterApiUrl, key:s().formatterApiKey, format:s().formatterFormat, model:s().formatterModel}); upPresets(); sync(); });
    $('#m_f_upd_p').on('click', () => { const i = selP.val(); if(i >= 0) { s().formatterPresets[i] = { ...s().formatterPresets[i], url: s().formatterApiUrl, key: s().formatterApiKey, format: s().formatterFormat, model: s().formatterModel }; toastr.success('更新成功'); sync(); } });
    $('#m_f_del_p').on('click', () => { const i = selP.val(); if(i >= 0) { s().formatterPresets.splice(i, 1); upPresets(); sync(); } });
    selP.on('change', function() { const p = s().formatterPresets[$(this).val()]; if (!p) return; $('#m_f_url').val(p.url); $('#m_f_key').val(p.key); $('#m_f_format').val(p.format); $('#m_f_model').val(p.model).show(); $('#m_f_model_sel').hide(); sync(); });
    $('#m_f_save_t').on('click', () => { const n = prompt('模板名:'); if(!n) return; s().formatterTemplates.push({name:n, content:s().formatterSystemPrompt}); upTemplates(); sync(); });
    $('#m_f_upd_t').on('click', () => { const i = selT.val(); if(i >= 0) { s().formatterTemplates[i].content = s().formatterSystemPrompt; toastr.success('更新成功'); sync(); } });
    $('#m_f_del_t').on('click', () => { const i = selT.val(); if(i >= 0) { s().formatterTemplates.splice(i, 1); upTemplates(); sync(); } });
    selT.on('change', function() { const t = s().formatterTemplates[$(this).val()]; if (t) { $('#m_f_prompt').val(t.content); sync(); } });
    $('#m_f_fetch').on('click', async () => {
        const set = s(), url = set.formatterApiUrl.trim().replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
        try {
            let m = []; if (set.formatterFormat === API_FORMATS.OAI) { const d = await proxyFetch(`${url}/models`, { headers: set.formatterApiKey ? { 'Authorization': `Bearer ${set.formatterApiKey.trim()}` } : {} }); m = d.data?.map(it => typeof it === 'string' ? it : it.id) || []; }
            else { const d = await proxyFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${set.formatterApiKey.trim()}`); m = d.models?.map(it => it.name.replace('models/', '')) || []; }
            if (m.length) { const sel = $('#m_f_model_sel').empty().show(); $('#m_f_model').hide(); m.forEach(it => sel.append(`<option value="${it}">${it}</option>`)); sel.val(m[0]); sync(); toastr.success('获取成功'); }
        } catch(e){ toastr.error(e.message); }
    });
    $('#m_f_test_conn').on('click', async () => {
        try { const url = normalizeOaiUrl(s().formatterApiUrl); const d = await proxyFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { model: s().formatterModel, messages: [{ role: 'user', content: 'Say connected' }], temperature: 0.1 } });
        if(d) toastr.success('API 连通成功！'); } catch(e){ toastr.error(e.message); }
    });
    $('#m_test_minimax').on('click', async () => {
        try { const b = await synthesizeSpeech('你好', { model: s().model, voiceId: s().voiceId, speed: s().speed, vol: s().vol, pitch: s().pitch, audioFormat: s().audioFormat }, `test_${Date.now()}`); new Audio(URL.createObjectURL(b.blob)).play(); toastr.success('语音连通成功！'); } catch(e){ toastr.error(e.message); }
    });
    $('#m_add_b').on('click', () => { const c = getContext(), id = c.characterId || c.character_id || c.name2 || 'global'; if (!s().characterBindingsMap[id]) s().characterBindingsMap[id] = []; s().characterBindingsMap[id].push({ targetType: 'custom', customName: '', voiceId: '', model: s().model }); renderB(); sync(); });

    loadSettings();
    $('#m_key').val(s().apiKey); $('#m_gid').val(s().groupId); $('#m_voice').val(s().voiceId); $('#m_model').val(s().model);
    $('#m_speed').val(s().speed); $('#m_vol').val(s().vol); $('#m_autoplay').prop('checked', s().autoPlay);
    $('#m_f_en').prop('checked', s().formatterEnabled); $('#m_f_format').val(s().formatterFormat);
    $('#m_f_url').val(s().formatterApiUrl); $('#m_f_key').val(s().formatterApiKey);
    $('#m_f_model').val(s().formatterModel); $('#m_f_prompt').val(s().formatterSystemPrompt);
    upPresets(); upTemplates(); renderB();
    $('.minimax-quote-tts-panel-inner input, .minimax-quote-tts-panel-inner select, .minimax-quote-tts-panel-inner textarea').on('input change', sync);
    eventSource.on(event_types.CHARACTER_SELECTED, renderB); eventSource.on(event_types.CHAT_CHANGED, renderB);
}

jQuery(async () => {
    loadSettings(); createUi();
    let timer, longP;
    
    // --- 自动播放监听 ---
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (id) => {
        if (s().enabled && s().autoPlay) {
            console.log('[MiniMax语音] 检测到新消息，准备自动播放:', id);
            if (await generateMessageSpeech(id, false)) {
                playGeneratedMessage(id);
            }
        }
    });

    $(document).on('mousedown touchstart', '.mes_quote_tts', function(){
        const id = Number($(this).closest('.mes').attr('mesid')); longP=false;
        timer = setTimeout(async () => {
            longP = true;
            if (s().formatterEnabled) {
                toastr.info('生成结构中...');
                if (await generateMessageSpeech(id, true)) toastr.success('生成成功！点击图标播放。');
            } else { if (await generateMessageSpeech(id, true)) playGeneratedMessage(id); }
        }, 600);
    }).on('mouseup mouseleave touchend touchcancel', '.mes_quote_tts', () => clearTimeout(timer));

    $(document).on('click', '.mes_quote_tts', function(e){
        if(longP) return;
        if(clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(async () => {
            clickTimer = null;
            const id = Number($(e.target).closest('.mes').attr('mesid')), { key } = getMessageData(id);
            if (s().formatterEnabled) {
                if (!s().serverHistory[key] || !s().serverHistory[key].versions.length) return toastr.warning('请先长按。');
                playGeneratedMessage(id);
            } else { if (await generateMessageSpeech(id)) playGeneratedMessage(id); }
        }, 250);
    }).on('dblclick', '.mes_quote_tts', function(e){
        e.preventDefault(); if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openParamsEditor(Number($(this).closest('.mes').attr('mesid')));
    });
    setInterval(refreshAllMessageButtons, 1000);
});
