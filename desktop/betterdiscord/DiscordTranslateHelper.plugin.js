/**
 * @name DiscordTranslateHelper
 * @description Translate Discord messages and write in another language. Adds "🌐 Translate" under each message and a button next to your input to translate your own text before sending. Free Google Translate, plus optional Gemini/OpenRouter/DeepL/MyMemory/LibreTranslate.
 * @version 0.1.0
 * @author DTH
 * @source https://github.com/AntikDev/discordHelper
 */

// === Константы (синхронизированы с веб-расширением) ===
const PLUGIN_NAME = 'DiscordTranslateHelper';
const STYLE_ID   = 'dth-style';

const LANG_NAMES = {
  ru: 'Russian', en: 'English', uk: 'Ukrainian', kk: 'Kazakh',
  be: 'Belarusian', de: 'German', fr: 'French', es: 'Spanish',
  pt: 'Portuguese', tr: 'Turkish', ja: 'Japanese', zh: 'Chinese',
  ar: 'Arabic', pl: 'Polish'
};

const LANG_LABELS = { uk: 'UA', be: 'BY', kk: 'KZ', ja: 'JP', zh: 'CN' };

const ALL_LANGS = ['ru','en','uk','kk','be','de','fr','es','pt','tr','ja','zh','ar','pl'];

const ALLOWED_OPENROUTER_MODELS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite'
];

// Публичная сборка не содержит общий OpenRouter-ключ.
const DEFAULT_OPENROUTER_KEY = '';

const DEFAULTS = {
  provider: 'google',
  targetLang: 'ru',
  outboundSourceLang: 'ru',
  outboundTargetLang: 'en',
  geminiKey: '',
  geminiModel: 'gemini-2.0-flash',
  openrouterKey: '',
  openrouterModel: 'google/gemini-2.5-flash',
  deeplKey: '',
  libreUrl: 'https://libretranslate.de',
  libreKey: '',
  myMemoryEmail: ''
};

const SELECTORS = {
  messageItem: [
    'li[id^="chat-messages-"]',
    'li[class*="messageListItem"]',
    'div[id^="chat-messages-"]'
  ],
  textboxEditor: [
    'div[role="textbox"][data-slate-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-slate-node="value"]'
  ]
};

// === CSS — те же стили, что в content.css браузерного расширения ===
const STYLES = `
.dth-container {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.dth-translate-btn {
  align-self: flex-start;
  background: transparent;
  color: var(--text-muted, #b5bac1);
  border: 1px solid var(--background-modifier-accent, #3f4147);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.4;
  transition: background-color 0.1s ease, color 0.1s ease;
}
.dth-translate-btn:hover {
  background: var(--background-modifier-hover, rgba(78, 80, 88, 0.4));
  color: var(--interactive-active, #f2f3f5);
}
.dth-translation {
  padding: 6px 10px;
  border-left: 3px solid var(--brand-experiment, #5865f2);
  background: var(--background-secondary, rgba(0, 0, 0, 0.2));
  border-radius: 0 6px 6px 0;
  color: var(--text-normal, #dbdee1);
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.dth-lang {
  color: var(--text-muted, #949ba4);
  font-size: 11px;
  margin-right: 6px;
}
.dth-input-btn {
  position: fixed;
  z-index: 9999;
  background: var(--brand-experiment, #5865f2);
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translateY(6px) scale(0.96);
  transition: opacity 0.18s ease, transform 0.18s ease, background-color 0.1s ease;
}
.dth-input-btn.dth-visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0) scale(1);
}

/* Settings panel */
.dth-settings {
  padding: 10px;
  display: flex; flex-direction: column; gap: 14px;
  color: var(--text-normal, #dbdee1);
  font-size: 14px;
}
.dth-settings .dth-field {
  display: flex; flex-direction: column; gap: 6px;
}
.dth-settings label.dth-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-weight: 700;
  color: var(--header-secondary, #b5bac1);
}
.dth-settings select, .dth-settings input {
  background: var(--input-background, #1e1f22);
  color: var(--text-normal, #dbdee1);
  border: 1px solid var(--input-background, #1e1f22);
  border-radius: 4px;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.dth-settings select:focus, .dth-settings input:focus {
  border-color: var(--brand-experiment, #5865f2);
}
.dth-settings .dth-group {
  border-left: 3px solid var(--brand-experiment, #5865f2);
  padding-left: 10px;
  display: flex; flex-direction: column; gap: 10px;
}
.dth-settings .dth-pair {
  display: flex; gap: 8px;
}
.dth-settings .dth-pair > .dth-field { flex: 1; }
.dth-settings small {
  color: var(--text-muted, #949ba4);
  font-size: 11px;
}
`;

// === Утилиты ===
function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => r()));
}

function langLabel(code) {
  if (!code) return '';
  const lc = String(code).toLowerCase();
  return LANG_LABELS[lc] || lc.toUpperCase();
}

function sanitizeOpenRouterModel(m) {
  const v = typeof m === 'string' ? m.trim() : '';
  return ALLOWED_OPENROUTER_MODELS.includes(v) ? v : ALLOWED_OPENROUTER_MODELS[0];
}

// HTTP-обёртка. BD предоставляет BdApi.Net.fetch для обхода Discord CSP.
// Если по какой-то причине Net недоступен (старая BD) — пробуем обычный fetch.
async function httpFetch(url, opts) {
  if (typeof BdApi !== 'undefined' && BdApi.Net && typeof BdApi.Net.fetch === 'function') {
    return BdApi.Net.fetch(url, opts);
  }
  return fetch(url, opts);
}

// === Переводчики ===
async function translateGoogle(text, targetLang, sourceLang = 'auto') {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await httpFetch(url);
  if (!res.ok) throw new Error(`Google: HTTP ${res.status}`);
  const data = await res.json();
  const translated = (data[0] || []).map(seg => seg[0]).join('');
  return { translated, detected: data[2] || sourceLang };
}

async function translateMyMemory(text, targetLang, sourceLang, email) {
  const sl = sourceLang === 'auto' ? 'autodetect' : sourceLang;
  const params = new URLSearchParams({ q: text, langpair: `${sl}|${targetLang}` });
  if (email) params.set('de', email);
  const res = await httpFetch(`https://api.mymemory.translated.net/get?${params.toString()}`);
  if (!res.ok) throw new Error(`MyMemory: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.responseData) throw new Error('MyMemory: empty');
  return { translated: data.responseData.translatedText, detected: data.responseData.detectedLanguage || sourceLang };
}

async function translateDeepL(text, targetLang, sourceLang, apiKey) {
  if (!apiKey) throw new Error('DeepL: API key required');
  const isFree = apiKey.endsWith(':fx');
  const host = isFree ? 'api-free.deepl.com' : 'api.deepl.com';
  const body = new URLSearchParams({ text, target_lang: targetLang.toUpperCase() });
  if (sourceLang && sourceLang !== 'auto') body.set('source_lang', sourceLang.toUpperCase());
  const res = await httpFetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`DeepL: HTTP ${res.status}`);
  const data = await res.json();
  const item = data.translations && data.translations[0];
  if (!item) throw new Error('DeepL: empty');
  return { translated: item.text, detected: (item.detected_source_language || sourceLang || '').toLowerCase() };
}

async function translateLibre(text, targetLang, sourceLang, baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/$/, '')}/translate`;
  const payload = { q: text, source: sourceLang || 'auto', target: targetLang, format: 'text' };
  if (apiKey) payload.api_key = apiKey;
  const res = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`LibreTranslate: HTTP ${res.status}`);
  const data = await res.json();
  return { translated: data.translatedText, detected: (data.detectedLanguage && data.detectedLanguage.language) || sourceLang || 'auto' };
}

async function translateGemini(text, targetLang, sourceLang, apiKey, model) {
  if (!apiKey) throw new Error('Gemini: API key required');
  const m = (model && model.trim()) || 'gemini-2.0-flash';
  const targetName = LANG_NAMES[targetLang.toLowerCase()] || targetLang;
  const srcName = sourceLang && sourceLang !== 'auto'
    ? (LANG_NAMES[sourceLang.toLowerCase()] || sourceLang)
    : null;
  const direction = srcName
    ? `Translate from ${srcName} to ${targetName}.`
    : `Translate the text to ${targetName} (auto-detect the source language).`;
  const sys = [
    'You translate Discord chat messages.',
    direction,
    'Output ONLY the translation. No explanations, no quotes around the result.',
    'Preserve emojis, @mentions, #channels, URLs, code blocks unchanged.',
    `If the text is already in ${targetName}, output it unchanged.`
  ].join(' ');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
  });
  let res;
  for (let i = 0; i < 3; i++) {
    res = await httpFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.status !== 429) break;
    if (i === 2) break;
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('Gemini: rate limit exceeded, try gemini-2.0-flash-lite');
    throw new Error(`Gemini: HTTP ${res.status} ${errBody.slice(0, 200)}`);
  }
  const data = await res.json();
  const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!translated) throw new Error('Gemini: empty response');
  return { translated, detected: sourceLang || 'auto' };
}

async function translateOpenRouter(text, targetLang, sourceLang, apiKey, model) {
  const key = (apiKey && apiKey.trim()) || DEFAULT_OPENROUTER_KEY;
  if (!key) throw new Error('OpenRouter: add an API key in settings');
  const m = sanitizeOpenRouterModel(model);
  const targetName = LANG_NAMES[targetLang.toLowerCase()] || targetLang;
  const srcName = sourceLang && sourceLang !== 'auto'
    ? (LANG_NAMES[sourceLang.toLowerCase()] || sourceLang)
    : null;
  const direction = srcName
    ? `Translate from ${srcName} to ${targetName}.`
    : `Translate the text to ${targetName} (auto-detect the source language).`;
  const sys = [
    'You translate Discord chat messages.',
    direction,
    'Output ONLY the translation. No explanations, no quotes around the result.',
    'Preserve emojis, @mentions, #channels, URLs, code blocks unchanged.',
    `If the text is already in ${targetName}, output it unchanged.`
  ].join(' ');
  const body = JSON.stringify({
    model: m,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: text }
    ],
    temperature: 0.2,
    max_tokens: 2048
  });
  let res;
  for (let i = 0; i < 3; i++) {
    res = await httpFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://discord.com',
        'X-Title': 'Discord Translate Helper'
      },
      body
    });
    if (res.status !== 429) break;
    if (i === 2) break;
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('OpenRouter: rate limit, wait a minute');
    if (res.status === 401) throw new Error('OpenRouter: invalid API key');
    if (res.status === 402) throw new Error('OpenRouter: out of credits, top up at openrouter.ai/credits');
    throw new Error(`OpenRouter: HTTP ${res.status} ${errBody.slice(0, 200)}`);
  }
  const data = await res.json();
  const translated = data?.choices?.[0]?.message?.content?.trim();
  if (!translated) throw new Error('OpenRouter: empty response');
  return { translated, detected: sourceLang || 'auto' };
}

async function translate(settings, { text, targetLang, sourceLang = 'auto' }) {
  if (!text || !text.trim()) return { translated: '', detected: sourceLang };
  switch (settings.provider) {
    case 'google':     return translateGoogle(text, targetLang, sourceLang);
    case 'gemini':     return translateGemini(text, targetLang, sourceLang, settings.geminiKey, settings.geminiModel);
    case 'openrouter': return translateOpenRouter(text, targetLang, sourceLang, settings.openrouterKey, settings.openrouterModel);
    case 'mymemory':   return translateMyMemory(text, targetLang, sourceLang, settings.myMemoryEmail);
    case 'deepl':      return translateDeepL(text, targetLang, sourceLang, settings.deeplKey);
    case 'libre':      return translateLibre(text, targetLang, sourceLang, settings.libreUrl, settings.libreKey);
    default:           return translateGoogle(text, targetLang, sourceLang);
  }
}

// === DOM helpers ===
function qOne(el, list) {
  for (const s of list) { const f = el.querySelector(s); if (f) return f; }
  return null;
}
function qAll(el, list) {
  for (const s of list) {
    const f = el.querySelectorAll(s);
    if (f && f.length) return Array.from(f);
  }
  return [];
}
function findOwnContent(messageItemEl) {
  const liId = messageItemEl.id || '';
  const snowflake = liId.replace(/^chat-messages-/, '').replace(/^.*?-/, '');
  if (snowflake) {
    const direct = messageItemEl.querySelector(`#message-content-${CSS_escape(snowflake)}`);
    if (direct) return direct;
  }
  const candidates = messageItemEl.querySelectorAll('div[id^="message-content-"], [class*="messageContent"]');
  for (const c of candidates) {
    if (c.closest('[class*="repliedMessage"]')) continue;
    if (c.closest('[class*="replyContext"]')) continue;
    if (c.closest('[id^="message-reply-context-"]')) continue;
    return c;
  }
  return null;
}
function CSS_escape(s) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function findEditor() {
  for (const sel of SELECTORS.textboxEditor) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

async function replaceEditorText(editor, newText) {
  editor.focus();
  await nextFrame();
  let selected = false;
  try { selected = document.execCommand('selectAll', false); } catch { selected = false; }
  if (!selected || window.getSelection().toString().length === 0) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }
  await nextFrame();
  await nextFrame();
  const dt = new DataTransfer();
  dt.setData('text/plain', newText);
  editor.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true
  }));
}

// === Главный класс плагина ===
module.exports = class DiscordTranslateHelper {
  constructor() {
    this.settings = this._loadSettings();
    this.observer = null;
    this.inputBtnEl = null;
    this._onResize = () => this._positionInputButton();
    this._onScroll = () => this._positionInputButton();
    this._onInput = (e) => {
      const t = e.target;
      if (t && t.matches && t.matches(SELECTORS.textboxEditor.join(','))) {
        this._positionInputButton();
      }
    };
  }

  _loadSettings() {
    const stored = BdApi.Data.load(PLUGIN_NAME, 'config') || {};
    return Object.assign({}, DEFAULTS, stored);
  }

  _saveSettings() {
    BdApi.Data.save(PLUGIN_NAME, 'config', this.settings);
  }

  // ---- UI: кнопка под сообщением ----
  _ensureTranslateButton(messageItemEl) {
    if (messageItemEl.querySelector('.dth-container')) return;
    const contentEl = findOwnContent(messageItemEl);
    if (!contentEl) return;
    const text = (contentEl.textContent || '').trim();
    if (!text) return;

    const btn = document.createElement('button');
    btn.className = 'dth-translate-btn';
    btn.type = 'button';
    btn.textContent = '🌐 Translate';
    btn.title = 'Translate this message';

    const resultBox = document.createElement('div');
    resultBox.className = 'dth-translation';
    resultBox.style.display = 'none';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.dataset.loading === '1') return;
      if (resultBox.style.display === 'block') {
        resultBox.style.display = 'none';
        btn.textContent = '🌐 Translate';
        return;
      }
      btn.dataset.loading = '1';
      btn.textContent = '⏳ Translating…';
      try {
        const currentText = (contentEl.textContent || '').trim();
        const { translated, detected } = await translate(this.settings, {
          text: currentText,
          targetLang: this.settings.targetLang
        });
        resultBox.innerHTML = '';
        const langTag = document.createElement('span');
        langTag.className = 'dth-lang';
        langTag.textContent = `(${detected || '??'} → ${this.settings.targetLang || 'ru'})`;
        const textNode = document.createElement('span');
        textNode.textContent = translated;
        resultBox.appendChild(langTag);
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(textNode);
        resultBox.style.display = 'block';
        btn.textContent = '🌐 Hide';
      } catch (err) {
        resultBox.textContent = 'Error: ' + err.message;
        resultBox.style.display = 'block';
        btn.textContent = '🌐 Retry';
      } finally {
        btn.dataset.loading = '0';
      }
    });

    const container = document.createElement('div');
    container.className = 'dth-container';
    container.appendChild(btn);
    container.appendChild(resultBox);
    contentEl.insertAdjacentElement('afterend', container);
  }

  _scanMessages(root = document) {
    const items = qAll(root, SELECTORS.messageItem);
    items.forEach(item => this._ensureTranslateButton(item));
  }

  // ---- UI: кнопка возле инпута ----
  _getOutboundTargetCode() {
    return langLabel(this.settings.outboundTargetLang || 'en');
  }

  _positionInputButton() {
    if (!this.inputBtnEl) return;
    const editor = findEditor();
    const hasText = editor && (editor.textContent || '').trim().length > 0;
    this.inputBtnEl.classList.toggle('dth-visible', !!hasText);
    if (!editor) return;
    const rect = editor.getBoundingClientRect();
    this.inputBtnEl.style.left = 'auto';
    this.inputBtnEl.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    this.inputBtnEl.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + 'px';
    this.inputBtnEl.style.top = 'auto';
  }

  _refreshInputButtonLabel() {
    if (!this.inputBtnEl) return;
    if (this.inputBtnEl.dataset.loading !== '1') {
      this.inputBtnEl.textContent = `🌐→${this._getOutboundTargetCode()}`;
    }
  }

  _ensureInputButton() {
    if (!this.inputBtnEl) {
      const btn = document.createElement('button');
      btn.className = 'dth-input-btn';
      btn.type = 'button';
      btn.title = 'Translate what I typed and paste it back';
      btn.textContent = `🌐→${this._getOutboundTargetCode()}`;

      // Не отбирать фокус у редактора при клике
      btn.addEventListener('mousedown', (e) => e.preventDefault());

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ed = findEditor();
        if (!ed) return;
        const text = (ed.textContent || '').trim();
        if (!text) return;
        btn.disabled = true;
        btn.dataset.loading = '1';
        btn.textContent = '⏳';
        try {
          const { translated } = await translate(this.settings, {
            text,
            targetLang: this.settings.outboundTargetLang || 'en',
            sourceLang: this.settings.outboundSourceLang || 'auto'
          });
          await replaceEditorText(ed, translated);
        } catch (err) {
          console.error('[DTH] translate input error:', err);
          btn.title = 'Error: ' + err.message;
        } finally {
          btn.disabled = false;
          btn.dataset.loading = '0';
          this._refreshInputButtonLabel();
        }
      });

      document.body.appendChild(btn);
      this.inputBtnEl = btn;
      window.addEventListener('resize', this._onResize);
      window.addEventListener('scroll', this._onScroll, true);
      document.addEventListener('input', this._onInput, true);
      document.addEventListener('keyup', this._onInput, true);
    }
    this._positionInputButton();
  }

  // ---- Lifecycle ----
  start() {
    BdApi.DOM.addStyle(STYLE_ID, STYLES);
    this.observer = new MutationObserver(() => {
      this._scanMessages();
      this._ensureInputButton();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this._scanMessages();
    this._ensureInputButton();
    console.log('[DTH] plugin started');
  }

  stop() {
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    BdApi.DOM.removeStyle(STYLE_ID);
    document.querySelectorAll('.dth-container').forEach(el => el.remove());
    if (this.inputBtnEl) {
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('scroll', this._onScroll, true);
      document.removeEventListener('input', this._onInput, true);
      document.removeEventListener('keyup', this._onInput, true);
      this.inputBtnEl.remove();
      this.inputBtnEl = null;
    }
    console.log('[DTH] plugin stopped');
  }

  // ---- Settings panel ----
  getSettingsPanel() {
    const s = this.settings;
    const panel = document.createElement('div');
    panel.className = 'dth-settings';

    const langOpts = (withAuto) => {
      const opts = [];
      if (withAuto) opts.push(`<option value="auto">Auto</option>`);
      for (const code of ALL_LANGS) {
        const display = LANG_LABELS[code] || code.toUpperCase();
        const name = LANG_NAMES[code] || code;
        opts.push(`<option value="${code}">${name} (${display})</option>`);
      }
      return opts.join('');
    };

    panel.innerHTML = `
      <div class="dth-field">
        <label class="dth-label">Translation provider</label>
        <select name="provider">
          <option value="google">Google Translate (free)</option>
          <option value="gemini">Google Gemini AI</option>
          <option value="openrouter">OpenRouter (default key built-in)</option>
          <option value="mymemory">MyMemory</option>
          <option value="deepl">DeepL</option>
          <option value="libre">LibreTranslate</option>
        </select>
      </div>

      <div class="dth-group" data-show="gemini" hidden>
        <div class="dth-field">
          <label class="dth-label">Gemini API key</label>
          <input type="password" name="geminiKey" placeholder="AIza...">
        </div>
        <div class="dth-field">
          <label class="dth-label">Gemini model</label>
          <input type="text" name="geminiModel" placeholder="gemini-2.0-flash">
        </div>
      </div>

      <div class="dth-group" data-show="openrouter" hidden>
        <div class="dth-field">
          <label class="dth-label">OpenRouter API key</label>
          <input type="text" name="openrouterKey" placeholder="default" autocomplete="off">
          <small>Create a key at openrouter.ai and paste it here.</small>
        </div>
        <div class="dth-field">
          <label class="dth-label">Model</label>
          <select name="openrouterModel">
            <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
            <option value="google/gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
          </select>
        </div>
      </div>

      <div class="dth-group" data-show="deepl" hidden>
        <div class="dth-field">
          <label class="dth-label">DeepL API key</label>
          <input type="password" name="deeplKey" placeholder="xxxx-xxxx-...">
        </div>
      </div>

      <div class="dth-group" data-show="libre" hidden>
        <div class="dth-field">
          <label class="dth-label">LibreTranslate URL</label>
          <input type="url" name="libreUrl" placeholder="https://libretranslate.de">
        </div>
        <div class="dth-field">
          <label class="dth-label">LibreTranslate API key (optional)</label>
          <input type="password" name="libreKey">
        </div>
      </div>

      <div class="dth-group" data-show="mymemory" hidden>
        <div class="dth-field">
          <label class="dth-label">Email (raises daily limit)</label>
          <input type="email" name="myMemoryEmail" placeholder="you@example.com">
        </div>
      </div>

      <div class="dth-field">
        <label class="dth-label">Translate incoming messages to</label>
        <select name="targetLang">${langOpts(false)}</select>
      </div>

      <div class="dth-pair">
        <div class="dth-field">
          <label class="dth-label">My messages — from</label>
          <select name="outboundSourceLang">${langOpts(true)}</select>
        </div>
        <div class="dth-field">
          <label class="dth-label">My messages — to</label>
          <select name="outboundTargetLang">${langOpts(false)}</select>
        </div>
      </div>
    `;

    // Заполняем значения и навешиваем onChange.
    const showProviderGroup = (provider) => {
      panel.querySelectorAll('.dth-group[data-show]').forEach(g => {
        g.hidden = g.dataset.show !== provider;
      });
    };

    for (const el of panel.querySelectorAll('[name]')) {
      const key = el.getAttribute('name');
      if (s[key] !== undefined && s[key] !== null) el.value = s[key];
      el.addEventListener('change', (e) => {
        this.settings[key] = e.target.value;
        this._saveSettings();
        if (key === 'provider') showProviderGroup(e.target.value);
      });
      el.addEventListener('input', (e) => {
        this.settings[key] = e.target.value;
        this._saveSettings();
      });
    }
    showProviderGroup(s.provider);
    return panel;
  }
};
