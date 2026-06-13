// Контент-скрипт. Внедряется в discord.com.
// Задачи:
//   1) Для каждого сообщения добавляет кнопку "Перевести" → показывает перевод под текстом.
//   2) Добавляет кнопку рядом с инпутом: переводит то, что ты пишешь, и вставляет обратно.
//
// Discord использует Slate.js для инпута и хешированные классы для DOM, так что мы цепляемся
// к стабильным селекторам по id-префиксам и role-атрибутам.

const STATE = {
  enabled: true,
  settings: null
};

// Несколько селекторов с фолбэками — Discord часто переименовывает классы.
const SELECTORS = {
  messageItem: [
    'li[id^="chat-messages-"]',
    'li[class*="messageListItem"]',
    'div[id^="chat-messages-"]'
  ],
  messageContent: [
    'div[id^="message-content-"]',
    '[class*="messageContent"]'
  ],
  textboxEditor: [
    'div[role="textbox"][data-slate-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-slate-node="value"]'
  ]
};

function qOne(el, list) {
  for (const sel of list) {
    const found = el.querySelector(sel);
    if (found) return found;
  }
  return null;
}

function qAll(el, list) {
  for (const sel of list) {
    const found = el.querySelectorAll(sel);
    if (found && found.length) return Array.from(found);
  }
  return [];
}

// Ищем именно контент текущего сообщения, а не превью реплая.
function findOwnContent(messageItemEl) {
  // Сначала пробуем по id — он совпадает с id у li (msg snowflake),
  // в превью реплая ID другого формата (или его нет).
  const liId = messageItemEl.id || '';
  const snowflake = liId.replace(/^chat-messages-/, '').replace(/^.*?-/, '');
  if (snowflake) {
    const direct = messageItemEl.querySelector(`#message-content-${CSS.escape(snowflake)}`);
    if (direct) return direct;
  }
  // Универсально: первый message-content-* НЕ внутри repliedMessage / replyContent / replyContext.
  const candidates = messageItemEl.querySelectorAll('div[id^="message-content-"], [class*="messageContent"]');
  for (const c of candidates) {
    if (c.closest('[class*="repliedMessage"]')) continue;
    if (c.closest('[class*="replyContext"]')) continue;
    if (c.closest('[id^="message-reply-context-"]')) continue;
    return c;
  }
  return null;
}

console.log('[DTH] content script loaded on', location.href);

// --- i18n с возможностью переопределить язык интерфейса ---
let overrideMessages = null;

async function ensureOverrideLocale(uiLang) {
  if (!uiLang || uiLang === 'auto') {
    overrideMessages = null;
    return;
  }
  try {
    const url = chrome.runtime.getURL(`_locales/${uiLang}/messages.json`);
    const res = await fetch(url);
    overrideMessages = await res.json();
  } catch (e) {
    console.warn('[DTH] не удалось загрузить локаль', uiLang, e);
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

// --- Утилиты ---

function callBackground(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp || !resp.ok) {
        reject(new Error((resp && resp.error) || 'Нет ответа от фонового скрипта'));
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
    STATE.enabled = STATE.settings.enabled !== false;
    await ensureOverrideLocale(STATE.settings.uiLang);
  } catch (e) {
    STATE.settings = {};
    overrideMessages = null;
  }
}

// Снести инжектнутые кнопки, чтобы scanMessages пересоздал их с актуальными переводами.
function clearInjectedUI() {
  document.querySelectorAll('.dth-container').forEach(el => el.remove());
}

function refreshAllLabels() {
  if (inputBtnEl) {
    inputBtnEl.title = t('translateInputTitle');
    refreshInputButtonLabel();
  }
  clearInjectedUI();
  scanMessages();
}

// --- Перевод входящих сообщений ---

function extractMessageText(messageContentEl) {
  // Берём весь видимый текст; emoji и упоминания заменим на их alt/text, чтобы не ломать смысл.
  // Простейший вариант: textContent. Этого достаточно для MVP.
  return messageContentEl.textContent.trim();
}

function ensureTranslateButton(messageItemEl) {
  // Проверяем именно наличие нашего контейнера — он может пропасть, если
  // React в Discord пере-отрендерил сообщение. Флаг через dataset бы остался,
  // и кнопка не добавилась бы заново.
  if (messageItemEl.querySelector('.dth-container')) return;
  const contentEl = findOwnContent(messageItemEl);
  if (!contentEl) return;
  const text = extractMessageText(contentEl);
  if (!text) return;

  const btn = document.createElement('button');
  btn.className = 'dth-translate-btn';
  btn.type = 'button';
  btn.textContent = t('translateButton');
  btn.title = t('translateMsgTitle');

  const resultBox = document.createElement('div');
  resultBox.className = 'dth-translation';
  resultBox.style.display = 'none';

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.dataset.loading === '1') return;
    if (resultBox.style.display === 'block') {
      // Тоггл скрытия
      resultBox.style.display = 'none';
      btn.textContent = t('translateButton');
      return;
    }
    btn.dataset.loading = '1';
    btn.textContent = t('translatingButton');
    try {
      const currentText = extractMessageText(contentEl);
      const { translated, detected } = await callBackground({
        type: 'translate',
        text: currentText,
        targetLang: STATE.settings && STATE.settings.targetLang
      });
      resultBox.innerHTML = '';
      const langTag = document.createElement('span');
      langTag.className = 'dth-lang';
      langTag.textContent = `(${detected || '??'} → ${(STATE.settings && STATE.settings.targetLang) || 'ru'})`;
      const textNode = document.createElement('span');
      textNode.className = 'dth-text';
      textNode.textContent = translated;
      resultBox.appendChild(langTag);
      resultBox.appendChild(document.createElement('br'));
      resultBox.appendChild(textNode);
      resultBox.style.display = 'block';
      btn.textContent = t('hideButton');
    } catch (err) {
      resultBox.textContent = t('errorPrefix') + err.message;
      resultBox.style.display = 'block';
      btn.textContent = t('retryButton');
    } finally {
      btn.dataset.loading = '0';
    }
  });

  // Вставляем строго после контента самого сообщения (не превью реплая).
  const container = document.createElement('div');
  container.className = 'dth-container';
  container.appendChild(btn);
  container.appendChild(resultBox);
  contentEl.insertAdjacentElement('afterend', container);
}

function scanMessages(root = document) {
  if (!STATE.enabled) return;
  const items = qAll(root, SELECTORS.messageItem);
  // Пустой результат — нормальная штука на первой проверке до рендера чата,
  // на странице настроек/друзей и т.п. Молчим.
  items.forEach(ensureTranslateButton);
}

// --- Перевод исходящего сообщения (инпут) ---

function findEditor() {
  for (const sel of SELECTORS.textboxEditor) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function getEditorText(editor) {
  // Slate хранит текст в плейн-узлах. textContent — норм для MVP.
  return editor.textContent || '';
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// Slate (React) обновляет свою внутреннюю модель текста только в ответ
// на paste-событие (через editor.insertText в обработчике onPaste).
// execCommand('insertText') рисует текст в DOM, но Slate его не подхватывает,
// и при отправке/бэкспейсе срабатывает старая модель — получается "призрак".
//
// Правильная последовательность:
//   1. focus
//   2. execCommand('selectAll')  — генерирует НАТИВНЫЙ selectionchange
//   3. ждём 2 кадра — Slate коммитит выделение в свою модель через React
//   4. dispatch ClipboardEvent('paste') с DataTransfer — Slate обрабатывает
//      штатным onPaste: удаляет выделение и вставляет новый текст в модель
async function replaceEditorText(editor, newText) {
  editor.focus();
  // Если фокус был не на редакторе (юзер кликал куда-то ещё), нужно дать
  // браузеру кадр на то, чтобы focus реально применился.
  await nextFrame();

  // Пробуем нативный selectAll. Он работает только если редактор реально в фокусе.
  let selected = false;
  try {
    selected = document.execCommand('selectAll', false);
  } catch { selected = false; }

  // Фолбэк: вручную выделяем содержимое редактора через Selection API.
  // Это срабатывает даже когда execCommand не отработал.
  if (!selected || window.getSelection().toString().length === 0) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    // Толкаем Slate, чтобы он подхватил новое выделение.
    document.dispatchEvent(new Event('selectionchange'));
  }

  // Два кадра — один на selectionchange, второй на React commit.
  await nextFrame();
  await nextFrame();

  const dt = new DataTransfer();
  dt.setData('text/plain', newText);
  editor.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true
  }));
}

// --- UI: обёртка с кнопкой + стрелкой + дропдауном языков ---

let inputWrap = null;
let inputBtnEl = null;       // основная кнопка (внутри обёртки)
let inputArrowBtn = null;    // стрелка справа
let langDropdown = null;     // выпадашка с языками

// Привычные пользователям обозначения языков на кнопке.
// Ключ — ISO 639-1 (то, что отправляем в API), значение — что показать.
const LANG_LABELS = {
  uk: 'UA', // ISO для украинского — uk, но люди ждут UA
  be: 'BY',
  kk: 'KZ',
  ja: 'JP',
  zh: 'CN'
};

// Нативные названия для дропдауна — те же что в попапе расширения.
const LANG_NAMES = {
  ru: 'Русский', en: 'English', uk: 'Українська', kk: 'Қазақша',
  be: 'Беларуская', de: 'Deutsch', fr: 'Français', es: 'Español',
  pt: 'Português', tr: 'Türkçe', ja: '日本語', zh: '中文',
  ar: 'العربية', pl: 'Polski'
};

function langLabel(code) {
  if (!code) return '';
  const lc = String(code).toLowerCase();
  return LANG_LABELS[lc] || lc.toUpperCase();
}

function getOutboundTargetCode() {
  const s = STATE.settings || {};
  return langLabel(s.outboundTargetLang || s.outboundLang || 'en');
}

function refreshInputButtonLabel() {
  if (!inputBtnEl) return;
  const code = getOutboundTargetCode();
  if (inputBtnEl.dataset.loading !== '1') {
    inputBtnEl.textContent = `🌐→${code}`;
  }
  inputBtnEl.dataset.target = code;
}

function editorHasText(editor) {
  if (!editor) return false;
  return (editor.textContent || '').trim().length > 0;
}

function positionInputButton() {
  if (!inputWrap) return;
  const editor = findEditor();
  const shouldShow = editor && editorHasText(editor);
  inputWrap.classList.toggle('dth-visible', !!shouldShow);
  if (!editor) return;
  const rect = editor.getBoundingClientRect();
  inputWrap.style.left = 'auto';
  inputWrap.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  inputWrap.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + 'px';
  inputWrap.style.top = 'auto';
}

async function runOutboundTranslate(overrideTargetLang) {
  const ed = findEditor();
  if (!ed || !inputBtnEl) return;
  const text = getEditorText(ed).trim();
  if (!text) return;
  inputBtnEl.disabled = true;
  inputBtnEl.dataset.loading = '1';
  inputBtnEl.textContent = '⏳';
  try {
    const s = STATE.settings || {};
    const outboundTarget = overrideTargetLang || s.outboundTargetLang || s.outboundLang || 'en';
    let outboundSource = s.outboundSourceLang || 'auto';
    if (outboundSource.toLowerCase() === outboundTarget.toLowerCase()) {
      outboundSource = 'auto';
    }
    const { translated } = await callBackground({
      type: 'translate',
      text,
      targetLang: outboundTarget,
      sourceLang: outboundSource
    });
    await replaceEditorText(ed, translated);
  } catch (err) {
    console.error('[DTH] translate input error:', err);
    inputBtnEl.title = (t('errorPrefix') || 'Error: ') + err.message;
  } finally {
    inputBtnEl.disabled = false;
    inputBtnEl.dataset.loading = '0';
    refreshInputButtonLabel();
  }
}

function populateLangDropdown() {
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
      // Сохраняем выбранный язык в общие настройки + сразу переводим.
      if (STATE.settings) STATE.settings.outboundTargetLang = code;
      chrome.storage.sync.set({ outboundTargetLang: code });
      refreshInputButtonLabel();
      await runOutboundTranslate(code);
    });
    langDropdown.appendChild(item);
  }
}

function ensureInputButton() {
  if (!inputWrap) {
    const wrap = document.createElement('div');
    wrap.className = 'dth-input-wrap';

    const mainBtn = document.createElement('button');
    mainBtn.className = 'dth-input-btn';
    mainBtn.type = 'button';
    mainBtn.title = t('translateInputTitle');
    mainBtn.textContent = `🌐→${getOutboundTargetCode()}`;
    mainBtn.addEventListener('mousedown', e => e.preventDefault());
    mainBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await runOutboundTranslate();
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
    inputBtnEl = mainBtn;
    inputArrowBtn = arrowBtn;
    langDropdown = dropdown;

    populateLangDropdown();

    window.addEventListener('resize', positionInputButton);
    window.addEventListener('scroll', positionInputButton, true);
    document.addEventListener('input', (e) => {
      const tgt = e.target;
      if (tgt && tgt.matches && tgt.matches(SELECTORS.textboxEditor.join(','))) {
        positionInputButton();
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      const tgt = e.target;
      if (tgt && tgt.matches && tgt.matches(SELECTORS.textboxEditor.join(','))) {
        positionInputButton();
      }
    }, true);
    // Закрываем выпадашку при клике вне неё.
    document.addEventListener('click', (e) => {
      if (langDropdown && langDropdown.classList.contains('dth-open') &&
          !inputWrap.contains(e.target)) {
        langDropdown.classList.remove('dth-open');
      }
    }, true);
    console.log('[DTH] кнопка перевода ввода (+ дропдаун языков) добавлена');
  }
  positionInputButton();
}

// --- Наблюдатель за DOM ---

const observer = new MutationObserver(() => {
  if (!STATE.enabled) return;
  scanMessages();
  ensureInputButton();
});

function start() {
  observer.observe(document.body, { childList: true, subtree: true });
  scanMessages();
  ensureInputButton();
}

// --- Реакция на изменения настроек ---

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const uiLangChanged = changes.uiLang !== undefined;
  loadSettings().then(() => {
    if (uiLangChanged) {
      // Сменился язык интерфейса — пересоздаём все наши кнопки с новыми текстами.
      refreshAllLabels();
    } else {
      // Просто настройки — обновим только подпись с кодом языка на кнопке ввода.
      refreshInputButtonLabel();
    }
  });
});

// Дублирующий канал из попапа — на случай если storage.onChanged не доходит
// (бывает с MV3 service worker'ом, который спит).
// Попап шлёт уже готовый JSON переводов внутри сообщения, чтобы мы не фетчили
// файл локали сами — этот фетч из isolated world иногда отказывал.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'localeChanged') {
    overrideMessages = msg.messages || null;
    if (STATE.settings) STATE.settings.uiLang = msg.uiLang || 'auto';
    refreshAllLabels();
  }
});

// --- Запуск ---

loadSettings().then(start);
