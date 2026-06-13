// Universal content script — works on ALL sites except Discord & X (which have dedicated scripts).
// Detects any focused <input>, <textarea>, or contenteditable and shows
// the floating translate button + language dropdown when the user types text.

console.log('[DTH Universal] content script loaded on', location.href);

// --- Selectors: match ANY text input on the page ---
const INPUT_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'input[type="search"]',
  'input:not([type])',           // default type is text
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]'
];
const INPUT_SELECTOR_STRING = INPUT_SELECTORS.join(',');

const LANG_LABELS = { uk: 'UA', be: 'BY', kk: 'KZ', ja: 'JP', zh: 'CN' };

const LANG_NAMES = {
  ru: 'Русский', en: 'English', uk: 'Українська', kk: 'Қазақша',
  be: 'Беларуская', de: 'Deutsch', fr: 'Français', es: 'Español',
  pt: 'Português', tr: 'Türkçe', ja: '日本語', zh: '中文',
  ar: 'العربية', pl: 'Polski'
};

const STATE = {
  settings: null,
  activeInput: null    // the element user is currently typing into
};

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

// --- Input detection ---

function isTextInput(el) {
  if (!el || !el.matches) return false;
  return el.matches(INPUT_SELECTOR_STRING);
}

function findActiveInput() {
  // Prefer the currently focused element if it's a text input.
  const ae = document.activeElement;
  if (ae && isTextInput(ae)) return ae;

  // Walk shadow-DOMs? Some sites (YouTube) put their inputs in shadow.
  // For now fall back to the cached element if it's still in the DOM.
  if (STATE.activeInput && document.body.contains(STATE.activeInput)) {
    return STATE.activeInput;
  }
  return null;
}

function getInputText(el) {
  if (!el) return '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    return (el.value || '').trim();
  }
  // contenteditable / role=textbox
  return (el.textContent || '').trim();
}

function inputHasText(el) {
  return getInputText(el).length > 0;
}

// --- Text replacement ---

function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => r()));
}

async function replaceInputText(el, newText) {
  if (!el) return;

  // Standard input / textarea — easy: set .value + dispatch input event.
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    // Use native setter to trigger React-managed inputs (e.g. YouTube search).
    const nativeSet = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;
    if (nativeSet) {
      nativeSet.call(el, newText);
    } else {
      el.value = newText;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // Contenteditable — same paste approach as Discord/X scripts.
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

function positionButton() {
  if (!inputWrap) return;
  const el = findActiveInput();
  // Показываем кнопку только пока поле (или сама кнопка) в фокусе — иначе
  // MutationObserver "воскрешает" её после blur, пока в поле остаётся текст.
  const focused = !!el && (document.activeElement === el ||
    inputWrap.contains(document.activeElement));
  const hasText = !!el && inputHasText(el);
  inputWrap.classList.toggle('dth-visible', hasText && focused);
  if (!el) return;
  STATE.activeInput = el;
  const rect = el.getBoundingClientRect();
  const btnH = inputWrap.offsetHeight || 30;

  // Inside the field, right edge with a small inset.
  inputWrap.style.left = 'auto';
  inputWrap.style.right = Math.max(8, window.innerWidth - rect.right + 8) + 'px';

  // Vertically centered within the input.
  const topPos = Math.max(4, rect.top + (rect.height - btnH) / 2);
  inputWrap.style.top = topPos + 'px';
  inputWrap.style.bottom = 'auto';
}

function refreshButtonLabel() {
  if (!inputMainBtn) return;
  if (inputMainBtn.dataset.loading !== '1') {
    const code = langLabel((STATE.settings && STATE.settings.outboundTargetLang) || 'en');
    inputMainBtn.textContent = `🌐→${code}`;
  }
}

async function runTranslate(overrideTargetLang) {
  const el = findActiveInput();
  if (!el || !inputMainBtn) return;
  const text = getInputText(el);
  if (!text) return;
  inputMainBtn.disabled = true;
  inputMainBtn.dataset.loading = '1';
  inputMainBtn.textContent = '⏳';
  try {
    const s = STATE.settings || {};
    const targetLang = overrideTargetLang || s.outboundTargetLang || 'en';
    // Always auto-detect: after a translation the text in the field is already
    // in a different language, so the static outboundSourceLang would be wrong.
    const sourceLang = 'auto';
    const { translated } = await callBackground({
      type: 'translate',
      text,
      targetLang,
      sourceLang
    });
    await replaceInputText(el, translated);
  } catch (e) {
    console.error('[DTH Universal] translate error:', e);
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
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'dth-lang-dropdown';

  wrap.appendChild(mainBtn);
  wrap.appendChild(arrowBtn);
  wrap.appendChild(dropdown);
  document.body.appendChild(wrap);

  inputWrap = wrap;
  inputMainBtn = mainBtn;
  langDropdown = dropdown;

  populateDropdown();

  // --- Event listeners ---

  // Reposition on resize / scroll.
  window.addEventListener('resize', positionButton);
  window.addEventListener('scroll', positionButton, true);

  // Track input events on any text field.
  document.addEventListener('input', (e) => {
    const tgt = e.target;
    if (tgt && isTextInput(tgt)) {
      STATE.activeInput = tgt;
      positionButton();
    }
  }, true);

  // Track focus — when user clicks into an input, start tracking it.
  document.addEventListener('focusin', (e) => {
    const tgt = e.target;
    if (tgt && isTextInput(tgt)) {
      STATE.activeInput = tgt;
      positionButton();
    }
  }, true);

  // Track keyup for good measure (some inputs don't fire 'input' events).
  document.addEventListener('keyup', (e) => {
    const tgt = e.target;
    if (tgt && isTextInput(tgt)) {
      STATE.activeInput = tgt;
      positionButton();
    }
  }, true);

  // Hide when focus leaves a text input.
  document.addEventListener('focusout', (e) => {
    // Small delay to allow clicking the translate button itself.
    setTimeout(() => {
      const ae = document.activeElement;
      if (!ae || !isTextInput(ae)) {
        // Don't hide if our button wrapper has focus.
        if (inputWrap && inputWrap.contains(document.activeElement)) return;
        inputWrap.classList.remove('dth-visible');
      }
    }, 150);
  }, true);

  // Close dropdown when clicking outside.
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'localeChanged') {
    overrideMessages = msg.messages || null;
    populateDropdown();
    refreshButtonLabel();
    if (inputMainBtn) inputMainBtn.title = t('translateInputTitle') || 'Translate what I typed';
  }
});

// --- Init ---

loadSettings().then(setupButton);

// Many modern sites are SPAs — observe DOM changes and update position.
// Троттлим через rAF: на тяжёлых страницах мутации идут пачками, а
// positionButton() читает layout (getBoundingClientRect).
let positionQueued = false;
const observer = new MutationObserver(() => {
  if (positionQueued) return;
  positionQueued = true;
  requestAnimationFrame(() => {
    positionQueued = false;
    positionButton();
  });
});
observer.observe(document.body, { childList: true, subtree: true });
