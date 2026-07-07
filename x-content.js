// X (Twitter) content script.
// Добавляет плавающую кнопку перевода у поля написания поста/комментария.
// При клике переводит набранный текст на язык из настроек.
// Стрелка справа открывает выпадашку для быстрой смены целевого языка.

console.log('[DTH X] content script loaded on', location.href);

// X использует Draft.js (не Slate, как Discord), но contenteditable и paste-event работают так же.
const COMPOSE_SELECTORS = [
  'div[data-testid^="tweetTextarea_"][contenteditable="true"]',
  // Запасные варианты на случай редизайна:
  'div[role="textbox"][contenteditable="true"][data-testid*="tweetTextarea"]',
  'div[contenteditable="true"][data-block-editor-block-type="text"]'
];

const LANG_LABELS = { uk: 'UA', be: 'BY', kk: 'KZ', ja: 'JP', zh: 'CN' };

// Названия дублируются здесь, чтобы не тянуть chrome.runtime.getURL — попап
// шлёт нам i18n через сообщения, а нативные имена для дропдауна стабильны.
const LANG_NAMES = {
  ru: 'Русский', en: 'English', uk: 'Українська', kk: 'Қазақша',
  be: 'Беларуская', de: 'Deutsch', fr: 'Français', es: 'Español',
  pt: 'Português', tr: 'Türkçe', ja: '日本語', zh: '中文',
  ar: 'العربية', pl: 'Polski'
};

const STATE = {
  settings: null,
  activeCompose: null,
  customPosition: null
};

const POSITION_KEY = `dthButtonPosition:${location.hostname}`;

let overrideMessages = null;

// --- i18n ---

async function ensureOverrideLocale(uiLang) {
  if (!uiLang || uiLang === 'auto') {
    overrideMessages = null;
    return;
  }
  try {
    const url = chrome.runtime.getURL(`_locales/${uiLang}/messages.json`);
    const res = await fetch(url);
    overrideMessages = await res.json();
  } catch {
    overrideMessages = null;
  }
}

function t(key) {
  if (overrideMessages && overrideMessages[key] && overrideMessages[key].message) {
    return overrideMessages[key].message;
  }
  try { return chrome.i18n.getMessage(key) || key; }
  catch { return key; }
}

// --- Bridge to background ---

function callBackground(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp || !resp.ok) {
        reject(new Error((resp && resp.error) || 'No response from background'));
        return;
      }
      resolve(resp);
    });
  });
}

async function loadSettings() {
  try {
    STATE.settings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getSettings' }, (s) => resolve(s || {}));
    });
    const savedPosition = await chrome.storage.local.get(POSITION_KEY);
    STATE.customPosition = savedPosition[POSITION_KEY] || null;
    await ensureOverrideLocale(STATE.settings.uiLang);
  } catch {
    STATE.settings = {};
  }
}

function langLabel(code) {
  if (!code) return '';
  const lc = String(code).toLowerCase();
  return LANG_LABELS[lc] || lc.toUpperCase();
}

// --- Compose detection ---

function findActiveCompose() {
  // Если сейчас в фокусе подходящий contenteditable — берём его.
  const ae = document.activeElement;
  if (ae && ae.matches) {
    for (const sel of COMPOSE_SELECTORS) {
      if (ae.matches(sel)) return ae;
    }
  }
  // Иначе возвращаем последний известный (если он ещё в DOM).
  if (STATE.activeCompose && document.body.contains(STATE.activeCompose)) {
    return STATE.activeCompose;
  }
  // На крайний случай — первый видимый composer на странице.
  for (const sel of COMPOSE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function composeHasText(el) {
  if (!el) return false;
  return (el.textContent || '').trim().length > 0;
}

// --- Slate/Draft text replacement (same approach as Discord) ---

function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => r()));
}

async function replaceComposeText(el, newText) {
  el.focus();
  await nextFrame();

  let selected = false;
  try { selected = document.execCommand('selectAll', false); } catch { selected = false; }
  if (!selected || window.getSelection().toString().length === 0) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }
  await nextFrame();
  await nextFrame();

  const dt = new DataTransfer();
  dt.setData('text/plain', newText);
  el.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true
  }));
}

// --- Floating button UI ---

let inputWrap = null;
let inputMainBtn = null;
let langDropdown = null;

function updateDropdownDirection() {
  if (!inputWrap || !langDropdown) return;
  requestAnimationFrame(() => {
    const rect = inputWrap.getBoundingClientRect();
    const needed = Math.min(langDropdown.scrollHeight || 280, 280) + 12;
    const below = window.innerHeight - rect.bottom;
    inputWrap.classList.toggle('dth-drop-up', below < needed && rect.top > below);
  });
}

function setupDrag(handle) {
  let drag = null;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const rect = inputWrap.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    handle.setPointerCapture(e.pointerId);
    inputWrap.classList.add('dth-dragging');
  });
  handle.addEventListener('pointermove', e => {
    if (!drag) return;
    const x = Math.max(6, Math.min(window.innerWidth - inputWrap.offsetWidth - 6, e.clientX - drag.dx));
    const y = Math.max(6, Math.min(window.innerHeight - inputWrap.offsetHeight - 6, e.clientY - drag.dy));
    STATE.customPosition = { x, y };
    Object.assign(inputWrap.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    updateDropdownDirection();
  });
  const finish = e => {
    if (!drag) return;
    drag = null;
    inputWrap.classList.remove('dth-dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch { }
    chrome.storage.local.set({ [POSITION_KEY]: STATE.customPosition });
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('dblclick', e => {
    e.preventDefault();
    STATE.customPosition = null;
    chrome.storage.local.remove(POSITION_KEY);
    positionButton();
  });
}

function positionButton() {
  if (!inputWrap) return;
  if (STATE.settings && STATE.settings.translationEnabled === false) {
    inputWrap.classList.remove('dth-visible');
    if (langDropdown) langDropdown.classList.remove('dth-open');
    return;
  }
  const el = findActiveCompose();
  const hasText = !!el && composeHasText(el);
  inputWrap.classList.toggle('dth-visible', hasText);
  if (!el) return;
  STATE.activeCompose = el;
  const rect = el.getBoundingClientRect();
  const btnH = inputWrap.offsetHeight || 30;
  if (STATE.customPosition) {
    const x = Math.max(6, Math.min(window.innerWidth - inputWrap.offsetWidth - 6, STATE.customPosition.x));
    const y = Math.max(6, Math.min(window.innerHeight - btnH - 6, STATE.customPosition.y));
    Object.assign(inputWrap.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    updateDropdownDirection();
    return;
  }
  const send = el.closest('form')?.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], button[type="submit"]');
  const anchor = send && send.getBoundingClientRect().width ? send.getBoundingClientRect() : rect;
  const btnW = inputWrap.offsetWidth || 92;
  inputWrap.style.left = `${Math.max(6, Math.min(window.innerWidth - btnW - 6, anchor.right - btnW))}px`;
  inputWrap.style.right = 'auto';
  inputWrap.style.top = `${Math.max(6, anchor.top - btnH - 7)}px`;
  inputWrap.style.bottom = 'auto';
  updateDropdownDirection();
}

function refreshButtonLabel() {
  if (!inputMainBtn) return;
  if (inputMainBtn.dataset.loading !== '1') {
    const code = langLabel((STATE.settings && STATE.settings.outboundTargetLang) || 'en');
    inputMainBtn.textContent = `🌐→${code}`;
  }
}

async function runTranslate(overrideTargetLang) {
  const el = findActiveCompose();
  if (!el || !inputMainBtn) return;
  const text = (el.textContent || '').trim();
  if (!text) return;
  inputMainBtn.disabled = true;
  inputMainBtn.dataset.loading = '1';
  inputMainBtn.textContent = '⏳';
  try {
    const s = STATE.settings || {};
    const targetLang = overrideTargetLang || s.outboundTargetLang || 'en';
    let sourceLang = s.outboundSourceLang || 'auto';
    if (sourceLang.toLowerCase() === targetLang.toLowerCase()) {
      sourceLang = 'auto';
    }
    const { translated } = await callBackground({
      type: 'translate',
      text,
      targetLang,
      sourceLang
    });
    await replaceComposeText(el, translated);
  } catch (e) {
    console.error('[DTH X] translate error:', e);
    inputMainBtn.title = (t('errorPrefix') || 'Error: ') + e.message;
  } finally {
    inputMainBtn.disabled = false;
    inputMainBtn.dataset.loading = '0';
    refreshButtonLabel();
  }
}

function populateDropdown() {
  if (!langDropdown) return;
  langDropdown.innerHTML = '';
  for (const code of Object.keys(LANG_NAMES)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dth-lang-item';

    const codeEl = document.createElement('span');
    codeEl.className = 'dth-lang-code';
    codeEl.textContent = LANG_LABELS[code] || code.toUpperCase();

    const nameEl = document.createElement('span');
    nameEl.className = 'dth-lang-name';
    nameEl.textContent = LANG_NAMES[code];

    item.appendChild(codeEl);
    item.appendChild(nameEl);

    item.addEventListener('mousedown', e => e.preventDefault());
    item.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      langDropdown.classList.remove('dth-open');
      // Сохраняем выбранный язык в общие настройки + переводим сразу.
      if (STATE.settings) STATE.settings.outboundTargetLang = code;
      chrome.storage.sync.set({ outboundTargetLang: code });
      refreshButtonLabel();
      await runTranslate(code);
    });
    langDropdown.appendChild(item);
  }
}

function setupButton() {
  if (inputWrap) return;

  const wrap = document.createElement('div');
  wrap.className = 'dth-input-wrap';

  const mainBtn = document.createElement('button');
  mainBtn.className = 'dth-input-btn';
  mainBtn.type = 'button';
  mainBtn.title = t('translateInputTitle') || 'Translate what I typed';
  mainBtn.textContent = `🌐→${langLabel((STATE.settings && STATE.settings.outboundTargetLang) || 'en')}`;
  mainBtn.addEventListener('mousedown', e => e.preventDefault());
  mainBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await runTranslate();
  });

  const arrowBtn = document.createElement('button');
  arrowBtn.className = 'dth-input-arrow';
  arrowBtn.type = 'button';
  arrowBtn.title = 'Choose language';
  arrowBtn.textContent = '▾';
  arrowBtn.addEventListener('mousedown', e => e.preventDefault());
  arrowBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    langDropdown.classList.toggle('dth-open');
    updateDropdownDirection();
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'dth-lang-dropdown';

  const dragHandle = document.createElement('button');
  dragHandle.type = 'button';
  dragHandle.className = 'dth-input-drag';
  dragHandle.textContent = '⋮⋮';
  dragHandle.title = 'Drag to move; double-click to reset';

  wrap.appendChild(dragHandle);
  wrap.appendChild(mainBtn);
  wrap.appendChild(arrowBtn);
  wrap.appendChild(dropdown);
  document.body.appendChild(wrap);

  inputWrap = wrap;
  inputMainBtn = mainBtn;
  langDropdown = dropdown;

  populateDropdown();
  setupDrag(dragHandle);

  window.addEventListener('resize', positionButton);
  window.addEventListener('scroll', positionButton, true);
  document.addEventListener('input', (e) => {
    const tgt = e.target;
    if (tgt && tgt.matches && tgt.matches(COMPOSE_SELECTORS.join(','))) {
      STATE.activeCompose = tgt;
      positionButton();
    }
  }, true);
  document.addEventListener('focusin', (e) => {
    const tgt = e.target;
    if (tgt && tgt.matches && tgt.matches(COMPOSE_SELECTORS.join(','))) {
      STATE.activeCompose = tgt;
      positionButton();
    }
  }, true);
  document.addEventListener('click', (e) => {
    if (langDropdown.classList.contains('dth-open') &&
        !inputWrap.contains(e.target)) {
      langDropdown.classList.remove('dth-open');
    }
  }, true);

  positionButton();
}

// --- React to settings changes ---

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const uiLangChanged = changes.uiLang !== undefined;
  loadSettings().then(() => {
    if (uiLangChanged) populateDropdown();
    refreshButtonLabel();
    if (inputMainBtn) inputMainBtn.title = t('translateInputTitle') || 'Translate what I typed';
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'localeChanged') {
    overrideMessages = msg.messages || null;
    populateDropdown();
    refreshButtonLabel();
    if (inputMainBtn) inputMainBtn.title = t('translateInputTitle') || 'Translate what I typed';
  }
});

// --- Init ---

loadSettings().then(setupButton);

// X — SPA, перерисовывает много, следим за DOM и обновляем позицию.
const observer = new MutationObserver(() => positionButton());
observer.observe(document.body, { childList: true, subtree: true });
