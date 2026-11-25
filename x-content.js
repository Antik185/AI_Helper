// X (Twitter) content script.
// Добавляет плавающую кнопку перевода у поля написания поста/комментария.
// При клике переводит набранный текст на язык из настроек.
// Стрелка справа открывает выпадашку для быстрой смены целевого языка.

console.log('[DTH X] content script loaded on', location.href);

const COMPOSE_SELECTORS = [
  'form textarea[aria-multiline="true"][aria-autocomplete="list"]',
  'div[data-testid^="tweetTextarea_"][contenteditable="true"]',
  // Запасные варианты на случай редизайна:
  'div[role="textbox"][contenteditable="true"][data-testid*="tweetTextarea"]',
  'div[contenteditable="true"][data-block-editor-block-type="text"]'
];

const TWEET_SELECTOR = 'article[data-testid="tweet"], article:has([data-engagement-action="reply"])';
const X_EMBEDDED_POST_SELECTOR = '[data-slot="embedded-tweet-frame"]';
const X_AGENT_BUTTON_CLASS = 'dth-x-agent-btn';
const X_AGENT_CONTROL_CLASS = 'dth-x-agent-control';
const X_AGENT_ACTIVE_CLASS = 'dth-x-agent-active';
const X_AGENT_PANEL_CLASS = 'dth-x-agent-panel';
const X_AGENT_PROCESSED_ATTR = 'data-dth-x-agent-done';
const X_AGENT_PROCESSED_POSTS_KEY = 'xAgentProcessedPosts';
const X_AGENT_MAX_PROCESSED_POSTS = 1000;
const X_POST_TRANSLATE_BUTTON_CLASS = 'dth-x-post-translate-btn';
const X_POST_TRANSLATION_CLASS = 'dth-x-post-translation';
const X_POST_BODY_SELECTOR = '[data-testid="tweetText"], [dir="auto"].whitespace-pre-wrap';
const X_POST_ARTICLE_TITLE_SELECTOR = 'a :is(h1, div).font-article.line-clamp-3';
const X_RELATIONSHIP_TARGET_CLASS = 'dth-x-relationship-target';
const X_RELATIONSHIP_ACTION_CLASS = 'dth-x-relationship-native-action';
const X_RELATIONSHIP_AUTHORS_KEY = 'xRelationshipAuthors';
const X_RELATIONSHIP_SESSION_KEY = 'xRelationshipSession';
const X_RELATIONSHIP_PROFILE_SCAN_MODE = new URLSearchParams(location.search).get('dth_crm_scan') === '1';
const X_FOLLOWS_BACK_LABELS = new Set([
  'follows you', 'читает вас', 'подписан на вас', 'подписана на вас',
  'читає вас', 'folgt dir', 'vous suit', 'te sigue', 'segue você',
  'seni takip ediyor', 'obserwuje cię', 'يتابعك', '关注了你',
  'フォローされています', 'ti segue', 'volgt jou', '나를 팔로우합니다'
]);

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
let xPostTranslateScanTimer = null;
const xPostTranslationStates = new Map();

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
      X_AGENT_POSITION_KEY,
      X_AGENT_PROCESSED_POSTS_KEY
    ]);
    STATE.customPosition = local[POSITION_KEY] || null;
    xAgentPosition = local[X_AGENT_POSITION_KEY] || null;
    applyXAgentProcessedPosts(local[X_AGENT_PROCESSED_POSTS_KEY]);
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
    await refreshXRelationshipState(false);
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
  if (ae?.matches && isAvailableXCompose(ae)) {
    for (const sel of COMPOSE_SELECTORS) {
      if (ae.matches(sel)) return ae;
    }
  }
  // Иначе возвращаем последний известный (если он ещё в DOM).
  if (isAvailableXCompose(STATE.activeCompose)) {
    return STATE.activeCompose;
  }
  // На крайний случай — первый видимый composer на странице.
  for (const sel of COMPOSE_SELECTORS) {
    const el = Array.from(document.querySelectorAll(sel)).find(isAvailableXCompose);
    if (el) return el;
  }
  return null;
}

function getFocusedXCompose() {
  const active = document.activeElement;
  if (!active?.matches) return null;
  return COMPOSE_SELECTORS.some(selector => active.matches(selector)) ? active : null;
}

function getXReplyRoutePostId() {
  return location.pathname === '/compose/post'
    ? getXPostId(new URLSearchParams(location.search).get('in_reply_to'))
    : '';
}

function isAvailableXCompose(compose) {
  return !!compose?.isConnected && isVisible(compose) && !compose.disabled && !compose.readOnly
    && !compose.closest('[hidden], [inert], [aria-hidden="true"]');
}

function isReusableXReplyCompose(compose, article) {
  if (!article || !isAvailableXCompose(compose)) return false;
  const articlePostId = getXPostId(getTweetUrl(article));
  if (!articlePostId) return false;
  const replyPostId = getXReplyRoutePostId();
  const dialog = compose.closest('[role="dialog"]');
  if (replyPostId) return !!dialog && replyPostId === articlePostId;
  if (dialog) return false;
  if (article.contains(compose)) return true;
  return articlePostId === getXPostId(location.href) && !!findSubmitButton(compose, false);
}

function findExistingReplyComposer(article, preferredCompose = null) {
  return [preferredCompose, getFocusedXCompose(), ...document.querySelectorAll(COMPOSE_SELECTORS.join(','))]
    .find(compose => isReusableXReplyCompose(compose, article)) || null;
}

function readXComposeText(el) {
  return (el?.value ?? el?.textContent ?? '').replace(/[\u200B\uFEFF]/g, '').trim();
}

function composeHasText(el) {
  return !!readXComposeText(el);
}

// --- Slate/Draft text replacement (same approach as Discord) ---

function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => r()));
}

async function replaceComposeText(el, newText) {
  el.focus();
  if (el.matches('textarea')) {
    // Use the native setter so React notices the change when the input event fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, newText);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: newText }));
    return;
  }
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
  const block = findPrimaryTweetTextBlock(article);
  if (block) return getStructuredTweetText(block).trim();
  const title = findXLinkedArticleTitle(article);
  if (title) return title.textContent.trim();
  if (article.querySelector('[data-engagement-action="reply"]')) return '';
  return (article.textContent || '').trim().slice(0, 3000);
}

function getTweetAuthor(article) {
  const meta = getTweetAuthorMeta(article);
  return meta.displayName
    ? `${meta.displayName}${meta.handle ? ` (@${meta.handle})` : ''}`
    : meta.handle ? `@${meta.handle}` : '';
}

function normalizeXHandle(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .replace(/^\/+/, '')
    .split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(raw) ? raw : '';
}

function getTweetAuthorMeta(article) {
  const statusUrl = getTweetUrl(article);
  let handle = '';
  try {
    const match = new URL(statusUrl).pathname.match(/^\/([^/]+)\/status\//i);
    handle = normalizeXHandle(match?.[1]);
  } catch { }
  const header = article.querySelector('[data-testid="User-Name"]');
  const profileLink = Array.from((header || article).querySelectorAll('a[href]')).find(link => {
    if (!isOwnXPostElement(article, link)) return false;
    return /^\/[A-Za-z0-9_]{1,15}\/?$/.test(new URL(link.href, location.href).pathname)
      && (header || normalizeXHandle(link.href).toLowerCase() === handle.toLowerCase())
      && !!link.textContent.trim();
  });
  if (!handle && profileLink) {
    handle = normalizeXHandle(profileLink.href);
  }
  const text = (header?.textContent || profileLink?.textContent || '').trim();
  const displayName = text
    .replace(new RegExp(`@${escapeRegExp(handle)}.*$`, 'i'), '')
    .trim();
  return {
    handle,
    displayName,
    profileUrl: handle ? `https://x.com/${handle}` : ''
  };
}

function isOwnXPostElement(article, element) {
  return element.closest('article') === article && !element.closest(X_EMBEDDED_POST_SELECTOR);
}

function getTweetUrl(article) {
  const card = article.closest('[data-href*="/status/"]');
  const cardPath = card?.getAttribute('data-href');
  if (/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/\d{1,19}$/.test(cardPath || '')) {
    return new URL(cardPath, location.href).href;
  }
  const linkSelector = 'a[href*="/status/"]';
  const links = Array.from(article.querySelectorAll(linkSelector)).filter(link =>
    isOwnXPostElement(article, link) && !link.closest('[data-testid="tweetText"], [dir="auto"].whitespace-pre-wrap')
  );
  const candidates = [...links.filter(link => link.querySelector('time')), ...links];
  for (const { href: candidate } of candidates) {
    if (!URL.canParse(candidate, location.href)) continue;
    const url = new URL(candidate, location.href);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname)) continue;
    const match = url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/\d{1,19}(?=\/|$)/);
    if (match) return url.origin + match[0];
  }
  return '';
}

function getXPostId(value) {
  const match = String(value || '').match(/(?:\/status\/|^)(\d{1,19})(?:[/?#]|$)/);
  return match ? match[1] : '';
}

function normalizeXAgentProcessedPosts(value) {
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set();
  return entries.map(item => {
    const postId = getXPostId(item?.postId || item?.url);
    if (!postId || seen.has(postId)) return null;
    seen.add(postId);
    return {
      postId,
      url: String(item?.url || '').slice(0, 500),
      status: ['sent', 'draft'].includes(item?.status) ? item.status : 'sent',
      processedAt: String(item?.processedAt || '').slice(0, 80) || new Date().toISOString()
    };
  }).filter(Boolean).slice(0, X_AGENT_MAX_PROCESSED_POSTS);
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
  const postId = getXPostId(getTweetUrl(article));
  const controls = article.querySelectorAll(
    '[data-testid="reply"], [data-engagement-action="reply"] :is(a, button, [role="button"]), a[href*="in_reply_to="]'
  );
  return Array.from(controls).find(control => {
    if (!isOwnXPostElement(article, control) || !isEnabledXControl(control)) return false;
    if (!control.matches('a[href]')) return true;
    const url = new URL(control.href, location.href);
    return url.origin === location.origin && url.pathname === '/compose/post'
      && !!postId && url.searchParams.get('in_reply_to') === postId;
  }) || Array.from(article.querySelectorAll('button[aria-label]')).find(button =>
    isOwnXPostElement(article, button) && isEnabledXControl(button)
    && /(?:^|[.!]\s+)(?:reply|ответить)$/iu.test(button.getAttribute('aria-label'))
  ) || null;
}

function findTweetActionGroup(article) {
  const reply = findReplyButton(article);
  if (!reply) return null;
  return reply.closest('[role="group"]') || reply.parentElement?.parentElement || reply.parentElement;
}

function isEnabledXControl(control) {
  return isVisible(control) && !control.disabled
    && control.getAttribute('aria-disabled') !== 'true' && !control.hasAttribute('data-disabled');
}

function findXPostLikeButton(article) {
  if (!article) return null;
  const buttons = article.querySelectorAll(
    '[data-testid="like"], [data-testid="unlike"], [data-engagement-action="like"] :is(button, [role="button"])'
  );
  return Array.from(buttons).find(button => isOwnXPostElement(article, button) && isVisible(button)) || null;
}

function getXPostLiked(button) {
  if (!button) return null;
  const pressed = button.getAttribute('aria-pressed');
  if (pressed === 'true' || pressed === 'false') return pressed === 'true';
  if (button.dataset.testid === 'unlike') return true;
  if (button.dataset.testid === 'like') return false;
  return null;
}

function findPrimaryTweetTextBlock(article) {
  return Array.from(article.querySelectorAll(X_POST_BODY_SELECTOR)).find(block =>
    isOwnXPostElement(article, block)
    && !block.classList.contains(X_POST_TRANSLATION_CLASS)
    && !block.closest('form')
    && !block.matches('[aria-hidden="true"]')
  ) || null;
}

function findXLinkedArticleTitle(article) {
  return Array.from(article.querySelectorAll(X_POST_ARTICLE_TITLE_SELECTOR)).find(title =>
    isOwnXPostElement(article, title) && !title.classList.contains(X_POST_TRANSLATION_CLASS)
  ) || null;
}

function findXPostTranslationSource(article) {
  return findPrimaryTweetTextBlock(article) || findXLinkedArticleTitle(article);
}

function placeXPostTranslateButton(article, button) {
  const handle = getTweetAuthorMeta(article).handle.toLowerCase();
  const handleText = '@' + handle;
  const link = handle && Array.from(article.querySelectorAll('a[href]')).find(anchor =>
    isOwnXPostElement(article, anchor)
    && anchor.textContent.trim().toLowerCase() === handleText
    && normalizeXHandle(anchor.href).toLowerCase() === handle
    && !anchor.closest(X_POST_BODY_SELECTOR + ', form')
  );
  if (link) {
    link.insertAdjacentElement('afterend', button);
    return true;
  }

  const header = Array.from(article.querySelectorAll('[data-testid="User-Name"], .x-middot-group'))
    .find(node => isOwnXPostElement(article, node));
  if (!header) return false;
  const marker = handle && Array.from(header.querySelectorAll('span')).find(span =>
    span.textContent.trim().toLowerCase() === handleText
  );
  if (marker) (marker.closest('a') || marker).insertAdjacentElement('afterend', button);
  else (header.firstElementChild || header).append(button);
  return true;
}

function getStructuredTweetText(block) {
  if (!block) return '';
  const clone = block.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
  clone.querySelectorAll('img').forEach(image => {
    const label = image.getAttribute('alt') || image.getAttribute('aria-label') || '';
    image.replaceWith(document.createTextNode(label));
  });
  clone.querySelectorAll('[role="img"][aria-label]').forEach(element => {
    if (element.textContent?.trim()) return;
    element.replaceWith(document.createTextNode(element.getAttribute('aria-label') || ''));
  });
  return clone.textContent || block.innerText || block.textContent || '';
}

function getTweetInlineLinks(block) {
  if (!block) return [];
  const seen = new Set();
  return Array.from(block.querySelectorAll('a[href]')).map(anchor => {
    const label = (anchor.textContent || anchor.getAttribute('aria-label') || '').trim();
    const href = anchor.href || anchor.getAttribute('href') || '';
    if (!label || !href) return null;
    const key = `${label}\u0000${href}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { label, href };
  }).filter(Boolean);
}

function createXPostTranslationPlan(text, inlineLinks = []) {
  const value = String(text || '').slice(0, 12000);
  const newline = value.includes('\r\n') ? '\r\n' : (value.includes('\r') ? '\r' : '\n');
  const lines = value.split(/\r\n|\n|\r/);
  const entries = [];
  const protectedValues = new Map();
  let tokenIndex = 0;

  const protectValue = (match, kind) => {
    const token = `[[DTH_X_${kind}_${tokenIndex++}_9F4A]]`;
    protectedValues.set(token, match);
    return token;
  };

  const protectInlineFormatting = source => {
    let protectedText = source;
    const linkLabels = inlineLinks
      .map(link => link.label)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const label of linkLabels) {
      if (!protectedText.includes(label)) continue;
      protectedText = protectedText.split(label).join(protectValue(label, 'LINK'));
    }
    if (typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      protectedText = Array.from(segmenter.segment(protectedText), item => (
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(item.segment)
          ? protectValue(item.segment, 'EMOJI')
          : item.segment
      )).join('');
    }
    return protectedText.replace(/\t+| {2,}/g, match => protectValue(match, 'SPACE'));
  };

  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    const leading = line.match(/^[\t ]*/)?.[0] || '';
    const trailing = line.match(/[\t ]*$/)?.[0] || '';
    const core = line.slice(leading.length, line.length - trailing.length);
    entries.push({ lineIndex, leading, trailing, protectedCore: protectInlineFormatting(core) });
  });

  return {
    value,
    newline,
    lines,
    entries,
    protectedValues,
    segments: entries.map(entry => entry.protectedCore)
  };
}

function restoreXPostProtectedValues(text, protectedValues) {
  let value = String(text || '');
  for (const [token, original] of protectedValues) value = value.split(token).join(original);
  return value;
}

function rebuildXPostTranslation(plan, translations) {
  const outputLines = plan.lines.slice();
  plan.entries.forEach((entry, index) => {
    const translated = Array.isArray(translations) ? translations[index] : '';
    const restored = restoreXPostProtectedValues(
      translated || entry.protectedCore,
      plan.protectedValues
    );
    const core = restored.replace(/\s*(?:\r\n|\n|\r)+\s*/g, ' ').trim();
    outputLines[entry.lineIndex] = `${entry.leading}${core}${entry.trailing}`;
  });
  return outputLines.join(plan.newline);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimLinkPunctuation(value) {
  const match = String(value).match(/^(.*?)([),.!?:;]+)$/u);
  if (!match || !match[1]) return { linkText: value, suffix: '' };
  return { linkText: match[1], suffix: match[2] };
}

function resolveTranslatedLinkHref(text, inlineLinks) {
  const exact = inlineLinks.find(link => link.label === text)
    || inlineLinks.find(link => link.label.toLowerCase() === text.toLowerCase());
  if (exact) return exact.href;
  if (/^@[a-z0-9_]{1,15}$/i.test(text)) return `https://x.com/${text.slice(1)}`;
  if (/^#[\p{L}\p{N}_]+$/u.test(text)) {
    return `https://x.com/hashtag/${encodeURIComponent(text.slice(1))}`;
  }
  if (/^https?:\/\//i.test(text)) return text;
  if (/^www\./i.test(text)) return `https://${text}`;
  if (/^(?:[\p{L}\p{N}-]+\.)+[a-z]{2,}(?:\/|$)/iu.test(text)) return `https://${text}`;
  return '';
}

function appendTranslatedPostLink(container, text, href) {
  const anchor = document.createElement('a');
  anchor.className = 'dth-x-post-translation-link';
  anchor.href = href;
  anchor.textContent = text;
  anchor.rel = 'noopener noreferrer';
  anchor.addEventListener('mousedown', event => event.stopPropagation());
  anchor.addEventListener('click', event => event.stopPropagation());
  container.append(anchor);
}

function renderXPostTranslation(container, text, inlineLinks) {
  const labels = inlineLinks
    .map(link => link.label)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const generic = 'https?:\\/\\/[^\\s]+|www\\.[^\\s]+|(?:[\\p{L}\\p{N}-]+\\.)+[a-z]{2,}(?:\\/[^\\s]*)?|@[a-z0-9_]{1,15}|#[\\p{L}\\p{N}_]+';
  const matcher = new RegExp(labels.length ? `${labels.join('|')}|${generic}` : generic, 'giu');

  let cursor = 0;
  for (const match of String(text || '').matchAll(matcher)) {
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    const { linkText, suffix } = trimLinkPunctuation(match[0]);
    const href = resolveTranslatedLinkHref(linkText, inlineLinks);
    if (href) appendTranslatedPostLink(container, linkText, href);
    else container.append(document.createTextNode(linkText));
    if (suffix) container.append(document.createTextNode(suffix));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

function getXPostKey(article) {
  const text = getStructuredTweetText(findXPostTranslationSource(article));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${getTweetUrl(article)}#${(hash >>> 0).toString(36)}`;
}

function getXPostTranslateTitle(translated = false) {
  const key = translated ? 'restorePostTitle' : 'translatePostTitle';
  const localized = t(key);
  if (localized && localized !== key) return localized;
  return translated ? 'Restore original post' : 'Translate this post';
}

function setXPostTranslateButtonState(button, state, title) {
  if (!button) return;
  button.dataset.state = state;
  button.disabled = state === 'loading';
  const label = title || getXPostTranslateTitle(state === 'translated');
  button.title = label;
  button.setAttribute('aria-label', label);
}

function restoreXPostTranslation(article, { removeButton = false } = {}) {
  const state = xPostTranslationStates.get(article);
  if (state) {
    state.requestId++;
    if (state.originalBlock?.isConnected) {
      state.originalBlock.style.display = state.originalDisplay;
    }
    state.translationElement?.remove();
    state.translationElement = null;
    state.originalBlock = null;
    state.translated = false;
    setXPostTranslateButtonState(state.button, 'idle');
    if (removeButton) {
      state.button?.remove();
      xPostTranslationStates.delete(article);
    }
  }
  article.querySelectorAll(`.${X_POST_TRANSLATION_CLASS}`).forEach(element => element.remove());
  if (removeButton) article.querySelectorAll(`.${X_POST_TRANSLATE_BUTTON_CLASS}`).forEach(button => button.remove());
}

function clearXPostTranslateButtons() {
  for (const [article] of xPostTranslationStates) restoreXPostTranslation(article, { removeButton: true });
  xPostTranslationStates.clear();
  document.querySelectorAll(`.${X_POST_TRANSLATE_BUTTON_CLASS}`).forEach(button => button.remove());
}

function cleanupStaleXPostTranslationUi() {
  document.querySelectorAll(`.${X_POST_TRANSLATION_CLASS}`).forEach(element => {
    const original = element.previousElementSibling;
    if (original?.matches(X_POST_BODY_SELECTOR + ', ' + X_POST_ARTICLE_TITLE_SELECTOR)
      && original.style.display === 'none') {
      original.style.removeProperty('display');
    }
    element.remove();
  });
  document.querySelectorAll(`.${X_POST_TRANSLATE_BUTTON_CLASS}`).forEach(button => button.remove());
}

async function toggleXPostTranslation(article, button) {
  let state = xPostTranslationStates.get(article);
  if (!state) {
    state = { key: getXPostKey(article), requestId: 0, translated: false, button };
    xPostTranslationStates.set(article, state);
  }
  state.button = button;
  if (state.translated) {
    restoreXPostTranslation(article);
    return;
  }

  const originalBlock = findXPostTranslationSource(article);
  const originalText = getStructuredTweetText(originalBlock);
  if (!originalBlock || !originalText.trim()) return;

  const inlineLinks = getTweetInlineLinks(originalBlock);
  const plan = createXPostTranslationPlan(originalText, inlineLinks);
  if (!plan.segments.length) return;
  const requestId = ++state.requestId;
  setXPostTranslateButtonState(button, 'loading', t('translatingButton') || 'Translating…');

  try {
    const targetLang = STATE.settings?.targetLang || 'ru';
    const response = await callBackground({
      type: 'translateSelectionSegments',
      segments: plan.segments,
      targetLang,
      sourceLang: 'auto',
      preserveFormatting: true
    });
    if (requestId !== state.requestId || !article.isConnected || !originalBlock.isConnected) return;
    if (state.key !== getXPostKey(article)) return;

    const translatedText = rebuildXPostTranslation(plan, response.translations);
    const translatedBlock = originalBlock.cloneNode(false);
    translatedBlock.removeAttribute('id');
    translatedBlock.removeAttribute('data-testid');
    translatedBlock.classList.add(X_POST_TRANSLATION_CLASS);
    translatedBlock.setAttribute('lang', targetLang);
    translatedBlock.setAttribute('dir', 'auto');
    if (originalBlock.closest('a[href]')) translatedBlock.textContent = translatedText;
    else renderXPostTranslation(translatedBlock, translatedText, inlineLinks);

    state.originalBlock = originalBlock;
    state.originalDisplay = originalBlock.style.display;
    state.translationElement = translatedBlock;
    state.translated = true;
    originalBlock.style.display = 'none';
    originalBlock.insertAdjacentElement('afterend', translatedBlock);
    setXPostTranslateButtonState(state.button, 'translated');
  } catch (error) {
    if (requestId !== state.requestId) return;
    setXPostTranslateButtonState(
      state.button,
      'error',
      `${t('errorPrefix') || 'Error: '}${error.message || String(error)}`
    );
    setTimeout(() => {
      if (state.requestId === requestId && !state.translated) {
        setXPostTranslateButtonState(state.button, 'idle');
      }
    }, 2500);
  }
}

function createXPostTranslateButton(article, key) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = X_POST_TRANSLATE_BUTTON_CLASS;
  button.dataset.tweetKey = key;
  setXPostTranslateButtonState(button, 'idle');
  button.addEventListener('mousedown', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    await toggleXPostTranslation(article, button);
  });
  return button;
}

function ensureXPostTranslateButtons() {
  if (!STATE.settings || STATE.settings.translationEnabled === false) {
    clearXPostTranslateButtons();
    return;
  }

  for (const [article] of xPostTranslationStates) {
    if (!article.isConnected) xPostTranslationStates.delete(article);
  }

  let added = 0;
  for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
    if (added >= 30) break;
    const rect = article.getBoundingClientRect();
    if (rect.bottom < -500 || rect.top > window.innerHeight + 1200) continue;
    if (isPromotedTweet(article)) continue;

    const textBlock = findXPostTranslationSource(article);
    if (!textBlock) continue;

    const key = getXPostKey(article);
    let button = article.querySelector(`.${X_POST_TRANSLATE_BUTTON_CLASS}`);
    const state = xPostTranslationStates.get(article);
    if (button && button.dataset.tweetKey !== key) {
      restoreXPostTranslation(article, { removeButton: true });
      button = null;
    }
    if (state?.translated && (!state.translationElement?.isConnected || state.originalBlock !== textBlock)) {
      restoreXPostTranslation(article);
    }
    if (button) {
      const current = xPostTranslationStates.get(article);
      if (button.dataset.state === 'idle' || current?.translated) {
        setXPostTranslateButtonState(button, current?.translated ? 'translated' : 'idle');
      }
      continue;
    }

    button = createXPostTranslateButton(article, key);
    if (!placeXPostTranslateButton(article, button)) continue;
    const current = xPostTranslationStates.get(article);
    if (current) current.button = button;
    added++;
  }
}

function scheduleXPostTranslateScan(delay = 500) {
  if (xPostTranslateScanTimer) return;
  xPostTranslateScanTimer = setTimeout(() => {
    xPostTranslateScanTimer = null;
    try { ensureXPostTranslateButtons(); }
    catch (error) { console.debug('[DTH X] post translate scan failed', error); }
  }, delay);
}

function getAgentRunLimit() {
  const raw = Number(STATE.settings && STATE.settings.xAgentRunCount);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(20, Math.round(raw)));
}

function getAgentDelayRange([minKey, maxKey] = X_AGENT_BETWEEN_REPLIES, read = key => STATE.settings?.[key]) {
  const first = normalizeXAgentNumber(minKey, read(minKey));
  const second = normalizeXAgentNumber(maxKey, read(maxKey));
  let min = Math.min(first, second);
  let max = Math.max(first, second);
  if (minKey === X_AGENT_BEFORE_REPLY[0] && min === max) {
    min = Math.min(min, X_AGENT_NUMBER_RULES[maxKey].max - 1);
    max = min + 1;
  }
  return { min, max };
}

function getRandomAgentDelayMs(keys) {
  const { min, max } = getAgentDelayRange(keys);
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

function findSubmitButton(compose, requireEnabled = true) {
  const form = compose?.closest('form');
  const dialog = compose?.closest('[role="dialog"]');
  const root = form || dialog;
  const legacy = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
  for (let scope = root || compose?.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
    const selector = form ? legacy + ', button[data-slot="xds-button"], button[type="submit"]' : legacy;
    const button = Array.from(scope.querySelectorAll(selector)).find(btn => {
      if (form && btn.closest('form') !== form) return false;
      return (btn.matches(legacy) || /^(reply|ответить|відповісти|répondre|responder|antworten|rispondi|yanıtla|odpowiedz|返信|回复|回覆|رد|답글)$/iu.test(btn.textContent.trim()))
        && (requireEnabled ? isEnabledXControl(btn) : isVisible(btn));
    });
    if (button) return button;
    if (root || scope.querySelectorAll(COMPOSE_SELECTORS.join(',')).length > 1) break;
  }
  return null;
}

async function waitForSubmitButton(compose) {
  for (let i = 0; i < 20; i++) {
    if (!isAvailableXCompose(compose)) return null;
    const btn = findSubmitButton(compose);
    if (btn) return btn;
    await sleep(120);
  }
  return null;
}

async function waitForReplyCompose(article, beforeSet) {
  for (let i = 0; i < 50; i++) {
    const existing = findExistingReplyComposer(article);
    if (existing) return existing;
    // The old X client opens its Reply dialog without changing the route.
    if (!getXReplyRoutePostId()) {
      const dialogs = Array.from(document.querySelectorAll(COMPOSE_SELECTORS.join(','))).filter(el =>
        !beforeSet.has(el) && isAvailableXCompose(el) && el.closest('[role="dialog"]')
        && !el.matches('textarea') && findSubmitButton(el, false));
      if (dialogs.length === 1) return dialogs[0];
    }
    await sleep(120);
  }
  return null;
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
let xAgentProcessedPosts = new Map();
let xAgentProcessedSaveQueue = Promise.resolve();
let xRelationshipState = { authors: [], session: null };
let xRelationshipScanTimer = null;
let xRelationshipProfileCheckedAt = 0;
let xRelationshipMarkingSubmit = false;
let xRelationshipLastUrl = location.href;
let xRelationshipPendingCompose = null;
let xRelationshipAutomationTimer = null;
let xRelationshipAutomationRunning = false;
let xRelationshipAutomationStopRequested = false;
let xRelationshipAutomationBlockedStep = '';
let xRelationshipAutomationSessionId = '';
const X_AGENT_ANIMATION_VIDEOS = {
  idle: chrome.runtime.getURL('animated/son/son-transparent.webm'),
  working: chrome.runtime.getURL('animated/kopaet/kopaet-transparent.webm')
};

function applyXAgentProcessedPosts(value) {
  const entries = normalizeXAgentProcessedPosts(value);
  xAgentProcessedPosts = new Map(entries.map(item => [item.postId, item]));
  return entries;
}

async function rememberXAgentProcessedPost(tweet, status) {
  const postId = getXPostId(tweet?.postId || tweet?.url);
  if (!postId) return;
  const operation = xAgentProcessedSaveQueue.then(async () => {
    const stored = await chrome.storage.local.get(X_AGENT_PROCESSED_POSTS_KEY);
    const entries = normalizeXAgentProcessedPosts(stored[X_AGENT_PROCESSED_POSTS_KEY])
      .filter(item => item.postId !== postId);
    entries.unshift({
      postId,
      url: String(tweet?.url || '').slice(0, 500),
      status: status === 'sent' ? 'sent' : 'draft',
      processedAt: new Date().toISOString()
    });
    const limited = entries.slice(0, X_AGENT_MAX_PROCESSED_POSTS);
    applyXAgentProcessedPosts(limited);
    await chrome.storage.local.set({ [X_AGENT_PROCESSED_POSTS_KEY]: limited });
  });
  xAgentProcessedSaveQueue = operation.catch(() => {});
  return operation;
}

function xRelationshipCommand(action, payload = {}) {
  return callBackground({ type: 'xRelationship', action, ...payload });
}

async function rememberXAgentProcessedPostIds(postIds) {
  const ids = Array.from(new Set((postIds || []).map(getXPostId).filter(Boolean)));
  if (!ids.length) return;
  const operation = xAgentProcessedSaveQueue.then(async () => {
    const stored = await chrome.storage.local.get(X_AGENT_PROCESSED_POSTS_KEY);
    const current = normalizeXAgentProcessedPosts(stored[X_AGENT_PROCESSED_POSTS_KEY]);
    const incoming = new Set(ids);
    const checkedAt = new Date().toISOString();
    const entries = [
      ...ids.map(postId => ({ postId, url: '', status: 'sent', processedAt: checkedAt })),
      ...current.filter(item => !incoming.has(item.postId))
    ].slice(0, X_AGENT_MAX_PROCESSED_POSTS);
    applyXAgentProcessedPosts(entries);
    await chrome.storage.local.set({ [X_AGENT_PROCESSED_POSTS_KEY]: entries });
  });
  xAgentProcessedSaveQueue = operation.catch(() => {});
  return operation;
}

async function syncRecentXRepliesFromApi() {
  try {
    const response = await xRelationshipCommand('getRecentOwnReplyTargets');
    if (Array.isArray(response.postIds) && response.postIds.length) {
      await rememberXAgentProcessedPostIds(response.postIds);
    }
    return response;
  } catch (error) {
    console.debug('[DTH X Agent] recent reply sync unavailable', error);
    return null;
  }
}

async function refreshXRelationshipState(updateUi = true) {
  try {
    const response = await xRelationshipCommand('list');
    const nextSessionId = String(response.session?.startedAt || '');
    xRelationshipState = {
      authors: Array.isArray(response.authors) ? response.authors : [],
      session: response.session || null
    };
    if (!xRelationshipState.session?.active) {
      xRelationshipAutomationStopRequested = true;
    } else if (xRelationshipState.session.auto === true
      && nextSessionId
      && nextSessionId !== xRelationshipAutomationSessionId) {
      xRelationshipAutomationStopRequested = false;
      xRelationshipAutomationBlockedStep = '';
    }
    xRelationshipAutomationSessionId = nextSessionId;
    if (!xRelationshipState.session?.pendingInteractionId) xRelationshipPendingCompose = null;
    if (updateUi) {
      updateXRelationshipControls();
      scheduleXRelationshipScan(50);
      scheduleXRelationshipAutomation(250);
      updateXAgentPanel();
    }
    return xRelationshipState;
  } catch (error) {
    console.debug('[DTH Relationship] state load failed', error);
    return xRelationshipState;
  }
}

function trackedXAuthor(handle) {
  const id = normalizeXHandle(handle).toLowerCase();
  return xRelationshipState.authors.find(author => author.id === id) || null;
}

function currentXProfileHandle() {
  const first = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1] || '';
  if (!first) return '';
  const reserved = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'compose',
    'settings', 'bookmarks', 'communities', 'jobs', 'premium', 'tos', 'privacy'
  ]);
  return reserved.has(first.toLowerCase()) ? '' : first;
}

function isXRelationshipProfileScanPage() {
  return X_RELATIONSHIP_PROFILE_SCAN_MODE;
}

function currentXRelationshipAuthor() {
  const session = xRelationshipState.session;
  if (!session?.active) return null;
  const handle = session.queue?.[session.index];
  return trackedXAuthor(handle);
}

function getXRelationshipProgressText() {
  const session = xRelationshipState.session;
  const author = currentXRelationshipAuthor();
  if (!session?.active || !author) return 'No active session';
  return `${session.index + 1}/${session.queue.length} · @${author.handle}${author.followsBack ? ' · Follows you ✓' : ''}`;
}

function findXProfileIdentity(handle = currentXProfileHandle()) {
  if (!handle || currentXProfileHandle().toLowerCase() !== handle.toLowerCase()) return null;
  const main = document.querySelector('main');
  const legacy = main?.querySelector('[data-testid="UserName"]');
  if (legacy) return legacy;
  const heading = main?.querySelector('h1[dir="auto"]');
  const marker = '@' + handle.toLowerCase();
  for (let scope = heading?.parentElement; scope && scope !== main; scope = scope.parentElement) {
    if (Array.from(scope.querySelectorAll('span')).some(span =>
      span.textContent.trim().toLowerCase() === marker && !span.closest('article, [role="link"][data-href]')
    )) return scope;
  }
  return null;
}

function getXProfileFollowState(button, handle) {
  const id = (button?.dataset.testid || '').toLowerCase();
  if (id.endsWith('-unfollow')) return 'following';
  if (id.endsWith('-cancelfollowrequest')) return 'requested';
  if (id.endsWith('-follow')) return 'follow';
  const label = (button?.getAttribute('aria-label') || '').trim().toLowerCase();
  const match = label.match(/^(.*?)\s+@([a-z0-9_]{1,15})$/);
  if (!match || match[2] !== handle.toLowerCase()) return '';
  if (/^(?:unfollow|stop following|following|перестать читать|прекратить читать|отписаться от|читаю|вы читаете)$/.test(match[1])) return 'following';
  if (/^(?:cancel follow request(?: to)?|отменить запрос(?: на подписку)?(?: к)?)$/.test(match[1])) return 'requested';
  if (/^(?:follow|начать читать|читать|подписаться на)$/.test(match[1])) return 'follow';
  const text = normalizeXProfileLabel(button.textContent);
  if (/^(?:following|unfollow|читаю|отписаться)$/.test(text)) return 'following';
  if (/^(?:pending|requested|запрос отправлен)$/.test(text)) return 'requested';
  return '';
}

function findXProfileFollowButton(handle = currentXProfileHandle()) {
  if (!findXProfileIdentity(handle)) return null;
  const buttons = document.querySelectorAll(
    'main button[data-testid$="-follow"], main button[data-testid$="-unfollow"], ' +
    'main button[data-testid$="-cancelFollowRequest" i], main button[aria-label*="@"]'
  );
  return Array.from(buttons).find(button =>
    isVisible(button) && !button.closest('article, [data-testid="UserCell"], [role="link"][data-href], [role="dialog"]')
    && getXProfileFollowState(button, handle)
  ) || null;
}

function readXProfileFollowing(handle) {
  const state = getXProfileFollowState(findXProfileFollowButton(handle), handle);
  return state ? state === 'following' : null;
}

function getCurrentXProfileDisplayName(handle) {
  const root = findXProfileIdentity(handle);
  if (!root) return '';
  const heading = root.querySelector('h1');
  if (heading) return heading.textContent.trim().slice(0, 160);
  const text = (root.textContent || '').trim();
  const marker = `@${handle}`.toLowerCase();
  const index = text.toLowerCase().indexOf(marker);
  return (index >= 0 ? text.slice(0, index) : text.split('\n')[0]).trim().slice(0, 160);
}

function normalizeXProfileLabel(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.:·•]+$/g, '')
    .trim()
    .toLocaleLowerCase();
}

function isXFollowsBackLabel(value) {
  return X_FOLLOWS_BACK_LABELS.has(normalizeXProfileLabel(value));
}

function detectXFollowsBack(handle = currentXProfileHandle()) {
  const identity = findXProfileIdentity(handle);
  if (!identity) return false;
  const scope = identity.parentElement || identity;
  const candidates = [identity, ...scope.querySelectorAll('span, [aria-label], [title]')];
  return candidates.filter(isVisible).some(element => {
    return isXFollowsBackLabel(element.textContent)
      || isXFollowsBackLabel(element.getAttribute?.('aria-label'))
      || isXFollowsBackLabel(element.getAttribute?.('title'));
  });
}

function getXRelationshipHandledPostIds(author) {
  const ids = new Set();
  for (const interaction of author?.interactions || []) {
    if (interaction.status === 'error') continue;
    const postId = getXPostId(interaction.postId || interaction.postUrl);
    if (postId) ids.add(postId);
  }
  return ids;
}

function hasVisibleXUserReplyMarker(article) {
  const context = Array.from(article.querySelectorAll('[data-testid="socialContext"]'))
    .map(node => node.textContent || '')
    .join(' ')
    .trim();
  if (!context) return false;
  return /\byou(?: and .{1,80})? replied\b|\bвы(?: и .{1,80})? ответили\b|\bви(?: й .{1,80})? відповіли\b|du hast geantwortet|vous avez répondu|has respondido|você respondeu|yanıtladın|odpowiedzia(?:łeś|łaś)|أنت رددت|你回复了|返信しました/i.test(context);
}

function isXArticleAlreadyHandled(article, author = null, handledPostIds = null) {
  if (article.hasAttribute(X_AGENT_PROCESSED_ATTR)) return true;
  const postId = getXPostId(getTweetUrl(article));
  if (postId && xAgentProcessedPosts.has(postId)) return true;
  const relationshipIds = handledPostIds || (author ? getXRelationshipHandledPostIds(author) : null);
  if (postId && relationshipIds?.has(postId)) return true;
  if (getXPostLiked(findXPostLikeButton(article)) === true) return true;
  return hasVisibleXUserReplyMarker(article);
}

function findXRelationshipInteractionArticle(interaction) {
  const expectedId = getXPostId(interaction?.postId || interaction?.postUrl);
  if (!expectedId) return null;
  return Array.from(document.querySelectorAll(TWEET_SELECTOR))
    .find(article => getXPostId(getTweetUrl(article)) === expectedId) || null;
}

function getXRelationshipTargetArticle(author = currentXRelationshipAuthor()) {
  if (!author) return null;
  const handledPostIds = getXRelationshipHandledPostIds(author);
  const candidates = Array.from(document.querySelectorAll(TWEET_SELECTOR))
    .filter(article => getTweetAuthorMeta(article).handle.toLowerCase() === author.id)
    .filter(article => !!getTweetText(article) && !isPromotedTweet(article))
    .filter(article => !!getXPostId(getTweetUrl(article)) && !!findReplyButton(article))
    .filter(article => !isXArticleAlreadyHandled(article, author, handledPostIds));
  const unpinned = candidates.find(article => {
    const context = article.querySelector('[data-testid="socialContext"]')?.textContent
      || article.firstElementChild?.textContent?.slice(0, 100) || '';
    return !/pinned|закреп|закріп|épingl|angeheftet|fijad|fixad|sabit|przypię|固定|置顶|مثبت/i.test(context);
  });
  return unpinned || candidates[0] || null;
}

function clearXRelationshipHighlights() {
  document.querySelectorAll(`.${X_RELATIONSHIP_TARGET_CLASS}`)
    .forEach(element => element.classList.remove(X_RELATIONSHIP_TARGET_CLASS));
  document.querySelectorAll(`.${X_RELATIONSHIP_ACTION_CLASS}`)
    .forEach(element => element.classList.remove(X_RELATIONSHIP_ACTION_CLASS));
}

function updateXRelationshipHighlights() {
  clearXRelationshipHighlights();
  const author = currentXRelationshipAuthor();
  if (!author) return;
  const pending = currentXRelationshipPending();
  const target = pending
    ? findXRelationshipInteractionArticle(pending.interaction)
    : getXRelationshipTargetArticle(author);
  if (target) {
    target.classList.add(X_RELATIONSHIP_TARGET_CLASS);
    const like = findXPostLikeButton(target);
    if (like) like.classList.add(X_RELATIONSHIP_ACTION_CLASS);
  }
  const follow = findXProfileFollowButton();
  if (follow) follow.classList.add(X_RELATIONSHIP_ACTION_CLASS);
  if (pending && xRelationshipPendingCompose?.isConnected) {
    const submit = findSubmitButton(xRelationshipPendingCompose);
    if (submit) submit.classList.add(X_RELATIONSHIP_ACTION_CLASS);
  }
}

async function findNextXRelationshipTarget(author) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = getXRelationshipTargetArticle(author);
    if (target) return target;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.82), behavior: 'smooth' });
    await sleep(900);
  }
  return null;
}

async function likeXRelationshipArticle(article) {
  const postId = getXPostId(getTweetUrl(article));
  if (!postId) return false;
  const findArticle = () => {
    if (article.isConnected && getXPostId(getTweetUrl(article)) === postId) return article;
    return Array.from(document.querySelectorAll(TWEET_SELECTOR))
      .find(candidate => getXPostId(getTweetUrl(candidate)) === postId) || null;
  };
  const likeButton = findXPostLikeButton(findArticle());
  const liked = getXPostLiked(likeButton);
  if (liked === true) return true;
  if (liked !== false || !isEnabledXControl(likeButton)) return false;
  likeButton.click();
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(150);
    if (getXPostLiked(findXPostLikeButton(findArticle())) === true) return true;
  }
  return false;
}

async function followCurrentXRelationshipAuthor(handle) {
  const followButton = findXProfileFollowButton(handle);
  const state = getXProfileFollowState(followButton, handle);
  if (state === 'following' || state === 'requested') return state;
  if (state !== 'follow' || !isEnabledXControl(followButton)) return '';
  followButton.click();
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(180);
    if (currentXProfileHandle().toLowerCase() !== handle.toLowerCase()) break;
    const confirmed = getXProfileFollowState(findXProfileFollowButton(handle), handle);
    if (confirmed === 'following' || confirmed === 'requested') return confirmed;
  }
  return '';
}

function scheduleXRelationshipScan(delay = 500) {
  if (isXRelationshipProfileScanPage()) return;
  if (xRelationshipScanTimer) return;
  xRelationshipScanTimer = setTimeout(() => {
    xRelationshipScanTimer = null;
    if (xRelationshipLastUrl !== location.href) {
      xRelationshipLastUrl = location.href;
      xRelationshipProfileCheckedAt = 0;
    }
    updateXRelationshipControls();
    updateXRelationshipHighlights();
    refreshCurrentXRelationshipProfile()
      .catch(() => {})
      .finally(() => scheduleXRelationshipAutomation(250));
  }, delay);
}

async function refreshCurrentXRelationshipProfile(force = false) {
  const handle = currentXProfileHandle();
  const author = trackedXAuthor(handle);
  if (!author) return;
  const now = Date.now();
  if (!force && now - xRelationshipProfileCheckedAt < 30000) return;
  if (!findXProfileIdentity(handle)) return;
  const following = readXProfileFollowing(handle) ?? author.following;
  // Follow-back is treated as achieved once observed. A temporarily incomplete
  // profile render must not downgrade the saved success state.
  const followsBack = detectXFollowsBack(handle) || author.followsBack === true;
  const changed = following !== author.following || followsBack !== author.followsBack;
  const lastChecked = Date.parse(author.lastCheckedAt || '') || 0;
  const checkDue = now - lastChecked > 5 * 60 * 1000;
  if (!force && !changed && !checkDue) return;
  xRelationshipProfileCheckedAt = now;
  await xRelationshipCommand('patchAuthor', {
    handle: author.handle,
    patch: {
      displayName: getCurrentXProfileDisplayName(author.handle) || author.displayName,
      following,
      followsBack,
      lastCheckedAt: new Date().toISOString()
    }
  });
  await refreshXRelationshipState();
}

async function inspectCurrentXProfileForCrm(expectedHandle) {
  const expected = normalizeXHandle(expectedHandle);
  if (!expected) return { ready: false, error: 'Invalid X handle.' };
  let profileSeenAt = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const following = readXProfileFollowing(expected);
    if (following !== null) {
      if (!profileSeenAt) profileSeenAt = Date.now();
      if (Date.now() - profileSeenAt >= 500) {
        return {
          ready: true,
          handle: expected,
          displayName: getCurrentXProfileDisplayName(expected),
          following,
          followsBack: detectXFollowsBack(expected)
        };
      }
    } else {
      profileSeenAt = 0;
    }
    await sleep(200);
  }
  return { ready: false, error: `Profile @${expected} did not finish loading.` };
}

async function trackXAuthor(meta) {
  const handle = normalizeXHandle(meta?.handle || meta?.profileUrl);
  if (!handle) throw new Error('Author handle not found.');
  const response = await xRelationshipCommand('upsertAuthor', {
    author: {
      handle,
      displayName: meta.displayName || '',
      profileUrl: meta.profileUrl || `https://x.com/${handle}`
    }
  });
  xRelationshipState = {
    authors: Array.isArray(response.authors) ? response.authors : [],
    session: response.session || null
  };
  updateXRelationshipControls();
  const saved = trackedXAuthor(handle);
  if (!saved) throw new Error('Author was not returned by local CRM storage.');
  return saved;
}

function showXRelationshipToast(message, isError = false) {
  document.querySelector('.dth-x-relationship-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `dth-x-relationship-toast${isError ? ' is-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 180);
  }, 2200);
}

function buildXRelationshipReplyContext(author) {
  if (!author) return null;
  return {
    handle: author.handle,
    displayName: author.displayName,
    notes: author.notes,
    following: author.following,
    followsBack: author.followsBack,
    interactions: (author.interactions || []).slice(-8)
  };
}

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

const X_AGENT_BETWEEN_REPLIES = ['xAgentDelayMinSeconds', 'xAgentDelayMaxSeconds'];
const X_AGENT_BEFORE_REPLY = ['xAgentBeforeReplyMinSeconds', 'xAgentBeforeReplyMaxSeconds'];
const X_AGENT_NUMBER_RULES = {
  xAgentRunCount: { min: 1, max: 20, fallback: 3 },
  xAgentMemoryLimit: { min: 0, max: 50, fallback: 8 },
  xAgentDelayMinSeconds: { min: 5, max: 600, fallback: 30 },
  xAgentDelayMaxSeconds: { min: 5, max: 600, fallback: 90 },
  xAgentBeforeReplyMinSeconds: { min: 1, max: 600, fallback: 1 },
  xAgentBeforeReplyMaxSeconds: { min: 1, max: 600, fallback: 3 }
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

function normalizeXAgentDelayPair([minKey, maxKey]) {
  if (!xAgentPanel) return;
  const minControl = xAgentPanel.querySelector('[data-x-agent-setting="' + minKey + '"]');
  const maxControl = xAgentPanel.querySelector('[data-x-agent-setting="' + maxKey + '"]');
  if (!minControl || !maxControl) return;
  const { min, max } = getAgentDelayRange([minKey, maxKey], key =>
    key === minKey ? minControl.value : maxControl.value
  );
  minControl.value = String(min);
  maxControl.value = String(max);
  scheduleXAgentSettingSave(minKey, min, 0);
  scheduleXAgentSettingSave(maxKey, max, 0);
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
    const delayPair = [X_AGENT_BETWEEN_REPLIES, X_AGENT_BEFORE_REPLY].find(pair => pair.includes(key));
    control.addEventListener('input', () => {
      if (control.value.trim() === '') return;
      scheduleXAgentSettingSave(key, normalizeXAgentNumber(key, control.value));
      updateXAgentMemoryHint();
    });
    control.addEventListener('change', () => {
      if (delayPair) {
        normalizeXAgentDelayPair(delayPair);
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
    createXAgentNumberSetting('xAgentDelayMinSeconds', 'Between replies min, sec'),
    createXAgentNumberSetting('xAgentDelayMaxSeconds', 'Between replies max, sec'),
    createXAgentNumberSetting('xAgentBeforeReplyMinSeconds', 'Before writing min, sec'),
    createXAgentNumberSetting('xAgentBeforeReplyMaxSeconds', 'Before writing max, sec')
  );

  const prompt = document.createElement('textarea');
  prompt.rows = 4;
  prompt.className = 'dth-x-agent-setting-input dth-x-agent-setting-prompt';
  bindXAgentSetting(prompt, 'xAgentPrompt');

  const relationshipPrompt = document.createElement('textarea');
  relationshipPrompt.rows = 5;
  relationshipPrompt.className = 'dth-x-agent-setting-input dth-x-agent-setting-prompt';
  bindXAgentSetting(relationshipPrompt, 'xRelationshipPrompt');

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
    createXAgentToggleSetting('xRelationshipAutoLike', 'Auto-like in Relationship Mode'),
    createXAgentToggleSetting('xRelationshipAutoFollow', 'Auto-follow in Relationship Mode'),
    createXAgentToggleSetting('xRelationshipReplyToFollowers', 'Reply to authors who follow you'),
    createXAgentSettingField(
      'Relationship Mode prompt',
      relationshipPrompt,
      'Used only for tracked CRM authors. Define how to build rapport and encourage a natural follow-back.'
    ),
    utilityActions
  );
  return section;
}

function createXRelationshipSection() {
  const section = document.createElement('section');
  section.className = 'dth-x-relationship-section';

  const head = document.createElement('div');
  head.className = 'dth-x-relationship-head';
  const title = document.createElement('strong');
  title.textContent = 'Relationship Mode';
  const count = document.createElement('span');
  count.className = 'dth-x-relationship-count';
  count.textContent = '0 active';
  head.append(title, count);

  const progress = document.createElement('div');
  progress.className = 'dth-x-relationship-progress';
  progress.textContent = 'No active session';
  const hint = document.createElement('small');
  hint.className = 'dth-x-relationship-hint';
  hint.textContent = 'Only manually tracked authors are included.';

  const actions = document.createElement('div');
  actions.className = 'dth-x-relationship-actions';
  const button = (className, text, handler) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = text;
    element.addEventListener('click', () => Promise.resolve(handler()).catch(error => {
      console.error('[DTH Relationship] action failed', error);
      alert(error.message || String(error));
    }));
    return element;
  };
  const start = button('dth-x-relationship-start', 'Start automatic session', startXRelationshipSession);
  const prepare = button('dth-x-relationship-prepare', 'Prepare reply', prepareCurrentXRelationshipReply);
  const complete = button('dth-x-relationship-complete', 'Next author →', completeCurrentXRelationshipAuthor);
  const skip = button('dth-x-relationship-skip', 'Skip', skipCurrentXRelationshipAuthor);
  const end = button('dth-x-relationship-end', 'End', endXRelationshipSession);
  actions.append(start, prepare, complete, skip, end);

  const dashboard = document.createElement('button');
  dashboard.type = 'button';
  dashboard.className = 'dth-x-relationship-dashboard';
  dashboard.textContent = 'Open Relationship CRM';
  dashboard.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'openXRelationshipDashboard' });
  });

  section.append(head, progress, hint, actions, dashboard);
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
  const send = findSubmitButton(el, false);
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
  const text = readXComposeText(el);
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
  clearXRelationshipHighlights();
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

async function openReplyComposer(article, preferredCompose = null) {
  const existing = findExistingReplyComposer(article, preferredCompose);
  if (existing) {
    STATE.activeCompose = existing;
    return existing;
  }
  const before = new Set(Array.from(document.querySelectorAll(COMPOSE_SELECTORS.join(','))));
  const replyBtn = findReplyButton(article);
  if (!replyBtn) throw new Error('Reply button not found.');
  replyBtn.click();
  const compose = await waitForReplyCompose(article, before);
  if (!compose) throw new Error('Reply composer not found.');
  STATE.activeCompose = compose;
  return compose;
}

async function maybeSubmitReply(compose, expectedText, forceDraft = false, forceSubmit = false) {
  if (forceDraft) return false;
  if (!forceSubmit && (!STATE.settings || STATE.settings.xAgentAutoSubmit !== true)) return false;
  if (forceSubmit && xRelationshipAutomationStopRequested) return false;
  if (xAgentRunning) await waitWhileXAgentPaused();
  if (xAgentRunning && xAgentStopRequested) return false;
  const submit = await waitForSubmitButton(compose);
  if (!submit) throw new Error('Submit button not found.');
  if ((forceSubmit && xRelationshipAutomationStopRequested) || (xAgentRunning && xAgentStopRequested)) return false;
  if (readXComposeText(compose) !== expectedText) {
    throw new Error('The reply text changed before sending. Review the draft in X.');
  }
  const feedback = getXReplySubmissionFeedback();
  submit.click();
  return feedback;
}

const X_SUBMISSION_ERROR_SELECTOR = '[data-sonner-toast][data-type="error"], [data-testid="toast"][data-type="error"]';

function getXReplySubmissionFeedback() {
  return {
    replyPostId: getXReplyRoutePostId(),
    previousErrors: new Set(document.querySelectorAll(X_SUBMISSION_ERROR_SELECTOR))
  };
}

async function waitForXReplySubmission(compose, { replyPostId, previousErrors }) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(200);
    if (Array.from(document.querySelectorAll(X_SUBMISSION_ERROR_SELECTOR)).some(toast => !previousErrors.has(toast))) {
      return false;
    }
    if (replyPostId) {
      if (!getXReplyRoutePostId() && !isAvailableXCompose(compose)) return true;
    } else if (!compose.isConnected || !readXComposeText(compose)) {
      return true;
    }
  }
  return false;
}

async function waitBeforeXAgentReply(canContinue, feedRun) {
  let remaining = getRandomAgentDelayMs(X_AGENT_BEFORE_REPLY);
  try {
    while (canContinue()) {
      xAgentNextReplyMs = remaining;
      updateXAgentPanel('Waiting before reply');
      if (feedRun && xAgentPaused) {
        await sleep(200);
        continue;
      }
      if (remaining <= 0) return true;
      const started = performance.now();
      await sleep(Math.min(200, remaining));
      if (!feedRun || !xAgentPaused) {
        remaining = Math.max(0, remaining - (performance.now() - started));
      }
    }
    return false;
  } finally {
    xAgentNextReplyMs = null;
    updateXAgentPanel();
  }
}

async function runXAgentReply(article, btn, options = {}) {
  if (!STATE.settings || STATE.settings.xAgentEnabled !== true) return;
  if (xRelationshipAutomationRunning && !options.relationshipAuthor) {
    return { ok: false, error: 'Relationship Mode is currently processing an author.' };
  }
  const feedRun = options.feedRun === true;
  if (xAgentActiveJobs > 0 || (xAgentRunning && !feedRun)) {
    return { ok: false, error: 'Another X reply is already in progress.' };
  }

  xAgentActiveJobs++;
  updateXAgentPanel('Generating reply');
  document.querySelectorAll(`.${X_AGENT_ACTIVE_CLASS}`).forEach(el => {
    if (el !== article) el.classList.remove(X_AGENT_ACTIVE_CLASS);
  });
  article.classList.add(X_AGENT_ACTIVE_CLASS);
  setAgentButtonState(btn, 'thinking', 'Generating reply...');

  const payload = getTweetPayload(article);
  const postAuthor = getTweetAuthorMeta(article);
  const relationshipAuthor = options.relationshipAuthor || trackedXAuthor(postAuthor.handle) || null;
  const recordRelationship = !!relationshipAuthor && options.recordRelationship !== false;
  const preferredCompose = findExistingReplyComposer(article);
  const relationshipStep = options.relationshipAuthor ? getXRelationshipAutomationStep() : '';
  const canRun = () => STATE.settings?.xAgentEnabled === true
    && (!feedRun || !xAgentStopRequested)
    && (!relationshipStep || (!xRelationshipAutomationStopRequested && getXRelationshipAutomationStep() === relationshipStep));
  const cancelReply = () => {
    setAgentButtonState(btn, 'idle');
    return { ok: false, cancelled: true, tweet: payload };
  };
  try {
    const postId = getXPostId(payload.url);
    if (!postId) throw new Error('Could not identify the X post to reply to.');
    if (!payload.text) throw new Error('Tweet text not found.');
    const resp = await callBackground({
      type: 'xAgentReply',
      tweet: payload,
      relationship: buildXRelationshipReplyContext(relationshipAuthor)
    });
    const reply = String(resp.reply || '').trim();
    if (!reply) throw new Error('Empty AI reply.');

    if (!canRun()) return cancelReply();
    const target = article.isConnected && getXPostId(getTweetUrl(article)) === postId
      ? article
      : Array.from(document.querySelectorAll(TWEET_SELECTOR)).find(item => getXPostId(getTweetUrl(item)) === postId);
    if (!target) throw new Error('The post is no longer visible. Open it and try again.');
    const compose = await openReplyComposer(target, preferredCompose);
    const composeUrl = location.href;
    const originalText = readXComposeText(compose);
    const canWrite = () =>
      canRun() && location.href === composeUrl && isAvailableXCompose(compose)
      && readXComposeText(compose) === originalText;
    if (!await waitBeforeXAgentReply(canWrite, feedRun)) {
      if (!canRun()) return cancelReply();
      throw new Error('The reply editor changed while waiting. Review your draft in X.');
    }
    updateXAgentPanel('Writing reply');
    await replaceComposeText(compose, reply);
    if (readXComposeText(compose) !== reply) {
      throw new Error('X did not accept the reply text. Nothing was submitted.');
    }
    let relationshipInteractionId = '';
    if (recordRelationship) {
      relationshipInteractionId = crypto.randomUUID();
      await xRelationshipCommand('addInteraction', {
        handle: relationshipAuthor.handle,
        interaction: {
          id: relationshipInteractionId,
          postUrl: payload.url,
          postText: payload.text,
          replyText: reply,
          status: 'draft',
          createdAt: new Date().toISOString()
        }
      });
      await xRelationshipCommand('setPending', {
        handle: relationshipAuthor.handle,
        interactionId: relationshipInteractionId
      });
      xRelationshipPendingCompose = compose;
      await refreshXRelationshipState();
    }
    if (!canRun()) return cancelReply();
    const submission = await maybeSubmitReply(
      compose,
      reply,
      options.forceDraft === true,
      options.forceSubmit === true
    );
    if (submission && !await waitForXReplySubmission(compose, submission)) {
      throw new Error('X did not confirm the reply submission. The CRM draft was kept for review.');
    }
    const sent = !!submission;
    if (sent && relationshipInteractionId) {
      try {
        await markCurrentXRelationshipReplySent(reply, await waitForPostedXRelationshipReply(reply));
      } catch (error) {
        console.warn('[DTH Relationship] Reply was sent but CRM status could not be updated:', error);
      }
    }
    if (getXPostId(getTweetUrl(target)) === postId) {
      target.setAttribute(X_AGENT_PROCESSED_ATTR, sent ? 'sent' : 'draft');
    }
    await rememberXAgentProcessedPost(payload, sent ? 'sent' : 'draft').catch(error => {
      console.debug('[DTH X Agent] could not persist processed post', error);
    });
    await incrementXAgentTodayReplies().catch(() => {});
    if (!options.silent) playAgentSound(sent ? 'sent' : 'ready');
    setAgentButtonState(btn, sent ? 'sent' : 'draft', sent ? 'Reply sent.' : 'Reply inserted as a draft.');
    setTimeout(() => setAgentButtonState(btn, 'idle'), sent ? 2500 : 3500);
    return { ok: true, sent, reply, tweet: payload, relationshipInteractionId };
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

function currentXRelationshipPending() {
  const session = xRelationshipState.session;
  if (!session?.pendingInteractionId || !session.pendingHandle) return null;
  const author = trackedXAuthor(session.pendingHandle);
  const interaction = author?.interactions?.find(item => item.id === session.pendingInteractionId);
  return author && interaction ? { author, interaction } : null;
}

async function markCurrentXRelationshipReplySent(replyText = '', postedReply = null) {
  if (xRelationshipMarkingSubmit) return;
  const pending = currentXRelationshipPending();
  if (!pending || pending.interaction.status === 'sent') return;
  xRelationshipMarkingSubmit = true;
  try {
    await xRelationshipCommand('patchInteraction', {
      handle: pending.author.handle,
      interactionId: pending.interaction.id,
      patch: {
        status: 'sent',
        sentAt: new Date().toISOString(),
        replyText: replyText || pending.interaction.replyText,
        replyPostId: postedReply?.postId || '',
        replyUrl: postedReply?.url || ''
      }
    });
    await rememberXAgentProcessedPost({
      postId: pending.interaction.postId,
      url: pending.interaction.postUrl
    }, 'sent').catch(() => {});
    await refreshXRelationshipState();
    openXRelationshipPanel();
    updateXAgentPanel('Reply sent · choose Next author');
  } finally {
    xRelationshipMarkingSubmit = false;
  }
}

function openXRelationshipPanel() {
  if (!xAgentPanel) return;
  xAgentPanel.classList.add('is-open');
  const trigger = xAgentPanel.querySelector('.dth-x-agent-mascot');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  updateXAgentPanelPlacement();
}

function navigateToCurrentXRelationshipAuthor() {
  const author = currentXRelationshipAuthor();
  if (!author) return false;
  if (currentXProfileHandle().toLowerCase() !== author.id) {
    location.assign(author.profileUrl);
    return true;
  }
  scheduleXRelationshipScan(50);
  scheduleXRelationshipAutomation(350);
  updateXAgentPanel(`Relationship · @${author.handle}`);
  return false;
}

function getXRelationshipAutomationStep(author = currentXRelationshipAuthor()) {
  const session = xRelationshipState.session;
  if (!session?.active || !author) return '';
  return `${session.startedAt || ''}:${session.index}:${author.id}`;
}

function scheduleXRelationshipAutomation(delay = 800) {
  if (isXRelationshipProfileScanPage() || STATE.settings?.xAgentEnabled !== true) return;
  const session = xRelationshipState.session;
  const author = currentXRelationshipAuthor();
  const step = getXRelationshipAutomationStep(author);
  if (!session?.active || session.auto !== true || !author) return;
  if (xRelationshipAutomationStopRequested || xRelationshipAutomationRunning) return;
  if (xRelationshipAutomationTimer || (step && step === xRelationshipAutomationBlockedStep)) return;
  xRelationshipAutomationTimer = setTimeout(() => {
    xRelationshipAutomationTimer = null;
    runXRelationshipAutomation().catch(error => {
      const blockedAuthor = currentXRelationshipAuthor();
      xRelationshipAutomationBlockedStep = getXRelationshipAutomationStep(blockedAuthor);
      const message = error?.message || String(error);
      console.error('[DTH Relationship] automatic step failed', error);
      updateXAgentPanel(`Relationship paused · ${message.slice(0, 80)}`);
      showXRelationshipToast(`Relationship paused: ${message}`, true);
      openXRelationshipPanel();
    });
  }, Math.max(0, delay));
}

async function waitForXRelationshipDelay(ms, expectedStep) {
  let remaining = Math.max(0, Number(ms) || 0);
  while (remaining > 0) {
    if (xRelationshipAutomationStopRequested) return false;
    if (getXRelationshipAutomationStep() !== expectedStep) return false;
    const step = Math.min(250, remaining);
    xAgentNextReplyMs = remaining;
    updateXAgentPanel(`Relationship · next author in ${Math.ceil(remaining / 1000)}s`);
    const started = Date.now();
    await sleep(step);
    remaining = Math.max(0, remaining - (Date.now() - started));
  }
  xAgentNextReplyMs = null;
  return !xRelationshipAutomationStopRequested
    && getXRelationshipAutomationStep() === expectedStep;
}

async function runXRelationshipAutomation() {
  if (isXRelationshipProfileScanPage() || STATE.settings?.xAgentEnabled !== true) return;
  if (xRelationshipAutomationRunning || xRelationshipAutomationStopRequested) return;
  xRelationshipAutomationRunning = true;
  let scheduleAgain = false;
  try {
    await refreshXRelationshipState(false);
    let author = currentXRelationshipAuthor();
    let session = xRelationshipState.session;
    if (!session?.active || session.auto !== true || !author) return;
    const initialStep = getXRelationshipAutomationStep(author);
    const initialAuthorId = author.id;
    if (initialStep === xRelationshipAutomationBlockedStep) return;

    if (currentXProfileHandle().toLowerCase() !== author.id) {
      navigateToCurrentXRelationshipAuthor();
      return;
    }
    if (!findXProfileIdentity(author.handle)) {
      scheduleAgain = true;
      return;
    }

    updateXAgentPanel(`Relationship · checking @${author.handle}`);
    await sleep(650);
    await refreshCurrentXRelationshipProfile(true);
    await refreshXRelationshipState(false);
    author = currentXRelationshipAuthor();
    session = xRelationshipState.session;
    if (!session?.active || session.auto !== true || !author || author.id !== initialAuthorId) {
      return;
    }

    if (xRelationshipAutomationStopRequested || getXRelationshipAutomationStep(author) !== initialStep) return;
    if (STATE.settings?.xRelationshipAutoFollow === true) {
      updateXAgentPanel(`Relationship · following @${author.handle}`);
      const followState = await followCurrentXRelationshipAuthor(author.handle);
      if (followState === 'following' && author.following !== true) {
        await xRelationshipCommand('patchAuthor', {
          handle: author.handle,
          patch: {
            following: true,
            lastCheckedAt: new Date().toISOString()
          }
        });
        await refreshXRelationshipState(false);
        author = currentXRelationshipAuthor();
      } else if (!followState) {
        showXRelationshipToast(`Could not confirm Follow for @${author.handle} · continuing`, true);
      }
    }

    session = xRelationshipState.session;
    if (xRelationshipAutomationStopRequested || getXRelationshipAutomationStep(author) !== initialStep
      || !session?.active || session.auto !== true || !author || author.id !== initialAuthorId) {
      return;
    }

    if (author.followsBack && session.replyToFollowers !== true) {
      showXRelationshipToast(`@${author.handle} follows you · moving to next author`);
      await completeCurrentXRelationshipAuthor(author.id);
      return;
    }

    const pending = currentXRelationshipPending();
    if (pending) {
      if (pending.interaction.status === 'sent') {
        const waited = await waitForXRelationshipDelay(getRandomAgentDelayMs(), initialStep);
        if (waited) await completeCurrentXRelationshipAuthor(author.id);
        return;
      }
      throw new Error('An unsent Relationship draft already exists. Send it or press Skip.');
    }

    updateXAgentPanel(`Relationship · finding a new post by @${author.handle}`);
    const article = await findNextXRelationshipTarget(author);
    if (!article) {
      showXRelationshipToast(`No new post found for @${author.handle} · skipped`);
      await completeCurrentXRelationshipAuthor(author.id);
      return;
    }

    article.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(550);
    ensureXAgentButtons();
    const button = article.querySelector(`.${X_AGENT_BUTTON_CLASS}`);
    const result = await runXAgentReply(article, button, {
      forceSubmit: true,
      recordRelationship: true,
      relationshipAuthor: author,
      throwOnError: false,
      silent: true
    });
    if (result?.cancelled) return;
    if (!result?.ok) throw new Error(result?.error || 'AI reply failed.');
    if (!result.sent) throw new Error('Reply was prepared but X did not confirm sending it.');

    await refreshXRelationshipState(false);
    const confirmed = currentXRelationshipPending();
    if (!confirmed || confirmed.author.id !== author.id || confirmed.interaction.status !== 'sent') {
      throw new Error('Reply was sent, but its CRM record was not confirmed.');
    }

    if (STATE.settings?.xRelationshipAutoLike === true) {
      updateXAgentPanel(`Relationship · liking @${author.handle}'s post`);
      const likedOriginal = await likeXRelationshipArticle(article);
      if (likedOriginal) {
        await xRelationshipCommand('patchInteraction', {
          handle: author.handle,
          interactionId: confirmed.interaction.id,
          patch: { likedOriginal: true }
        });
        await refreshXRelationshipState(false);
      } else {
        showXRelationshipToast(`Reply sent, but the post by @${author.handle} could not be liked`, true);
      }
    }

    const waited = await waitForXRelationshipDelay(getRandomAgentDelayMs(), initialStep);
    if (waited) await completeCurrentXRelationshipAuthor(author.id);
  } finally {
    xRelationshipAutomationRunning = false;
    xAgentNextReplyMs = null;
    updateXAgentPanel();
    if (scheduleAgain) scheduleXRelationshipAutomation(900);
  }
}

async function startXRelationshipSession() {
  if (xAgentRunning || xRelationshipAutomationRunning || xAgentActiveJobs > 0) {
    alert('Finish or stop the current X Agent job before starting Relationship Mode.');
    return;
  }
  updateXAgentPanel('Checking reply history');
  xRelationshipAutomationStopRequested = false;
  xRelationshipAutomationBlockedStep = '';
  await syncRecentXRepliesFromApi();
  const response = await xRelationshipCommand('startSession', {
    auto: true,
    replyToFollowers: STATE.settings?.xRelationshipReplyToFollowers === true
  });
  xRelationshipState = { authors: response.authors || [], session: response.session || null };
  updateXRelationshipControls();
  if (!currentXRelationshipAuthor()) {
    alert('Add at least one active author to Relationship CRM first.');
    return;
  }
  navigateToCurrentXRelationshipAuthor();
}

async function prepareCurrentXRelationshipReply() {
  const author = currentXRelationshipAuthor();
  if (!author) return;
  if (currentXRelationshipPending()) {
    alert('Finish the current draft or skip this author before preparing another reply.');
    return;
  }
  if (currentXProfileHandle().toLowerCase() !== author.id) {
    navigateToCurrentXRelationshipAuthor();
    return;
  }
  const article = await findNextXRelationshipTarget(author);
  if (!article) {
    alert(`No unprocessed recent post by @${author.handle} was found. Liked posts, existing replies, and CRM history were skipped.`);
    return;
  }
  article.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(500);
  const button = article.querySelector(`.${X_AGENT_BUTTON_CLASS}`);
  const result = await runXAgentReply(article, button, {
    forceDraft: true,
    recordRelationship: true,
    relationshipAuthor: author
  });
  if (result?.ok) updateXAgentPanel('Draft ready · send it in X');
}

async function completeCurrentXRelationshipAuthor(expectedAuthorId = '') {
  await refreshXRelationshipState(false);
  const author = currentXRelationshipAuthor();
  if (!author) return;
  if (expectedAuthorId && author.id !== String(expectedAuthorId).toLowerCase()) return false;
  const pending = currentXRelationshipPending();
  if (pending && pending.interaction.status !== 'sent') {
    alert('The prepared reply is not marked as sent. Send it with the native X Reply button, or use Skip.');
    return;
  }

  const target = pending
    ? findXRelationshipInteractionArticle(pending.interaction)
    : getXRelationshipTargetArticle(author);
  const likedOriginal = getXPostLiked(findXPostLikeButton(target));
  const following = readXProfileFollowing(author.handle) ?? author.following;
  const followsBack = detectXFollowsBack(author.handle) || author.followsBack === true;
  const now = new Date().toISOString();

  if (pending) {
    await xRelationshipCommand('patchInteraction', {
      handle: author.handle,
      interactionId: pending.interaction.id,
      patch: {
        ...(typeof likedOriginal === 'boolean' ? { likedOriginal } : {}),
        resultCheckedAt: now,
        resultSource: 'page'
      }
    });
  }
  await xRelationshipCommand('patchAuthor', {
    handle: author.handle,
    patch: { following, followsBack, lastCheckedAt: now }
  });
  const response = await xRelationshipCommand('advanceSession', {
    expectedHandle: expectedAuthorId ? author.handle : ''
  });
  xRelationshipPendingCompose = null;
  xRelationshipState = { authors: response.authors || [], session: response.session || null };
  updateXRelationshipControls();
  if (!xRelationshipState.session?.active) {
    updateXAgentPanel('Relationship session complete');
    playAgentSound('complete');
    chrome.runtime.sendMessage({ type: 'openXRelationshipDashboard' });
    return true;
  }
  navigateToCurrentXRelationshipAuthor();
  return true;
}

async function skipCurrentXRelationshipAuthor() {
  const pending = currentXRelationshipPending();
  if (pending && pending.interaction.status !== 'sent') {
    await xRelationshipCommand('patchInteraction', {
      handle: pending.author.handle,
      interactionId: pending.interaction.id,
      patch: { status: 'skipped' }
    });
  }
  const response = await xRelationshipCommand('advanceSession');
  xRelationshipPendingCompose = null;
  xRelationshipState = { authors: response.authors || [], session: response.session || null };
  updateXRelationshipControls();
  if (xRelationshipState.session?.active) navigateToCurrentXRelationshipAuthor();
  else updateXAgentPanel('Relationship session complete');
}

async function endXRelationshipSession() {
  xRelationshipAutomationStopRequested = true;
  xRelationshipAutomationBlockedStep = '';
  clearTimeout(xRelationshipAutomationTimer);
  xRelationshipAutomationTimer = null;
  const response = await xRelationshipCommand('endSession');
  xRelationshipPendingCompose = null;
  xRelationshipState = { authors: response.authors || [], session: response.session || null };
  clearXRelationshipHighlights();
  updateXRelationshipControls();
  updateXAgentPanel('Relationship session ended');
}

function updateXRelationshipControls() {
  document.querySelectorAll('.dth-x-relationship-track').forEach(button => {
    const handle = normalizeXHandle(button.dataset.handle);
    const tracked = !!trackedXAuthor(handle);
    button.dataset.tracked = String(tracked);
    button.textContent = tracked ? `✓ Tracking @${handle}` : `＋ Track @${handle}`;
  });
  if (!xAgentPanel) return;
  const section = xAgentPanel.querySelector('.dth-x-relationship-section');
  if (!section) return;
  const author = currentXRelationshipAuthor();
  const pending = currentXRelationshipPending();
  const replyToFollowers = xRelationshipState.session?.active
    ? xRelationshipState.session.replyToFollowers === true
    : STATE.settings?.xRelationshipReplyToFollowers === true;
  const count = xRelationshipState.authors.filter(item => {
    return item.status !== 'archived' && (replyToFollowers || !item.followsBack);
  }).length;
  const countNode = section.querySelector('.dth-x-relationship-count');
  const progress = section.querySelector('.dth-x-relationship-progress');
  const hint = section.querySelector('.dth-x-relationship-hint');
  const start = section.querySelector('.dth-x-relationship-start');
  const prepare = section.querySelector('.dth-x-relationship-prepare');
  const complete = section.querySelector('.dth-x-relationship-complete');
  const skip = section.querySelector('.dth-x-relationship-skip');
  const end = section.querySelector('.dth-x-relationship-end');
  if (countNode) countNode.textContent = `${count} active`;
  if (progress) progress.textContent = getXRelationshipProgressText();
  if (hint) {
    hint.textContent = author
      ? xRelationshipState.session?.auto
        ? author.followsBack && !replyToFollowers
          ? 'Follow-back detected. Moving to the next tracked author.'
          : author.followsBack
            ? 'Follow-back detected. Replying because replies to followers are enabled.'
          : pending?.interaction.status === 'sent'
            ? 'Reply sent. Waiting before the next tracked author.'
            : 'Automatic mode checks the profile, replies to one new post, and continues.'
        : pending
          ? pending.interaction.status === 'sent'
            ? 'Reply sent. Use native Like/Follow if needed, then press Next author.'
            : 'Draft inserted. Send it with the native X Reply button.'
          : 'Open the author profile and prepare one contextual draft.'
      : 'Only manually tracked authors are included.';
  }
  if (start) {
    start.hidden = !!author;
    start.disabled = count === 0 || xAgentRunning || xAgentActiveJobs > 0;
  }
  if (prepare) {
    prepare.hidden = !author || xRelationshipState.session?.auto === true;
    prepare.disabled = !!pending || xAgentActiveJobs > 0;
  }
  if (complete) {
    complete.hidden = !author
      || xRelationshipState.session?.auto === true
      || !pending
      || pending.interaction.status !== 'sent';
    complete.disabled = false;
    complete.textContent = xRelationshipState.session.index + 1 < xRelationshipState.session.queue.length
      ? 'Next author →'
      : 'Finish session ✓';
  }
  if (skip) {
    skip.hidden = !author;
    skip.disabled = xRelationshipAutomationRunning;
  }
  if (end) end.hidden = !author;
  section.classList.toggle('is-active', !!author);
}

function getFeedCandidates() {
  return Array.from(document.querySelectorAll(TWEET_SELECTOR))
    .filter(article => isVisible(article))
    .filter(article => {
      const meta = getTweetAuthorMeta(article);
      const author = trackedXAuthor(meta.handle);
      return !isXArticleAlreadyHandled(article, author);
    })
    .filter(article => !!getTweetText(article))
    .filter(article => !isPromotedTweet(article))
    .filter(article => !!findReplyButton(article))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

async function findNextFeedCandidates() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidates = getFeedCandidates();
    if (candidates.length) return candidates;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.82), behavior: 'smooth' });
    await sleep(1000);
  }
  return [];
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
    label = xAgentActiveJobs > 0 && xAgentNextReplyMs !== null ? 'Waiting before reply' : 'Running';
  } else if (xRelationshipAutomationRunning) {
    state = 'running';
    label = xAgentPanelStatus || 'Relationship running';
  } else if (xAgentActiveJobs > 0) {
    state = 'running';
    label = xAgentPanelStatus || 'Generating';
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
    start.disabled = xAgentRunning
      || xAgentActiveJobs > 0
      || xRelationshipAutomationRunning
      || (xRelationshipState.session?.active && xRelationshipState.session.auto === true);
    start.textContent = `▶ Start ${getAgentRunLimit()}`;
  }
  if (pause) {
    pause.disabled = !xAgentRunning || xAgentStopRequested;
    pause.textContent = xAgentPaused ? '▶ Resume' : 'Ⅱ Pause';
  }
  if (stop) stop.disabled = !xAgentRunning;
  xAgentPanel.dataset.state = state;
  xAgentPanel.classList.toggle('is-running', xAgentRunning || xRelationshipAutomationRunning);
  updateXRelationshipControls();
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
  if (xAgentRunning
    || xAgentActiveJobs > 0
    || xRelationshipAutomationRunning
    || (xRelationshipState.session?.active && xRelationshipState.session.auto === true)
    || !STATE.settings
    || STATE.settings.xAgentEnabled !== true) return;
  const limit = getAgentRunLimit();
  xAgentRunning = true;
  xAgentStopRequested = false;
  xAgentPaused = false;
  xAgentNextReplyMs = null;
  document.querySelectorAll(`.${X_AGENT_ACTIVE_CLASS}`).forEach(article => {
    article.classList.remove(X_AGENT_ACTIVE_CLASS);
  });
  ensureXAgentPanel();
  updateXAgentPanel('Checking reply history');
  await syncRecentXRepliesFromApi();
  updateXAgentPanel(`Running 0/${limit}`);

  let done = 0;
  let attempts = 0;
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    while (!xAgentStopRequested && done < limit && attempts < limit * 3) {
      await waitWhileXAgentPaused();
      if (xAgentStopRequested) break;
      const candidates = await findNextFeedCandidates();
      if (!candidates.length) break;

      const article = candidates.find(a => a.getBoundingClientRect().top > 60) || candidates[0];
      article.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(650);

      const btn = article.querySelector(`.${X_AGENT_BUTTON_CLASS}`);
      const result = await runXAgentReply(article, btn, { feedRun: true, throwOnError: false, silent: true });
      if (result?.cancelled) break;
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
  const relationship = createXRelationshipSection();
  const settings = createXAgentSettingsSection();
  body.append(
    header,
    statusMetric.row,
    nextMetric.row,
    todayMetric.row,
    divider,
    actions,
    relationship,
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

  const authorMeta = getTweetAuthorMeta(article);
  if (authorMeta.handle) {
    const track = document.createElement('button');
    track.type = 'button';
    track.className = 'dth-x-relationship-track';
    track.dataset.handle = authorMeta.handle;
    track.textContent = trackedXAuthor(authorMeta.handle)
      ? `✓ Tracking @${authorMeta.handle}`
      : `＋ Track @${authorMeta.handle}`;
    track.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    track.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (trackedXAuthor(authorMeta.handle)) {
        chrome.runtime.sendMessage({
          type: 'openXRelationshipDashboard',
          handle: authorMeta.handle
        });
        return;
      }
      track.disabled = true;
      track.textContent = 'Adding…';
      try {
        await trackXAuthor(authorMeta);
        showXRelationshipToast(`@${authorMeta.handle} added to Relationship CRM`);
      } catch (error) {
        track.textContent = 'Could not add';
        track.title = error.message || String(error);
        showXRelationshipToast(error.message || 'Could not add author', true);
      } finally {
        track.disabled = false;
      }
    });
    menu.appendChild(track);
  }
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
  if (area === 'local') {
    if (changes[X_AGENT_PROCESSED_POSTS_KEY]) {
      applyXAgentProcessedPosts(changes[X_AGENT_PROCESSED_POSTS_KEY].newValue);
    }
    if (changes[X_RELATIONSHIP_AUTHORS_KEY] || changes[X_RELATIONSHIP_SESSION_KEY]) {
      refreshXRelationshipState().catch(() => {});
    }
    return;
  }
  if (area !== 'sync') return;
  const uiLangChanged = changes.uiLang !== undefined;
  const postTranslationChanged = changes.translationEnabled !== undefined
    || changes.targetLang !== undefined;
  loadSettings().then(() => {
    if (postTranslationChanged) clearXPostTranslateButtons();
    scheduleXPostTranslateScan(100);
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
  if (msg && msg.type === 'xRelationshipInspectProfile') {
    inspectCurrentXProfileForCrm(msg.handle)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
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
    ensureXPostTranslateButtons();
  }
});

function getPendingXRelationshipCompose(root) {
  const pending = currentXRelationshipPending();
  if (!pending || !root) return null;
  const preferred = xRelationshipPendingCompose;
  if (root.contains(preferred) && isAvailableXCompose(preferred)) return preferred;
  const source = findXRelationshipInteractionArticle(pending.interaction);
  const expected = String(pending.interaction.replyText || '').trim();
  return Array.from(root.querySelectorAll(COMPOSE_SELECTORS.join(','))).find(compose =>
    isReusableXReplyCompose(compose, source) && readXComposeText(compose) === expected
  ) || null;
}

function findPostedXRelationshipReply(replyText) {
  const expected = String(replyText || '')
    .replace(/[\u200B\u200C\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!expected) return null;
  for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
    const actual = getTweetText(article)
      .replace(/[\u200B\u200C\u200D]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (actual !== expected) continue;
    const url = getTweetUrl(article);
    const match = url.match(/\/status\/(\d{1,19})/);
    if (match) return { postId: match[1], url };
  }
  const toastLink = document.querySelector(
    '[data-testid="toast"] a[href*="/status/"], [role="alert"] a[href*="/status/"], ' +
    '[data-sonner-toast]:not([data-type="error"]) a[href*="/status/"]'
  );
  if (toastLink) {
    const url = new URL(toastLink.href, location.href).href;
    const match = url.match(/\/status\/(\d{1,19})/);
    if (match) return { postId: match[1], url };
  }
  return null;
}

async function waitForPostedXRelationshipReply(replyText, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const postedReply = findPostedXRelationshipReply(replyText);
    if (postedReply) return postedReply;
    await sleep(attempt === 0 ? 500 : 250);
  }
  return null;
}

async function confirmNativeXRelationshipSubmission(compose) {
  const replyText = readXComposeText(compose);
  if (replyText && await waitForXReplySubmission(compose, getXReplySubmissionFeedback())) {
    await markCurrentXRelationshipReplySent(replyText, await waitForPostedXRelationshipReply(replyText));
  }
}

document.addEventListener('click', event => {
  if (!event.isTrusted) return;
  const submit = event.target?.closest?.('button, [role="button"]');
  if (!submit) return;
  const root = submit.closest('[role="dialog"]') || submit.closest('form') || document;
  const compose = getPendingXRelationshipCompose(root);
  if (!compose || findSubmitButton(compose) !== submit) return;
  confirmNativeXRelationshipSubmission(compose).catch(error => {
    console.debug('[DTH Relationship] could not mark sent reply', error);
  });
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
  const root = event.target?.closest?.('[role="dialog"]') || event.target?.closest?.('form') || document;
  const compose = getPendingXRelationshipCompose(root);
  if (compose?.contains(event.target)) confirmNativeXRelationshipSubmission(compose).catch(() => {});
}, true);

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

cleanupStaleXPostTranslationUi();
loadSettings().then(() => {
  setupButton();
  scheduleXPostTranslateScan(350);
  if (STATE.settings && STATE.settings.xAgentEnabled === true) {
    ensureXAgentPanel();
    scheduleXAgentScan(1200);
    scheduleXRelationshipScan(1350);
  }
});

// X — SPA, перерисовывает много, следим за DOM и обновляем позицию.
const observer = new MutationObserver(() => {
  positionButton();
  scheduleXPostTranslateScan(650);
  scheduleXAgentScan(1000);
  scheduleXRelationshipScan(1100);
});
observer.observe(document.body, { childList: true, subtree: true });
