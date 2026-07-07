const FIELDS = [
  'translationEnabled',
  'aiChatEnabled',
  'provider',
  'targetLang',
  'outboundSourceLang',
  'outboundTargetLang',
  'deeplKey',
  'geminiKey',
  'geminiModel',
  'openrouterKey',
  'openrouterModel',
  'chatgptModel',
  'aiChatProvider',
  'uiLang'
];

const DEFAULTS = {
  translationEnabled: true,
  aiChatEnabled: false,
  provider: 'google',
  targetLang: 'ru',
  outboundSourceLang: 'ru',
  outboundTargetLang: 'en',
  deeplKey: '',
  geminiKey: '',
  geminiModel: 'gemini-2.0-flash',
  openrouterKey: '',
  openrouterModel: 'google/gemini-2.5-flash',
  chatgptModel: 'auto',
  aiChatProvider: 'openrouter',
  uiLang: 'auto',
  theme: 'dark'
};

const LANGS = ['ru', 'en', 'uk', 'kk', 'be', 'de', 'fr', 'es', 'pt', 'tr', 'ja', 'zh'];

const UI_LANGS = [
  { code: 'en', native: 'English' },
  { code: 'ru', native: 'Русский' },
  { code: 'uk', native: 'Українська' },
  { code: 'de', native: 'Deutsch' },
  { code: 'fr', native: 'Français' },
  { code: 'es', native: 'Español' },
  { code: 'pt', native: 'Português' },
  { code: 'tr', native: 'Türkçe' },
  { code: 'pl', native: 'Polski' },
  { code: 'ar', native: 'العربية' },
  { code: 'zh', native: '中文' },
  { code: 'ja', native: '日本語' }
];

const DISPLAY_OVERRIDES = { uk: 'UA', be: 'BY', kk: 'KZ', ja: 'JP', zh: 'CN' };

// Провайдеры с бейджем FREE — те, где можно работать без своего ключа.
// OpenRouter требует пользовательский API-ключ, поэтому без бейджа FREE.
const FREE_PROVIDERS = new Set(['openrouter_free', 'google', 'mymemory']);

const SUN_PATH = `<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
const MOON_PATH = `<path d="M20 14.5A8 8 0 119.5 4 6.5 6.5 0 0020 14.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`;

let overrideMessages = null;

// ----- i18n -----

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

function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const text = t(key);
    if (text) el.textContent = text;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    const text = t(key);
    if (text) el.placeholder = text;
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    const text = t(key);
    if (text) el.title = text;
  });
}

// ----- Списки языков -----

function populateLangSelect(selectEl, withAuto) {
  const current = selectEl.value;
  selectEl.innerHTML = '';
  if (withAuto) {
    const opt = document.createElement('option');
    opt.value = 'auto';
    opt.textContent = t('autoLang');
    selectEl.appendChild(opt);
  }
  for (const code of LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    const name = t('lang_' + code);
    const display = DISPLAY_OVERRIDES[code] || code.toUpperCase();
    opt.textContent = `${name} (${display})`;
    selectEl.appendChild(opt);
  }
  if (current) selectEl.value = current;
}

function populateUiLangSelect(selectEl) {
  const current = selectEl.value;
  selectEl.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = t('uiLangAuto');
  selectEl.appendChild(auto);
  for (const { code, native } of UI_LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = native;
    selectEl.appendChild(opt);
  }
  if (current) selectEl.value = current;
}

// ----- Видимость полей провайдера + бейдж FREE -----

function showProviderFields(provider) {
  document.getElementById('chatgpt-fields').hidden = provider !== 'chatgpt';
  document.getElementById('gemini-fields').hidden = provider !== 'gemini';
  document.getElementById('openrouter-fields').hidden = provider !== 'openrouter' && provider !== 'openrouter_free';
  document.getElementById('deepl-fields').hidden = provider !== 'deepl';
  document.getElementById('freeBadge').hidden = !FREE_PROVIDERS.has(provider);
}

function setControlDisabled(id, disabled) {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = disabled;
  const container = el.closest('.field, .card, .provider-fields');
  if (container) container.classList.toggle('feature-disabled', disabled);
}

function showFeatureStates() {
  const translationOff = !document.getElementById('translationEnabled').checked;
  const aiChatOff = !document.getElementById('aiChatEnabled').checked;
  [
    'provider', 'targetLang', 'outboundSourceLang', 'outboundTargetLang',
    'deeplKey', 'geminiKey',
    'geminiModel', 'openrouterKey', 'openrouterModel', 'chatgptModel', 'swapBtn'
  ].forEach(id => setControlDisabled(id, translationOff));
  setControlDisabled('aiChatProvider', aiChatOff);
}

// ----- Тема -----

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = t;
  const icon = document.getElementById('themeIcon');
  if (icon) icon.innerHTML = t === 'dark' ? SUN_PATH : MOON_PATH;
}

// ----- Локаль: применение + broadcast в Discord -----

async function applyLocale(uiLang) {
  await ensureOverrideLocale(uiLang);
  applyI18n();
  populateLangSelect(document.getElementById('targetLang'), false);
  populateLangSelect(document.getElementById('outboundSourceLang'), true);
  populateLangSelect(document.getElementById('outboundTargetLang'), false);
  populateUiLangSelect(document.getElementById('uiLang'));
  // Восстанавливаем выбранные значения после повторного populate
  // (на случай, если сменили UI lang, а текущие values остались).
}

async function broadcastLocaleChange(uiLang) {
  let messages = null;
  if (uiLang && uiLang !== 'auto') {
    try {
      const url = chrome.runtime.getURL(`_locales/${uiLang}/messages.json`);
      const res = await fetch(url);
      messages = await res.json();
    } catch (e) {
      console.warn('[DTH popup] не удалось прочитать локаль', uiLang, e);
    }
  }
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://discord.com/*',
        'https://canary.discord.com/*',
        'https://ptb.discord.com/*'
      ]
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'localeChanged', uiLang, messages }).catch(() => {});
    }
  } catch (e) {
    console.debug('[DTH popup] broadcast failed:', e);
  }
}

// ----- Загрузка / сохранение -----

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  applyTheme(stored.theme);
  await applyLocale(stored.uiLang);
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el || stored[key] === undefined) continue;
    if (el.type === 'checkbox') el.checked = stored[key] !== false;
    else el.value = stored[key];
  }
  showProviderFields(stored.provider);
  showFeatureStates();
}

async function save() {
  const payload = {};
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (el) payload[key] = el.type === 'checkbox' ? el.checked : el.value;
  }
  // theme сохраняется отдельно — при клике тогглера, чтобы было моментально.
  payload.theme = document.body.dataset.theme;
  await chrome.storage.sync.set(payload);
  const btn = document.getElementById('save');
  const txt = btn.querySelector('.save-text');
  const originalText = txt.textContent;
  btn.classList.add('saved');
  txt.textContent = t('savedStatus').replace(/^✓\s*/, '');
  setTimeout(() => {
    btn.classList.remove('saved');
    txt.textContent = originalText;
  }, 1500);
}

// ----- Init -----

document.addEventListener('DOMContentLoaded', () => {
  load();

  // Тема
  document.getElementById('themeToggle').addEventListener('click', async () => {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    await chrome.storage.sync.set({ theme: next });
  });

  // UI lang
  document.getElementById('uiLang').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ uiLang: e.target.value });
    await applyLocale(e.target.value);
    await broadcastLocaleChange(e.target.value);
  });

  // Провайдер
  document.getElementById('provider').addEventListener('change', (e) => {
    showProviderFields(e.target.value);
  });

  document.getElementById('translationEnabled').addEventListener('change', showFeatureStates);
  document.getElementById('aiChatEnabled').addEventListener('change', showFeatureStates);

  // Свап языков
  document.getElementById('swapBtn').addEventListener('click', () => {
    const src = document.getElementById('outboundSourceLang');
    const tgt = document.getElementById('outboundTargetLang');
    // Source может быть 'auto', target — нет. Если source = 'auto',
    // меняем только target (auto не получится поставить в target).
    if (src.value === 'auto') return;
    const tmp = src.value;
    src.value = tgt.value;
    tgt.value = tmp;
  });

  // Сохранение
  document.getElementById('save').addEventListener('click', save);
});
