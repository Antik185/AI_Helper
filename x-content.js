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

const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const X_AGENT_BUTTON_CLASS = 'dth-x-agent-btn';
const X_AGENT_CONTROL_CLASS = 'dth-x-agent-control';
const X_AGENT_ACTIVE_CLASS = 'dth-x-agent-active';
const X_AGENT_PANEL_CLASS = 'dth-x-agent-panel';
const X_AGENT_PROCESSED_ATTR = 'data-dth-x-agent-done';

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
const X_AGENT_DAILY_STATS_KEY = 'dthXAgentDailyStats';
const X_AGENT_POSITION_KEY = 'dthXAgentPosition';

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
    const local = await chrome.storage.local.get([
      POSITION_KEY,
      X_AGENT_DAILY_STATS_KEY,
      X_AGENT_POSITION_KEY
    ]);
    STATE.customPosition = local[POSITION_KEY] || null;
    xAgentPosition = local[X_AGENT_POSITION_KEY] || null;
    const daily = local[X_AGENT_DAILY_STATS_KEY];
    if (daily && daily.date === xAgentTodayKey()) {
      xAgentTodayReplies = Math.max(0, Number(daily.count) || 0);
    } else {
      xAgentTodayReplies = 0;
      await chrome.storage.local.set({
        [X_AGENT_DAILY_STATS_KEY]: { date: xAgentTodayKey(), count: 0 }
      });
    }
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

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function xAgentTodayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

async function incrementXAgentTodayReplies() {
  const stored = await chrome.storage.local.get(X_AGENT_DAILY_STATS_KEY);
  const current = stored[X_AGENT_DAILY_STATS_KEY];
  const date = xAgentTodayKey();
  const count = current?.date === date ? Math.max(0, Number(current.count) || 0) + 1 : 1;
  xAgentTodayReplies = count;
  await chrome.storage.local.set({ [X_AGENT_DAILY_STATS_KEY]: { date, count } });
  updateXAgentPanel();
}

function playAgentSound(kind = 'ready') {
  if (!STATE.settings || STATE.settings.xAgentSoundEnabled === false) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'complete' ? 1040 : kind === 'sent' ? 880 : 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch { }
}

function getTweetText(article) {
  const blocks = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
    .filter(el => !el.closest('article[data-testid="tweet"]') || el.closest('article[data-testid="tweet"]') === article)
    .map(el => (el.textContent || '').trim())
    .filter(Boolean);
  if (blocks.length) return blocks.join('\n');
  return (article.textContent || '').trim().slice(0, 3000);
}

function getTweetAuthor(article) {
  const user = article.querySelector('[data-testid="User-Name"]');
  return (user?.textContent || '').trim();
}

function getTweetUrl(article) {
  const statusLink = Array.from(article.querySelectorAll('a[href*="/status/"]'))
    .map(a => a.href)
    .find(Boolean);
  return statusLink || location.href;
}

function getTweetPayload(article) {
  return {
    text: getTweetText(article),
    author: getTweetAuthor(article),
    url: getTweetUrl(article),
    pageUrl: location.href
  };
}

function isPromotedTweet(article) {
  const text = (article.textContent || '').toLowerCase();
  return /\bpromoted\b|реклама|продвигается|promocionado|sponsorisé|gesponsert/.test(text);
}

function findReplyButton(article) {
  return article.querySelector('[data-testid="reply"]')
    || article.querySelector('button[aria-label*="Reply" i]')
    || article.querySelector('button[aria-label*="Ответ" i]');
}

function findTweetActionGroup(article) {
  const reply = findReplyButton(article);
  if (!reply) return null;
  return reply.closest('[role="group"]') || reply.parentElement?.parentElement || reply.parentElement;
}

function getAgentRunLimit() {
  const raw = Number(STATE.settings && STATE.settings.xAgentRunCount);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(20, Math.round(raw)));
}

function getAgentDelayRange() {
  const minRaw = Number(STATE.settings && STATE.settings.xAgentDelayMinSeconds);
  const maxRaw = Number(STATE.settings && STATE.settings.xAgentDelayMaxSeconds);
  const min = Math.max(5, Math.min(600, Number.isFinite(minRaw) ? Math.round(minRaw) : 30));
  const max = Math.max(5, Math.min(600, Number.isFinite(maxRaw) ? Math.round(maxRaw) : 90));
  return min <= max ? { min, max } : { min: max, max: min };
}

function getRandomAgentDelayMs() {
  const { min, max } = getAgentDelayRange();
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

function findSubmitButton(root) {
  const scope = root || document;
  return Array.from(scope.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"], button[type="submit"]'))
    .find(btn => isVisible(btn) && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled);
}

async function waitForSubmitButton(root) {
  for (let i = 0; i < 20; i++) {
    const btn = findSubmitButton(root);
    if (btn) return btn;
    await sleep(120);
  }
  return null;
}

async function waitForReplyCompose(beforeSet) {
  for (let i = 0; i < 50; i++) {
    const dialog = document.querySelector('[role="dialog"]');
    const candidates = Array.from(document.querySelectorAll(COMPOSE_SELECTORS.join(',')))
      .filter(isVisible);
    const fresh = candidates.find(el => !beforeSet || !beforeSet.has(el));
    if (fresh) return fresh;
    if (dialog) {
      const inDialog = candidates.find(el => dialog.contains(el));
      if (inDialog) return inDialog;
    }
    await sleep(120);
  }
  return findActiveCompose();
}

// --- Floating button UI ---

let inputWrap = null;
let inputMainBtn = null;
let langDropdown = null;
let xAgentPanel = null;
let xAgentRunning = false;
let xAgentStopRequested = false;
let xAgentPaused = false;
let xAgentPanelStatus = 'Ready';
let xAgentNextReplyMs = null;
let xAgentTodayReplies = 0;
let xAgentScanTimer = null;
let xAgentActiveJobs = 0;
let xAgentAnimationMode = null;
let xAgentPosition = null;
let xAgentSuppressClick = false;
let xAgentSettingsSaveTimer = null;
let xAgentPendingSettings = {};
const X_AGENT_ANIMATION_VIDEOS = {
  idle: chrome.runtime.getURL('animated/son/son-transparent.webm'),
  working: chrome.runtime.getURL('animated/kopaet/kopaet-transparent.webm')
};

function stopXAgentAnimation() {
  xAgentAnimationMode = null;
  if (!xAgentPanel) return;
  xAgentPanel.querySelectorAll('.dth-x-agent-mascot-video').forEach(video => {
    video.pause();
    video.classList.remove('is-active');
  });
}

function updateXAgentAnimation(state) {
  if (!xAgentPanel) {
    stopXAgentAnimation();
    return;
  }
  const videos = Array.from(xAgentPanel.querySelectorAll('.dth-x-agent-mascot-video'));
  if (!videos.length) return;
  const mode = state === 'running' || state === 'stopping' ? 'working' : 'idle';
  if (xAgentAnimationMode === mode) return;
  xAgentAnimationMode = mode;
  videos.forEach(video => {
    const active = video.dataset.animation === mode;
    video.classList.toggle('is-active', active);
    if (!active) {
      video.pause();
      return;
    }
    try { video.currentTime = 0; } catch { }
    video.play().catch(() => {});
  });
}

function updateXAgentPanelPlacement() {
  if (!xAgentPanel) return;
  requestAnimationFrame(() => {
    if (!xAgentPanel || !document.body.contains(xAgentPanel)) return;
    const body = xAgentPanel.querySelector('.dth-x-agent-panel-body');
    if (!body) return;
    const rect = xAgentPanel.getBoundingClientRect();
    const requiredHeight = Math.min(body.scrollHeight || 520, window.innerHeight * 0.72);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUp = spaceBelow < requiredHeight && spaceAbove > spaceBelow;
    xAgentPanel.classList.toggle('dth-panel-up', openUp);
    const bodyWidth = Math.min(340, window.innerWidth - 20);
    const preferredLeft = rect.right - bodyWidth;
    const bodyLeft = Math.max(10, Math.min(
      window.innerWidth - bodyWidth - 10,
      preferredLeft
    ));
    body.style.left = `${bodyLeft - rect.left}px`;
    body.style.right = 'auto';
    xAgentPanel.classList.toggle('dth-panel-align-left', bodyLeft >= rect.left - 1);
    const availableHeight = openUp ? spaceAbove : spaceBelow;
    body.style.maxHeight = `${Math.max(140, availableHeight - 12)}px`;
  });
}

function positionXAgentPanel() {
  if (!xAgentPanel) return;
  if (!xAgentPosition) {
    ['left', 'right', 'top', 'bottom'].forEach(property => {
      xAgentPanel.style.removeProperty(property);
    });
    updateXAgentPanelPlacement();
    return;
  }
  const width = xAgentPanel.offsetWidth || 94;
  const height = xAgentPanel.offsetHeight || 112;
  const storedCenterX = Number(xAgentPosition.centerX);
  const storedCenterY = Number(xAgentPosition.centerY);
  const rawX = Number.isFinite(storedCenterX)
    ? storedCenterX - width / 2
    : Number(xAgentPosition.x) || 8;
  const rawY = Number.isFinite(storedCenterY)
    ? storedCenterY - height / 2
    : Number(xAgentPosition.y) || 8;
  const x = Math.max(8, Math.min(window.innerWidth - width - 8, rawX));
  const y = Math.max(8, Math.min(window.innerHeight - height - 8, rawY));
  Object.assign(xAgentPanel.style, {
    left: `${x}px`,
    top: `${y}px`,
    right: 'auto',
    bottom: 'auto'
  });
  updateXAgentPanelPlacement();
}

function setupXAgentDrag(trigger) {
  let drag = null;
  trigger.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = xAgentPanel.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false
    };
    trigger.setPointerCapture(event.pointerId);
  });
  trigger.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(
      event.clientX - drag.startX,
      event.clientY - drag.startY
    ) < 5) return;

    event.preventDefault();
    drag.moved = true;
    xAgentPanel.classList.add('is-dragging');
    xAgentPanel.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    const width = xAgentPanel.offsetWidth || 94;
    const height = xAgentPanel.offsetHeight || 112;
    const x = Math.max(8, Math.min(
      window.innerWidth - width - 8,
      event.clientX - drag.offsetX
    ));
    const y = Math.max(8, Math.min(
      window.innerHeight - height - 8,
      event.clientY - drag.offsetY
    ));
    xAgentPosition = {
      centerX: x + width / 2,
      centerY: y + height / 2
    };
    Object.assign(xAgentPanel.style, {
      left: `${x}px`,
      top: `${y}px`,
      right: 'auto',
      bottom: 'auto'
    });
    updateXAgentPanelPlacement();
  });
  const finish = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    xAgentPanel.classList.remove('is-dragging');
    try { trigger.releasePointerCapture(event.pointerId); } catch { }
    if (!moved) return;
    xAgentSuppressClick = true;
    setTimeout(() => { xAgentSuppressClick = false; }, 0);
    chrome.storage.local.set({ [X_AGENT_POSITION_KEY]: xAgentPosition });
  };
  trigger.addEventListener('pointerup', finish);
  trigger.addEventListener('pointercancel', finish);
}

const X_AGENT_NUMBER_RULES = {
  xAgentRunCount: { min: 1, max: 20, fallback: 3 },
  xAgentMemoryLimit: { min: 0, max: 50, fallback: 8 },
  xAgentDelayMinSeconds: { min: 5, max: 600, fallback: 30 },
  xAgentDelayMaxSeconds: { min: 5, max: 600, fallback: 90 }
};

function scheduleXAgentSettingSave(key, value, delay = 250) {
  if (!STATE.settings) STATE.settings = {};
  STATE.settings[key] = value;
  xAgentPendingSettings[key] = value;
  clearTimeout(xAgentSettingsSaveTimer);
  xAgentSettingsSaveTimer = setTimeout(async () => {
    const payload = xAgentPendingSettings;
    xAgentPendingSettings = {};
    xAgentSettingsSaveTimer = null;
    try {
      await chrome.storage.sync.set(payload);
    } catch (error) {
      console.error('[DTH X Agent] settings save failed:', error);
    }
  }, delay);
  updateXAgentPanel();
  updateXAgentAutoSendControls();
}

function normalizeXAgentNumber(key, rawValue) {
  const rule = X_AGENT_NUMBER_RULES[key];
  const text = String(rawValue ?? '').trim();
  const parsed = text === '' ? NaN : Number(text);
  const value = Number.isFinite(parsed) ? Math.round(parsed) : rule.fallback;
  return Math.max(rule.min, Math.min(rule.max, value));
}

function normalizeXAgentDelayPair() {
  if (!xAgentPanel) return;
  const minControl = xAgentPanel.querySelector(
    '[data-x-agent-setting="xAgentDelayMinSeconds"]'
  );
  const maxControl = xAgentPanel.querySelector(
    '[data-x-agent-setting="xAgentDelayMaxSeconds"]'
  );
  if (!minControl || !maxControl) return;
  let min = normalizeXAgentNumber('xAgentDelayMinSeconds', minControl.value);
  let max = normalizeXAgentNumber('xAgentDelayMaxSeconds', maxControl.value);
  if (min > max) [min, max] = [max, min];
  minControl.value = String(min);
  maxControl.value = String(max);
  scheduleXAgentSettingSave('xAgentDelayMinSeconds', min, 0);
  scheduleXAgentSettingSave('xAgentDelayMaxSeconds', max, 0);
}

function bindXAgentSetting(control, key) {
  control.dataset.xAgentSetting = key;
  if (control.type === 'checkbox') {
    control.addEventListener('change', () => {
      scheduleXAgentSettingSave(key, control.checked, 0);
    });
    return;
  }
  if (control.type === 'number') {
    control.addEventListener('input', () => {
      if (control.value.trim() === '') return;
      scheduleXAgentSettingSave(key, normalizeXAgentNumber(key, control.value));
      updateXAgentMemoryHint();
    });
    control.addEventListener('change', () => {
      if (key === 'xAgentDelayMinSeconds' || key === 'xAgentDelayMaxSeconds') {
        normalizeXAgentDelayPair();
        return;
      }
      const value = normalizeXAgentNumber(key, control.value);
      control.value = String(value);
      scheduleXAgentSettingSave(key, value, 0);
      updateXAgentMemoryHint();
    });
    return;
  }
  control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => {
    scheduleXAgentSettingSave(key, control.value, control.tagName === 'SELECT' ? 0 : 400);
  });
}

function createXAgentSettingField(labelText, control, hintText) {
  const field = document.createElement('label');
  field.className = 'dth-x-agent-setting-field';
  const label = document.createElement('span');
  label.className = 'dth-x-agent-setting-label';
  label.textContent = labelText;
  field.append(label, control);
  if (hintText) {
    const hint = document.createElement('small');
    hint.className = 'dth-x-agent-setting-hint';
    hint.textContent = hintText;
    field.appendChild(hint);
  }
  return field;
}

function createXAgentNumberSetting(key, labelText, hintText) {
  const rule = X_AGENT_NUMBER_RULES[key];
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(rule.min);
  input.max = String(rule.max);
  input.step = '1';
  input.className = 'dth-x-agent-setting-input';
  bindXAgentSetting(input, key);
  return createXAgentSettingField(labelText, input, hintText);
}

function createXAgentToggleSetting(key, labelText) {
  const label = document.createElement('label');
  label.className = 'dth-x-agent-setting-toggle';
  const text = document.createElement('span');
  text.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'checkbox';
  bindXAgentSetting(input, key);
  const track = document.createElement('span');
  track.className = 'dth-x-agent-setting-toggle-track';
  label.append(text, input, track);
  return label;
}

function updateXAgentMemoryHint() {
  if (!xAgentPanel) return;
  const hint = xAgentPanel.querySelector('.dth-x-agent-memory-hint');
  const input = xAgentPanel.querySelector('[data-x-agent-setting="xAgentMemoryLimit"]');
  if (!hint || !input) return;
  const count = normalizeXAgentNumber('xAgentMemoryLimit', input.value);
  hint.textContent = count === 0
    ? 'Memory disabled'
    : `~${(count * 100).toLocaleString()}–${(count * 400).toLocaleString()} extra tokens`;
}

function syncXAgentSettingsControls() {
  if (!xAgentPanel || !STATE.settings) return;
  xAgentPanel.querySelectorAll('[data-x-agent-setting]').forEach(control => {
    if (document.activeElement === control) return;
    const key = control.dataset.xAgentSetting;
    const value = STATE.settings[key];
    if (control.type === 'checkbox') control.checked = value === true;
    else if (value !== undefined && value !== null) control.value = String(value);
  });
  updateXAgentMemoryHint();
}

function createXAgentSettingsSection() {
  const section = document.createElement('section');
  section.className = 'dth-x-agent-settings';

  const heading = document.createElement('div');
  heading.className = 'dth-x-agent-settings-heading';
  const headingText = document.createElement('strong');
  headingText.textContent = 'Agent settings';
  const autoSaved = document.createElement('span');
  autoSaved.textContent = 'Auto-saved';
  heading.append(headingText, autoSaved);

  const provider = document.createElement('select');
  provider.className = 'dth-x-agent-setting-input';
  [
    ['openrouter', 'OpenRouter'],
    ['chatgpt', 'ChatGPT subscription']
  ].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    provider.appendChild(option);
  });
  bindXAgentSetting(provider, 'xAgentProvider');

  const toggles = document.createElement('div');
  toggles.className = 'dth-x-agent-settings-toggles';
  toggles.append(
    createXAgentToggleSetting('xAgentAutoSubmit', 'Auto send'),
    createXAgentToggleSetting('xAgentSoundEnabled', 'Sound'),
    createXAgentToggleSetting('xAgentNotifyEnabled', 'Notification'),
    createXAgentToggleSetting('xAgentOpenReport', 'Open report')
  );

  const numbers = document.createElement('div');
  numbers.className = 'dth-x-agent-settings-grid';
  numbers.append(
    createXAgentNumberSetting('xAgentRunCount', 'Posts per run'),
    createXAgentNumberSetting('xAgentMemoryLimit', 'Memory examples')
  );

  const memoryHint = document.createElement('small');
  memoryHint.className = 'dth-x-agent-memory-hint';

  const delays = document.createElement('div');
  delays.className = 'dth-x-agent-settings-grid';
  delays.append(
    createXAgentNumberSetting('xAgentDelayMinSeconds', 'Delay min, sec'),
    createXAgentNumberSetting('xAgentDelayMaxSeconds', 'Delay max, sec')
  );

  const prompt = document.createElement('textarea');
  prompt.rows = 4;
  prompt.className = 'dth-x-agent-setting-input dth-x-agent-setting-prompt';
  bindXAgentSetting(prompt, 'xAgentPrompt');

  const utilityActions = document.createElement('div');
  utilityActions.className = 'dth-x-agent-settings-utilities';

  const resetPosition = document.createElement('button');
  resetPosition.type = 'button';
  resetPosition.textContent = 'Reset position';
  resetPosition.addEventListener('click', async () => {
    xAgentPosition = null;
    await chrome.storage.local.remove(X_AGENT_POSITION_KEY);
    positionXAgentPanel();
  });

  const openReport = document.createElement('button');
  openReport.type = 'button';
  openReport.textContent = 'Open report';
  openReport.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'openXAgentReport' });
  });

  const resetMemory = document.createElement('button');
  resetMemory.type = 'button';
  resetMemory.className = 'is-danger';
  resetMemory.textContent = 'Reset memory';
  resetMemory.addEventListener('click', async () => {
    if (!confirm('Reset all X Agent memory?')) return;
    await chrome.storage.local.remove('xAgentFeedback');
    resetMemory.textContent = 'Memory reset';
    setTimeout(() => { resetMemory.textContent = 'Reset memory'; }, 1400);
  });

  utilityActions.append(resetPosition, openReport, resetMemory);
  section.append(
    heading,
    createXAgentSettingField('Provider', provider),
    toggles,
    numbers,
    memoryHint,
    delays,
    createXAgentSettingField(
      'Agent prompt',
      prompt,
      'Tone, language, length, emojis, and what to avoid.'
    ),
    utilityActions
  );
  return section;
}

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

// --- X Reply Agent ---

function clearXAgentButtons() {
  document.querySelectorAll(`.${X_AGENT_CONTROL_CLASS}`).forEach(el => el.remove());
  document.querySelectorAll(`.${X_AGENT_BUTTON_CLASS}`).forEach(el => el.remove());
  document.querySelectorAll(`.${X_AGENT_ACTIVE_CLASS}`).forEach(el => el.classList.remove(X_AGENT_ACTIVE_CLASS));
  if (xAgentPanel) {
    xAgentPanel.remove();
    xAgentPanel = null;
  }
  stopXAgentAnimation();
}

function setAgentButtonState(btn, state, title) {
  if (!btn) return;
  btn.dataset.state = state;
  if (state === 'idle') btn.textContent = '✦ AI';
  if (state === 'thinking') btn.textContent = '…';
  if (state === 'draft') btn.textContent = 'Draft';
  if (state === 'sent') btn.textContent = 'Sent';
  if (state === 'error') btn.textContent = 'Error';
  if (title) btn.title = title;
}

async function openReplyComposer(article) {
  const before = new Set(Array.from(document.querySelectorAll(COMPOSE_SELECTORS.join(','))));
  const replyBtn = findReplyButton(article);
  if (!replyBtn) throw new Error('Reply button not found.');
  replyBtn.click();
  const compose = await waitForReplyCompose(before);
  if (!compose) throw new Error('Reply composer not found.');
  STATE.activeCompose = compose;
  return compose;
}

async function maybeSubmitReply(compose) {
  if (!STATE.settings || STATE.settings.xAgentAutoSubmit !== true) return false;
  if (xAgentRunning) await waitWhileXAgentPaused();
  if (xAgentRunning && xAgentStopRequested) return false;
  await sleep(350);
  const root = compose.closest('[role="dialog"]') || compose.closest('form') || document;
  const submit = await waitForSubmitButton(root);
  if (!submit) throw new Error('Submit button not found.');
  submit.click();
  return true;
}

async function runXAgentReply(article, btn, options = {}) {
  if (!STATE.settings || STATE.settings.xAgentEnabled !== true) return;
  if (btn && btn.dataset.state === 'thinking') return;

  xAgentActiveJobs++;
  updateXAgentPanel('Generating reply');
  document.querySelectorAll(`.${X_AGENT_ACTIVE_CLASS}`).forEach(el => {
    if (el !== article) el.classList.remove(X_AGENT_ACTIVE_CLASS);
  });
  article.classList.add(X_AGENT_ACTIVE_CLASS);
  setAgentButtonState(btn, 'thinking', 'Generating reply...');

  const payload = getTweetPayload(article);
  try {
    if (!payload.text) throw new Error('Tweet text not found.');
    const resp = await callBackground({ type: 'xAgentReply', tweet: payload });
    const reply = String(resp.reply || '').trim();
    if (!reply) throw new Error('Empty AI reply.');

    const compose = await openReplyComposer(article);
    await replaceComposeText(compose, reply);
    const sent = await maybeSubmitReply(compose);
    article.setAttribute(X_AGENT_PROCESSED_ATTR, sent ? 'sent' : 'draft');
    await incrementXAgentTodayReplies().catch(() => {});
    if (!options.silent) playAgentSound(sent ? 'sent' : 'ready');
    setAgentButtonState(btn, sent ? 'sent' : 'draft', sent ? 'Reply sent.' : 'Reply inserted as a draft.');
    setTimeout(() => setAgentButtonState(btn, 'idle'), sent ? 2500 : 3500);
    return { ok: true, sent, reply, tweet: payload };
  } catch (e) {
    console.error('[DTH X Agent] error:', e);
    if (!options.silent) playAgentSound('ready');
    setAgentButtonState(btn, 'error', (t('errorPrefix') || 'Error: ') + e.message);
    setTimeout(() => setAgentButtonState(btn, 'idle'), 3500);
    if (options.throwOnError) throw e;
    return { ok: false, error: e.message || String(e), tweet: payload };
  } finally {
    xAgentActiveJobs = Math.max(0, xAgentActiveJobs - 1);
    updateXAgentPanel(!xAgentRunning && xAgentActiveJobs === 0 ? 'Ready' : undefined);
  }
}

function getFeedCandidates() {
  return Array.from(document.querySelectorAll(TWEET_SELECTOR))
    .filter(article => isVisible(article))
    .filter(article => !article.hasAttribute(X_AGENT_PROCESSED_ATTR))
    .filter(article => !!getTweetText(article))
    .filter(article => !isPromotedTweet(article))
    .filter(article => !!findReplyButton(article))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function updateXAgentPanel(statusText) {
  if (statusText) xAgentPanelStatus = statusText;
  if (!xAgentPanel) return;
  const previousState = xAgentPanel.dataset.state;
  const status = xAgentPanel.querySelector('.dth-x-agent-panel-status-value');
  const statusDot = xAgentPanel.querySelector('.dth-x-agent-panel-status-dot');
  const next = xAgentPanel.querySelector('.dth-x-agent-panel-next-value');
  const today = xAgentPanel.querySelector('.dth-x-agent-panel-today-value');
  const compactIndicator = xAgentPanel.querySelector('.dth-x-agent-panel-compact-indicator');
  const compactCount = xAgentPanel.querySelector('.dth-x-agent-panel-compact-count');
  const compactNext = xAgentPanel.querySelector('.dth-x-agent-panel-compact-next');
  const start = xAgentPanel.querySelector('.dth-x-agent-panel-start');
  const pause = xAgentPanel.querySelector('.dth-x-agent-panel-pause');
  const stop = xAgentPanel.querySelector('.dth-x-agent-panel-stop');

  let state = 'idle';
  let label = xAgentPanelStatus || 'Ready';
  if (xAgentRunning && xAgentStopRequested) {
    state = 'stopping';
    label = 'Stopping';
  } else if (xAgentRunning && xAgentPaused) {
    state = 'paused';
    label = 'Paused';
  } else if (xAgentRunning) {
    state = 'running';
    label = 'Running';
  } else if (xAgentActiveJobs > 0) {
    state = 'running';
    label = 'Generating';
  } else if (/^done/i.test(label)) {
    state = 'done';
    label = 'Completed';
  } else if (/^stopped/i.test(label)) {
    state = 'stopped';
    label = 'Stopped';
  }

  const nextText = xAgentNextReplyMs === null
    ? '—'
    : `${Math.max(0, xAgentNextReplyMs / 1000).toFixed(1)} s`;
  if (status) status.textContent = label;
  if (statusDot) statusDot.dataset.state = state;
  if (compactIndicator) {
    compactIndicator.textContent = state === 'running'
      ? '🟢'
      : state === 'paused'
        ? '🟡'
        : state === 'stopping'
          ? '🔴'
          : '⚪';
  }
  if (next) next.textContent = nextText;
  if (today) today.textContent = String(xAgentTodayReplies);
  if (compactCount) compactCount.textContent = String(xAgentTodayReplies);
  if (compactNext) compactNext.textContent = xAgentNextReplyMs === null
    ? '—'
    : `${Math.max(0, xAgentNextReplyMs / 1000).toFixed(1)}s`;
  if (start) {
    start.disabled = xAgentRunning;
    start.textContent = `▶ Start ${getAgentRunLimit()}`;
  }
  if (pause) {
    pause.disabled = !xAgentRunning || xAgentStopRequested;
    pause.textContent = xAgentPaused ? '▶ Resume' : 'Ⅱ Pause';
  }
  if (stop) stop.disabled = !xAgentRunning;
  xAgentPanel.dataset.state = state;
  xAgentPanel.classList.toggle('is-running', xAgentRunning);
  updateXAgentAnimation(state);
  if (previousState !== state) requestAnimationFrame(positionXAgentPanel);
}

async function waitWhileXAgentPaused() {
  while (xAgentPaused && !xAgentStopRequested) {
    updateXAgentPanel();
    await sleep(200);
  }
}

async function waitForAgentDelay(ms, done, limit) {
  let remaining = ms;
  xAgentNextReplyMs = remaining;
  updateXAgentPanel(`Waiting · ${done}/${limit}`);
  while (!xAgentStopRequested && remaining > 0) {
    if (xAgentPaused) {
      await waitWhileXAgentPaused();
      continue;
    }
    const step = Math.min(100, remaining);
    const started = Date.now();
    await sleep(step);
    remaining = Math.max(0, remaining - (Date.now() - started));
    xAgentNextReplyMs = remaining;
    updateXAgentPanel();
  }
  xAgentNextReplyMs = null;
  updateXAgentPanel();
}

function toReportItem(result) {
  const tweet = result?.tweet || {};
  return {
    status: result?.ok ? (result.sent ? 'sent' : 'draft') : 'error',
    author: tweet.author || '',
    url: tweet.url || '',
    postText: tweet.text || '',
    reply: result?.reply || '',
    error: result?.error || ''
  };
}

async function runXFeedAgent() {
  if (xAgentRunning || !STATE.settings || STATE.settings.xAgentEnabled !== true) return;
  const limit = getAgentRunLimit();
  xAgentRunning = true;
  xAgentStopRequested = false;
  xAgentPaused = false;
  xAgentNextReplyMs = null;
  ensureXAgentPanel();
  updateXAgentPanel(`Running 0/${limit}`);

  let done = 0;
  let attempts = 0;
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    while (!xAgentStopRequested && done < limit && attempts < limit * 3) {
      await waitWhileXAgentPaused();
      if (xAgentStopRequested) break;
      let candidates = getFeedCandidates();
      if (!candidates.length) {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.82), behavior: 'smooth' });
        await sleep(1300);
        candidates = getFeedCandidates();
        if (!candidates.length) break;
      }

      const article = candidates.find(a => a.getBoundingClientRect().top > 60) || candidates[0];
      article.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(650);

      const btn = article.querySelector(`.${X_AGENT_BUTTON_CLASS}`);
      const result = await runXAgentReply(article, btn, { throwOnError: false, silent: true });
      attempts++;
      results.push(toReportItem(result));
      if (result && result.ok) done++;
      else article.setAttribute(X_AGENT_PROCESSED_ATTR, 'error');
      updateXAgentPanel(`Running ${done}/${limit}`);
      if (!STATE.settings.xAgentAutoSubmit) {
        updateXAgentPanel('Draft ready · Auto send off');
        break;
      }

      if (result && result.ok && done < limit && !xAgentStopRequested) {
        await waitForAgentDelay(getRandomAgentDelayMs(), done, limit);
      }
      if (xAgentStopRequested) break;
      window.scrollBy({ top: Math.round(window.innerHeight * 0.72), behavior: 'smooth' });
      await sleep(900);
    }
  } finally {
    xAgentRunning = false;
    xAgentPaused = false;
    xAgentNextReplyMs = null;
    updateXAgentPanel(xAgentStopRequested ? `Stopped ${done}/${limit}` : `Done ${done}/${limit}`);
    if (!xAgentStopRequested) playAgentSound('complete');

    const sent = results.filter(item => item.status === 'sent').length;
    const drafts = results.filter(item => item.status === 'draft').length;
    const errors = results.filter(item => item.status === 'error').length;
    const delay = getAgentDelayRange();
    callBackground({
      type: 'xAgentRunComplete',
      report: {
        startedAt,
        finishedAt: new Date().toISOString(),
        requested: limit,
        completed: done,
        sent,
        drafts,
        errors,
        stopped: xAgentStopRequested,
        provider: STATE.settings.xAgentProvider === 'chatgpt' ? 'chatgpt' : 'openrouter',
        delayMinSeconds: delay.min,
        delayMaxSeconds: delay.max,
        items: results
      }
    }).catch(e => console.debug('[DTH X Agent] report failed', e));
  }
}

function ensureXAgentPanel() {
  if (!STATE.settings || STATE.settings.xAgentEnabled !== true) {
    if (xAgentPanel) {
      xAgentPanel.remove();
      xAgentPanel = null;
    }
    stopXAgentAnimation();
    return;
  }
  if (xAgentPanel && document.body.contains(xAgentPanel)) {
    updateXAgentPanel();
    return;
  }

  const panel = document.createElement('div');
  panel.className = X_AGENT_PANEL_CLASS;
  panel.tabIndex = 0;
  panel.setAttribute('aria-label', 'X Auto Reply controls');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dth-x-agent-mascot';
  trigger.setAttribute('aria-label', 'Open X Auto Reply controls');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'dth-x-agent-panel-body');
  setupXAgentDrag(trigger);
  trigger.addEventListener('pointerenter', updateXAgentPanelPlacement);

  const createMascotVideo = mode => {
    const video = document.createElement('video');
    video.className = 'dth-x-agent-mascot-video';
    video.dataset.animation = mode;
    video.src = X_AGENT_ANIMATION_VIDEOS[mode];
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    return video;
  };
  const idleVideo = createMascotVideo('idle');
  const workingVideo = createMascotVideo('working');

  const compact = document.createElement('span');
  compact.className = 'dth-x-agent-panel-compact';

  const compactIndicator = document.createElement('span');
  compactIndicator.className = 'dth-x-agent-panel-compact-indicator';
  compactIndicator.textContent = '⚪';

  const compactCount = document.createElement('strong');
  compactCount.className = 'dth-x-agent-panel-compact-count';
  compactCount.textContent = String(xAgentTodayReplies);

  const compactDivider = document.createElement('span');
  compactDivider.className = 'dth-x-agent-panel-compact-divider';
  compactDivider.textContent = '|';

  const compactNext = document.createElement('span');
  compactNext.className = 'dth-x-agent-panel-compact-next';
  compactNext.textContent = '—';
  compact.append(compactIndicator, compactCount, compactDivider, compactNext);
  trigger.append(idleVideo, workingVideo, compact);
  trigger.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (xAgentSuppressClick) return;
    const open = panel.classList.toggle('is-open');
    trigger.setAttribute('aria-expanded', String(open));
    updateXAgentPanelPlacement();
  });

  const body = document.createElement('div');
  body.id = 'dth-x-agent-panel-body';
  body.className = 'dth-x-agent-panel-body';

  const header = document.createElement('div');
  header.className = 'dth-x-agent-panel-header';

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'dth-x-agent-panel-title';
  title.textContent = '🤖 Auto Reply';
  const dragHint = document.createElement('small');
  dragHint.className = 'dth-x-agent-panel-drag-hint';
  dragHint.textContent = 'Drag the character to move';
  titleWrap.append(title, dragHint);

  const disable = document.createElement('button');
  disable.type = 'button';
  disable.className = 'dth-x-agent-panel-close';
  disable.textContent = '×';
  disable.title = 'Disable X Agent';
  disable.setAttribute('aria-label', 'Disable X Agent');
  disable.addEventListener('click', async () => {
    xAgentStopRequested = true;
    xAgentPaused = false;
    if (STATE.settings) STATE.settings.xAgentEnabled = false;
    await chrome.storage.sync.set({ xAgentEnabled: false });
    clearXAgentButtons();
  });
  header.append(titleWrap, disable);

  const createMetric = (labelText, valueClass) => {
    const row = document.createElement('div');
    row.className = 'dth-x-agent-panel-metric';
    const label = document.createElement('span');
    label.className = 'dth-x-agent-panel-label';
    label.textContent = labelText;
    const value = document.createElement('span');
    value.className = valueClass;
    row.append(label, value);
    return { row, value };
  };

  const statusMetric = createMetric('Status', 'dth-x-agent-panel-status-wrap');
  const statusDot = document.createElement('span');
  statusDot.className = 'dth-x-agent-panel-status-dot';
  statusDot.dataset.state = 'idle';
  const statusValue = document.createElement('strong');
  statusValue.className = 'dth-x-agent-panel-status-value';
  statusValue.textContent = 'Ready';
  statusMetric.value.append(statusDot, statusValue);

  const nextMetric = createMetric('Next reply', 'dth-x-agent-panel-next-value');
  nextMetric.row.classList.add('dth-x-agent-panel-timer');
  nextMetric.value.textContent = '—';

  const todayMetric = createMetric('Today’s replies', 'dth-x-agent-panel-today-value');
  todayMetric.value.textContent = String(xAgentTodayReplies);

  const divider = document.createElement('div');
  divider.className = 'dth-x-agent-panel-divider';

  const actions = document.createElement('div');
  actions.className = 'dth-x-agent-panel-actions';

  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'dth-x-agent-panel-start';
  start.textContent = `▶ Start ${getAgentRunLimit()}`;
  start.addEventListener('click', () => runXFeedAgent());

  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'dth-x-agent-panel-pause';
  pause.textContent = 'Ⅱ Pause';
  pause.addEventListener('click', () => {
    if (!xAgentRunning || xAgentStopRequested) return;
    xAgentPaused = !xAgentPaused;
    updateXAgentPanel();
  });

  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'dth-x-agent-panel-stop';
  stop.textContent = '■ Stop';
  stop.addEventListener('click', () => {
    xAgentStopRequested = true;
    xAgentPaused = false;
    updateXAgentPanel('Stopping…');
  });

  actions.append(start, pause, stop);
  const settings = createXAgentSettingsSection();
  body.append(
    header,
    statusMetric.row,
    nextMetric.row,
    todayMetric.row,
    divider,
    actions,
    settings
  );
  panel.append(trigger, body);
  document.body.appendChild(panel);
  xAgentPanel = panel;
  positionXAgentPanel();
  syncXAgentSettingsControls();
  updateXAgentPanel();
}

function updateXAgentAutoSendControls() {
  const enabled = STATE.settings?.xAgentAutoSubmit === true;
  document.querySelectorAll(`.${X_AGENT_CONTROL_CLASS}`).forEach(control => {
    const checkbox = control.querySelector('.dth-x-agent-auto-checkbox');
    const status = control.querySelector('.dth-x-agent-auto-status');
    if (checkbox) checkbox.checked = enabled;
    if (status) status.textContent = enabled ? 'On' : 'Off';
  });
}

function createXAgentControl(article) {
  const control = document.createElement('span');
  control.className = X_AGENT_CONTROL_CLASS;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = X_AGENT_BUTTON_CLASS;
  btn.textContent = '✦ AI';
  btn.title = 'Analyze this post and write a reply';
  btn.dataset.state = 'idle';
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await runXAgentReply(article, btn);
  });

  const menu = document.createElement('span');
  menu.className = 'dth-x-agent-hover-menu';
  menu.addEventListener('click', e => e.stopPropagation());
  menu.addEventListener('mousedown', e => e.stopPropagation());

  const label = document.createElement('label');
  label.className = 'dth-x-agent-auto-row';

  const text = document.createElement('span');
  text.textContent = 'Auto send';

  const status = document.createElement('span');
  status.className = 'dth-x-agent-auto-status';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'dth-x-agent-auto-checkbox';
  checkbox.checked = STATE.settings?.xAgentAutoSubmit === true;
  status.textContent = checkbox.checked ? 'On' : 'Off';
  checkbox.addEventListener('change', async () => {
    const enabled = checkbox.checked;
    if (STATE.settings) STATE.settings.xAgentAutoSubmit = enabled;
    updateXAgentAutoSendControls();
    await chrome.storage.sync.set({ xAgentAutoSubmit: enabled });
  });

  label.append(text, status, checkbox);
  menu.appendChild(label);
  control.append(btn, menu);
  return control;
}

function ensureXAgentButtons() {
  if (!STATE.settings || STATE.settings.xAgentEnabled !== true) {
    clearXAgentButtons();
    return;
  }

  let added = 0;
  for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
    if (added >= 12) break;
    if (!isVisible(article) || article.querySelector(`.${X_AGENT_BUTTON_CLASS}`)) continue;
    const rect = article.getBoundingClientRect();
    if (rect.bottom < -400 || rect.top > window.innerHeight + 900) continue;
    const text = getTweetText(article);
    if (!text || text.length < 2) continue;
    if (isPromotedTweet(article)) continue;
    const group = findTweetActionGroup(article);
    if (!group) continue;

    const control = createXAgentControl(article);

    const reply = findReplyButton(article);
    const anchor = reply && reply.parentElement ? reply.parentElement : null;
    if (anchor && anchor.parentElement === group) {
      anchor.insertAdjacentElement('afterend', control);
    } else {
      group.appendChild(control);
    }
    added++;
  }
  ensureXAgentPanel();
}

function scheduleXAgentScan(delay = 900) {
  if (!STATE.settings || STATE.settings.xAgentEnabled !== true) return;
  if (xAgentScanTimer) return;
  xAgentScanTimer = setTimeout(() => {
    xAgentScanTimer = null;
    try { ensureXAgentButtons(); } catch (e) { console.debug('[DTH X Agent] scan failed', e); }
  }, delay);
}

// --- React to settings changes ---

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const uiLangChanged = changes.uiLang !== undefined;
  loadSettings().then(() => {
    if (STATE.settings && STATE.settings.xAgentEnabled === true) {
      ensureXAgentPanel();
      syncXAgentSettingsControls();
      scheduleXAgentScan(250);
      updateXAgentAutoSendControls();
    } else {
      xAgentStopRequested = true;
      clearXAgentButtons();
    }
    if (uiLangChanged) populateDropdown();
    refreshButtonLabel();
    if (inputMainBtn) inputMainBtn.title = t('translateInputTitle') || 'Translate what I typed';
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'xAgentStart') {
    loadSettings().then(() => {
      ensureXAgentPanel();
      syncXAgentSettingsControls();
      runXFeedAgent();
      sendResponse({ ok: true });
    }).catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (msg && msg.type === 'xAgentRefresh') {
    loadSettings().then(() => {
      ensureXAgentPanel();
      syncXAgentSettingsControls();
      scheduleXAgentScan(50);
      sendResponse({ ok: true });
    }).catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (msg && msg.type === 'localeChanged') {
    overrideMessages = msg.messages || null;
    populateDropdown();
    refreshButtonLabel();
    if (inputMainBtn) inputMainBtn.title = t('translateInputTitle') || 'Translate what I typed';
  }
});

document.addEventListener('pointerdown', event => {
  if (!xAgentPanel || xAgentPanel.contains(event.target)) return;
  xAgentPanel.classList.remove('is-open');
  const trigger = xAgentPanel.querySelector('.dth-x-agent-mascot');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !xAgentPanel) return;
  xAgentPanel.classList.remove('is-open');
  const trigger = xAgentPanel.querySelector('.dth-x-agent-mascot');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus({ preventScroll: true });
  }
});

window.addEventListener('resize', positionXAgentPanel);

// --- Init ---

loadSettings().then(() => {
  setupButton();
  if (STATE.settings && STATE.settings.xAgentEnabled === true) {
    ensureXAgentPanel();
    scheduleXAgentScan(1200);
  }
});

// X — SPA, перерисовывает много, следим за DOM и обновляем позицию.
const observer = new MutationObserver(() => {
  positionButton();
  scheduleXAgentScan(1000);
});
observer.observe(document.body, { childList: true, subtree: true });
