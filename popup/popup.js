const FIELDS = [
  'translationEnabled',
  'pageTranslationEnabled',
  'pageTranslationTargetLang',
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
  'chatgptConversationUrl',
  'aiChatProvider',
  'xAgentEnabled',
  'xAgentProvider',
  'xAgentAutoSubmit',
  'xAgentSoundEnabled',
  'xAgentNotifyEnabled',
  'xAgentOpenReport',
  'xAgentRunCount',
  'xAgentMemoryLimit',
  'xAgentDelayMinSeconds',
  'xAgentDelayMaxSeconds',
  'xAgentBeforeReplyMinSeconds',
  'xAgentBeforeReplyMaxSeconds',
  'xAgentPrompt',
  'xRelationshipPrompt',
  'xRelationshipAutoLike',
  'xRelationshipAutoFollow',
  'xRelationshipReplyToFollowers',
  'uiLang'
];

const DEFAULTS = {
  translationEnabled: true,
  pageTranslationEnabled: false,
  pageTranslationTargetLang: 'ru',
  aiChatEnabled: false,
  provider: 'google',
  targetLang: 'ru',
  outboundSourceLang: 'ru',
  outboundTargetLang: 'en',
  deeplKey: '',
  geminiKey: '',
  geminiModel: 'auto',
  openrouterKey: '',
  openrouterModel: 'google/gemini-2.5-flash',
  chatgptModel: 'auto',
  chatgptConversationUrl: '',
  aiChatProvider: 'openrouter',
  xAgentEnabled: true,
  xAgentProvider: 'openrouter',
  xAgentAutoSubmit: false,
  xAgentSoundEnabled: true,
  xAgentNotifyEnabled: true,
  xAgentOpenReport: true,
  xAgentRunCount: 3,
  xAgentMemoryLimit: 8,
  xAgentDelayMinSeconds: 30,
  xAgentDelayMaxSeconds: 90,
  xAgentBeforeReplyMinSeconds: 1,
  xAgentBeforeReplyMaxSeconds: 3,
  xAgentPrompt: 'Write a short, natural, friendly reply in English. Sound like a real person, not a bot. Do not overhype. Do not use hashtags unless they are clearly relevant.',
  xRelationshipPrompt: 'Write a short, natural reply that builds genuine rapport with this author. Add a specific useful thought about the post. When it fits naturally, suggest staying connected without directly asking for a follow-back. Avoid repeating earlier wording or invitations.',
  xRelationshipAutoLike: false,
  xRelationshipAutoFollow: false,
  xRelationshipReplyToFollowers: false,
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
let popupLoaded = false;
let autoSaveTimer = null;

function setAutosaveStatus(state, text) {
  const label = document.getElementById('autosaveStatus');
  const box = label?.closest('.autosave-status');
  if (!label || !box) return;
  box.classList.toggle('is-saving', state === 'saving');
  box.classList.toggle('is-error', state === 'error');
  label.textContent = text;
}

function scheduleAutoSave(delay = 450) {
  if (!popupLoaded) return;
  clearTimeout(autoSaveTimer);
  setAutosaveStatus('saving', 'Saving changes…');
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    save().catch(error => {
      console.error('[DTH popup] autosave failed:', error);
      setAutosaveStatus('error', 'Could not save changes');
    });
  }, delay);
}

function applyXAgentCollapsed(collapsed) {
  const card = document.getElementById('xAgentCard');
  const button = document.getElementById('xAgentCollapse');
  if (!card || !button) return;
  card.classList.toggle('is-collapsed', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = collapsed ? 'Expand X Reply Agent' : 'Collapse X Reply Agent';
}

function updateMemoryEstimate() {
  const input = document.getElementById('xAgentMemoryLimit');
  const hint = document.getElementById('xAgentMemoryEstimate');
  if (!input || !hint) return;
  const count = Math.max(0, Math.min(50, Math.round(Number(input.value) || 0)));
  const low = count * 100;
  const high = count * 400;
  hint.textContent = count === 0
    ? 'Agent memory is disabled. No rated examples will be sent to AI.'
    : `Approximately ${low.toLocaleString()}–${high.toLocaleString()} extra input tokens per reply. More memory can increase API cost and response time.`;
}

async function resetXAgentMemory() {
  const confirmed = confirm('Reset all X Agent memory? Ratings and descriptions will be permanently deleted.');
  if (!confirmed) return;
  await chrome.storage.local.remove('xAgentFeedback');
  const button = document.getElementById('resetXAgentMemory');
  const original = button.textContent;
  button.textContent = 'Memory reset';
  setTimeout(() => { button.textContent = original; }, 1400);
}

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

function showProviderFields() {
  const translationEnabled = document.getElementById('translationEnabled').checked;
  const provider = document.getElementById('provider').value;
  const aiProvider = document.getElementById('aiChatProvider').value;
  const xAgentProvider = document.getElementById('xAgentProvider').value;
  const aiChatEnabled = document.getElementById('aiChatEnabled').checked;
  const xAgentEnabled = document.getElementById('xAgentEnabled').checked;
  const needsChatGPT = (translationEnabled && provider === 'chatgpt')
    || (aiChatEnabled && aiProvider === 'chatgpt')
    || (xAgentEnabled && xAgentProvider === 'chatgpt');
  const needsOpenRouter = (translationEnabled && (provider === 'openrouter' || provider === 'openrouter_free'))
    || (aiChatEnabled && aiProvider === 'openrouter')
    || (xAgentEnabled && xAgentProvider === 'openrouter');
  document.getElementById('chatgpt-fields').hidden = !needsChatGPT;
  document.getElementById('gemini-fields').hidden = provider !== 'gemini';
  document.getElementById('openrouter-fields').hidden = !needsOpenRouter;
  document.getElementById('deepl-fields').hidden = provider !== 'deepl';
  document.getElementById('freeBadge').hidden = !FREE_PROVIDERS.has(provider);
}

function showAiChatTools() {
  const translationUsesChatGPT = document.getElementById('translationEnabled').checked
    && document.getElementById('provider').value === 'chatgpt';
  const aiChatUsesChatGPT = document.getElementById('aiChatEnabled').checked
    && document.getElementById('aiChatProvider').value === 'chatgpt';
  const xAgentUsesChatGPT = document.getElementById('xAgentEnabled').checked
    && document.getElementById('xAgentProvider').value === 'chatgpt';
  const tools = document.getElementById('chatgpt-ai-tools');
  if (tools) tools.hidden = !translationUsesChatGPT && !aiChatUsesChatGPT && !xAgentUsesChatGPT;
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
  const pageTranslationOff = !document.getElementById('pageTranslationEnabled').checked;
  const aiChatOff = !document.getElementById('aiChatEnabled').checked;
  const xAgentOff = !document.getElementById('xAgentEnabled').checked;
  const provider = document.getElementById('provider').value;
  const aiProvider = document.getElementById('aiChatProvider').value;
  const xAgentProvider = document.getElementById('xAgentProvider').value;

  ['provider', 'targetLang', 'outboundSourceLang', 'outboundTargetLang', 'swapBtn']
    .forEach(id => setControlDisabled(id, translationOff));
  setControlDisabled('pageTranslationEnabled', translationOff);
  setControlDisabled('pageTranslationTargetLang', translationOff || pageTranslationOff);
  setControlDisabled('geminiKey', translationOff || provider !== 'gemini');
  setControlDisabled('geminiModel', translationOff || provider !== 'gemini');
  setControlDisabled('deeplKey', translationOff || provider !== 'deepl');

  const openRouterNeeded = (!translationOff && (provider === 'openrouter' || provider === 'openrouter_free'))
    || (!aiChatOff && aiProvider === 'openrouter')
    || (!xAgentOff && xAgentProvider === 'openrouter');
  const chatGPTNeeded = (!translationOff && provider === 'chatgpt')
    || (!aiChatOff && aiProvider === 'chatgpt')
    || (!xAgentOff && xAgentProvider === 'chatgpt');
  setControlDisabled('openrouterKey', !openRouterNeeded);
  setControlDisabled('openrouterModel', !openRouterNeeded);
  setControlDisabled('chatgptModel', !chatGPTNeeded);
  setControlDisabled('chatgptConversationUrl', !chatGPTNeeded);
  const configuredChatButton = document.getElementById('openConfiguredChatgpt');
  if (configuredChatButton) {
    configuredChatButton.disabled = !chatGPTNeeded
      || !document.getElementById('chatgptConversationUrl').value.trim();
  }

  setControlDisabled('aiChatProvider', aiChatOff);
  setControlDisabled('setupChatgptWindow', !chatGPTNeeded);

  [
    'xAgentProvider', 'xAgentAutoSubmit', 'xAgentSoundEnabled', 'xAgentNotifyEnabled',
    'xAgentOpenReport', 'xAgentRunCount', 'xAgentDelayMinSeconds',
    'xAgentDelayMaxSeconds', 'xAgentBeforeReplyMinSeconds', 'xAgentBeforeReplyMaxSeconds',
    'xAgentMemoryLimit', 'xAgentPrompt',
    'xRelationshipPrompt', 'xRelationshipAutoLike', 'xRelationshipAutoFollow',
    'xRelationshipReplyToFollowers', 'startXAgent'
  ].forEach(id => setControlDisabled(id, xAgentOff));
}

async function setupChatGPTWindow(useConfiguredConversation = false) {
  const btn = document.getElementById(
    useConfiguredConversation ? 'openConfiguredChatgpt' : 'setupChatgptWindow'
  );
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Setting up...';
  btn.title = '';
  try {
    if (useConfiguredConversation) await save();
    const resp = await chrome.runtime.sendMessage({
      type: 'setup-chatgpt-window',
      useConfiguredConversation
    });
    if (!resp || resp.ok !== true) throw new Error(resp?.error || 'Could not set up ChatGPT window.');
    btn.textContent = 'Ready';
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1400);
  } catch (e) {
    btn.textContent = 'Error';
    btn.title = e.message || String(e);
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2200);
  }
}

async function sendTabMessageWithRetry(tabId, message, attempts = 12) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      lastError = e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastError || new Error('Tab is not ready.');
}

async function startXAgentFromPopup() {
  const btn = document.getElementById('startXAgent');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Starting...';
  try {
    await save();
    let tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    let tab = tabs.find(t => t.active) || tabs[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
      await new Promise(r => setTimeout(r, 2500));
    } else {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    }
    await sendTabMessageWithRetry(tab.id, { type: 'xAgentRefresh' }, 8).catch(() => {});
    await sendTabMessageWithRetry(tab.id, { type: 'xAgentStart' }, 12);
    btn.textContent = 'Started';
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1400);
  } catch (e) {
    btn.textContent = 'Open X and retry';
    btn.title = e.message || String(e);
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2400);
  }
}

async function openXAgentReport() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL('report/x-agent-report.html'),
    active: true
  });
}

async function openRelationshipDashboard() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL('relationship/relationship.html'),
    active: true
  });
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
  populateLangSelect(document.getElementById('pageTranslationTargetLang'), false);
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

async function refreshGeminiModelOptions({ force = false, selectedValue } = {}) {
  const select = document.getElementById('geminiModel');
  const keyInput = document.getElementById('geminiKey');
  const hint = document.getElementById('geminiModelHint');
  const button = document.getElementById('refreshGeminiModels');
  if (!select || !keyInput || !hint || !button) return;

  const requested = selectedValue || select.value || 'auto';
  select.replaceChildren(new Option('Auto (recommended)', 'auto'));
  hint.classList.remove('is-warning');
  if (!keyInput.value.trim()) {
    select.value = 'auto';
    hint.textContent = 'Enter your Gemini API key to load compatible models.';
    if (requested !== 'auto') await chrome.storage.sync.set({ geminiModel: 'auto' });
    return;
  }

  button.disabled = true;
  hint.textContent = 'Loading current Gemini models…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getGeminiModels', force });
    if (!response?.ok) throw new Error(response?.error || 'Could not load Gemini models.');
    const models = Array.isArray(response.models) ? response.models : [];
    models.forEach(model => {
      const id = String(model.id || '');
      if (!id) return;
      const name = String(model.displayName || id);
      select.append(new Option(name === id ? id : `${name} — ${id}`, id));
    });
    const available = models.some(model => model.id === requested);
    const nextValue = requested === 'auto' || available ? requested : 'auto';
    select.value = nextValue;
    if (nextValue !== requested) await chrome.storage.sync.set({ geminiModel: nextValue });
    hint.textContent = response.regionUnsupported
      ? t('geminiRegionUnsupported')
      : (response.warning || (response.autoModel
        ? `Auto currently uses ${response.autoModel}. ${models.length} compatible models found.`
        : `${models.length} compatible models found.`));
    hint.classList.toggle('is-warning', response.regionUnsupported === true);
  } catch (error) {
    select.value = 'auto';
    hint.textContent = error.message || String(error);
    hint.classList.add('is-warning');
  } finally {
    button.disabled = false;
  }
}

async function load() {
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ xAgentCardCollapsed: false })
  ]);
  applyTheme(stored.theme);
  await applyLocale(stored.uiLang);
  const savedGeminiModel = String(stored.geminiModel || 'auto');
  const geminiSelect = document.getElementById('geminiModel');
  if (savedGeminiModel !== 'auto') {
    geminiSelect.append(new Option(savedGeminiModel, savedGeminiModel));
  }
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el || stored[key] === undefined) continue;
    if (el.type === 'checkbox') el.checked = stored[key] !== false;
    else el.value = stored[key];
  }
  showProviderFields();
  showAiChatTools();
  showFeatureStates();
  updateMemoryEstimate();
  applyXAgentCollapsed(local.xAgentCardCollapsed === true);
  if (stored.provider === 'gemini') {
    await refreshGeminiModelOptions({ selectedValue: savedGeminiModel });
  }
  popupLoaded = true;
  setAutosaveStatus('saved', 'Changes are saved automatically');
}

async function save() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  const payload = {};
  const numericRules = {
    xAgentRunCount: { min: 1, max: 20, fallback: 3 },
    xAgentMemoryLimit: { min: 0, max: 50, fallback: 8 },
    xAgentDelayMinSeconds: { min: 5, max: 600, fallback: 30 },
    xAgentDelayMaxSeconds: { min: 5, max: 600, fallback: 90 },
    xAgentBeforeReplyMinSeconds: { min: 1, max: 600, fallback: 1 },
    xAgentBeforeReplyMaxSeconds: { min: 1, max: 600, fallback: 3 }
  };
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === 'checkbox') payload[key] = el.checked;
    else if (el.type === 'number') {
      const rule = numericRules[key] || { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 };
      const parsed = el.value.trim() === '' ? NaN : Number(el.value);
      const value = Number.isFinite(parsed) ? Math.round(parsed) : rule.fallback;
      payload[key] = Math.max(rule.min, Math.min(rule.max, value));
      el.value = payload[key];
    }
    else payload[key] = el.value;
  }
  for (const [minKey, maxKey] of [
    ['xAgentDelayMinSeconds', 'xAgentDelayMaxSeconds'],
    ['xAgentBeforeReplyMinSeconds', 'xAgentBeforeReplyMaxSeconds']
  ]) {
    let min = Math.min(payload[minKey], payload[maxKey]);
    let max = Math.max(payload[minKey], payload[maxKey]);
    if (minKey === 'xAgentBeforeReplyMinSeconds' && min === max) {
      min = Math.min(min, numericRules[maxKey].max - 1);
      max = min + 1;
    }
    document.getElementById(minKey).value = payload[minKey] = min;
    document.getElementById(maxKey).value = payload[maxKey] = max;
  }
  // theme сохраняется отдельно — при клике тогглера, чтобы было моментально.
  payload.theme = document.body.dataset.theme;
  await chrome.storage.sync.set(payload);
  setAutosaveStatus('saved', 'Saved automatically');
}

// ----- Init -----

document.addEventListener('DOMContentLoaded', () => {
  load().catch(error => {
    console.error('[DTH popup] load failed:', error);
    setAutosaveStatus('error', 'Could not load settings');
  });

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
  document.getElementById('provider').addEventListener('change', async (event) => {
    showProviderFields();
    showAiChatTools();
    showFeatureStates();
    if (event.target.value === 'gemini') {
      await save();
      await refreshGeminiModelOptions({ selectedValue: document.getElementById('geminiModel').value });
    }
  });

  document.getElementById('translationEnabled').addEventListener('change', () => {
    showProviderFields();
    showAiChatTools();
    showFeatureStates();
  });
  document.getElementById('pageTranslationEnabled').addEventListener('change', showFeatureStates);
  document.getElementById('aiChatEnabled').addEventListener('change', () => {
    showProviderFields();
    showAiChatTools();
    showFeatureStates();
  });
  document.getElementById('xAgentEnabled').addEventListener('change', () => {
    showProviderFields();
    showAiChatTools();
    showFeatureStates();
  });
  document.getElementById('aiChatProvider').addEventListener('change', () => {
    showProviderFields();
    showAiChatTools();
    showFeatureStates();
  });
  document.getElementById('xAgentProvider').addEventListener('change', () => {
    showProviderFields();
    showAiChatTools();
    showFeatureStates();
  });
  document.getElementById('setupChatgptWindow').addEventListener('click', () => setupChatGPTWindow(false));
  document.getElementById('openConfiguredChatgpt').addEventListener('click', () => setupChatGPTWindow(true));
  document.getElementById('chatgptConversationUrl').addEventListener('input', showFeatureStates);
  document.getElementById('startXAgent').addEventListener('click', startXAgentFromPopup);
  document.getElementById('openXAgentReport').addEventListener('click', openXAgentReport);
  document.getElementById('openRelationshipDashboard').addEventListener('click', openRelationshipDashboard);
  document.getElementById('resetXAgentMemory').addEventListener('click', resetXAgentMemory);
  document.getElementById('xAgentMemoryLimit').addEventListener('input', updateMemoryEstimate);
  document.getElementById('refreshGeminiModels').addEventListener('click', async () => {
    await save();
    await refreshGeminiModelOptions({
      force: true,
      selectedValue: document.getElementById('geminiModel').value
    });
  });
  document.getElementById('geminiKey').addEventListener('change', async () => {
    if (document.getElementById('provider').value !== 'gemini') return;
    await save();
    await refreshGeminiModelOptions({
      force: true,
      selectedValue: document.getElementById('geminiModel').value
    });
  });
  document.getElementById('xAgentCollapse').addEventListener('click', async () => {
    const card = document.getElementById('xAgentCard');
    const collapsed = !card.classList.contains('is-collapsed');
    applyXAgentCollapsed(collapsed);
    await chrome.storage.local.set({ xAgentCardCollapsed: collapsed });
  });

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
    scheduleAutoSave(0);
  });

  for (const key of FIELDS) {
    if (key === 'uiLang') continue;
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener(el.matches('input[type="text"], input[type="password"], input[type="number"], textarea') ? 'input' : 'change', () => {
      scheduleAutoSave();
    });
  }
});
