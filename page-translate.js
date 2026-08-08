(() => {
  'use strict';

  const IS_TOP_FRAME = window.top === window;
  const FULL_PAGE_ALLOWED = IS_TOP_FRAME && location.hostname !== 'chatgpt.com';
  const MAX_INITIAL_NODES = 1200;
  const MAX_DYNAMIC_NODES = 300;
  const MAX_TOTAL_CHARS = 120000;
  const PAGE_AUTO_COLLAPSE_MS = 5000;
  const PAGE_CONTROL_POSITION_KEY = `dthPageTranslationPosition:${location.hostname}`;
  const LANGUAGES = [
    ['ru', 'Russian'], ['en', 'English'], ['uk', 'Ukrainian'],
    ['kk', 'Kazakh'], ['be', 'Belarusian'], ['de', 'German'],
    ['fr', 'French'], ['es', 'Spanish'], ['pt', 'Portuguese'],
    ['tr', 'Turkish'], ['pl', 'Polish'], ['ar', 'Arabic'],
    ['ja', 'Japanese'], ['zh', 'Chinese']
  ];
  const LANGUAGE_NAMES = Object.fromEntries(LANGUAGES);
  const SPEECH_LANGUAGES = {
    ru: 'ru-RU', en: 'en-US', uk: 'uk-UA', kk: 'kk-KZ', be: 'be-BY',
    de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-PT', tr: 'tr-TR',
    pl: 'pl-PL', ar: 'ar-SA', ja: 'ja-JP', zh: 'zh-CN'
  };
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp',
    'textarea', 'input', 'select', 'option', 'svg', 'math',
    '[contenteditable="true"]', '[contenteditable=""]', '[translate="no"]',
    '.notranslate', '[data-dth-page-ui]', '[class*="dth-"]', '[id^="dth-"]'
  ].join(',');

  const state = {
    settings: {},
    operation: 0,
    translating: false,
    translated: false,
    targetLang: 'ru',
    originals: new Map(),
    processedNodes: new WeakSet(),
    mutedNodes: new WeakSet(),
    originalDocumentLang: null,
    originalDocumentLangCaptured: false,
    selectionAnchor: null,
    selectionText: '',
    selectionCapturedAt: 0,
    selectionRequest: 0,
    dynamicTimer: null,
    dynamicRunning: false,
    autoPending: false,
    initialRetryTimer: null,
    pageAutoCollapseTimer: null,
    pageControlPosition: null,
    pageControlDraggedUntil: 0
  };

  let uiHost = null;
  let shadow = null;
  let pageBar = null;
  let pageStatus = null;
  let pageProgress = null;
  let pageLanguage = null;
  let pageUndo = null;
  let pageMini = null;
  let selectionCard = null;
  let activeSpeechButton = null;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .hidden { display: none !important; }
    button, select { font: inherit; }
    .page-bar, .page-mini, .selection-card {
      color: #f4f5f7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      pointer-events: auto;
    }
    .page-bar {
      position: fixed;
      top: 12px;
      right: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: calc(100vw - 24px);
      min-height: 46px;
      padding: 7px 8px 7px 11px;
      border: 1px solid rgba(124, 108, 245, .55);
      border-radius: 14px;
      background: rgba(18, 18, 30, .96);
      box-shadow: 0 14px 40px rgba(0, 0, 0, .38);
      backdrop-filter: blur(14px);
      cursor: grab;
      touch-action: none;
      user-select: none;
    }
    .page-bar.dragging { cursor: grabbing; }
    .page-icon { font-size: 18px; line-height: 1; }
    .page-copy { min-width: 116px; max-width: 220px; }
    .page-status {
      display: block;
      overflow: hidden;
      color: #f5f4ff;
      font-size: 12px;
      font-weight: 800;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .page-progress {
      display: block;
      margin-top: 2px;
      color: #9693b8;
      font-size: 9px;
      line-height: 1.2;
    }
    .page-bar select, .selection-card select {
      min-height: 31px;
      padding: 0 27px 0 9px;
      border: 1px solid #39364f;
      border-radius: 9px;
      outline: none;
      background: #191824;
      color: #ececf5;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
    }
    .page-bar button, .page-bar select { cursor: pointer; }
    .page-bar button, .selection-card button {
      min-height: 31px;
      padding: 0 10px;
      border: 1px solid #39364f;
      border-radius: 9px;
      background: #242235;
      color: #e8e7f2;
      cursor: pointer;
      font-size: 11px;
      font-weight: 750;
      transition: background .14s ease, border-color .14s ease, color .14s ease;
    }
    .page-bar button:hover, .selection-card button:hover {
      border-color: #7465e8;
      background: #302d48;
      color: #fff;
    }
    .page-bar button:disabled, .selection-card button:disabled,
    .page-bar select:disabled, .selection-card select:disabled {
      cursor: default;
      opacity: .5;
    }
    .page-undo { border-color: rgba(124, 108, 245, .65) !important; }
    .page-close { width: 31px; padding: 0 !important; font-size: 17px !important; }
    .page-mini {
      position: fixed;
      top: 12px;
      right: 12px;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid rgba(124, 108, 245, .55);
      border-radius: 10px;
      background: rgba(18, 18, 30, .78);
      box-shadow: 0 10px 30px rgba(0, 0, 0, .34);
      color: #fff;
      cursor: grab;
      font-size: 14px;
      opacity: .38;
      backdrop-filter: blur(12px);
      touch-action: none;
      transition: opacity .18s ease, transform .18s ease, background .18s ease;
    }
    .page-mini:hover, .page-mini.dragging { opacity: 1; transform: scale(1.04); }
    .selection-card {
      position: fixed;
      top: 80px;
      left: 24px;
      width: min(430px, calc(100vw - 24px));
      max-height: min(560px, calc(100vh - 24px));
      overflow: hidden;
      border: 1px solid rgba(124, 108, 245, .6);
      border-radius: 17px;
      background: rgba(18, 18, 30, .975);
      box-shadow: 0 18px 55px rgba(0, 0, 0, .46);
      backdrop-filter: blur(16px);
    }
    .selection-card.side { width: min(760px, calc(100vw - 24px)); }
    .selection-head {
      display: flex;
      align-items: center;
      gap: 9px;
      min-height: 47px;
      padding: 8px 9px 8px 13px;
      border-bottom: 1px solid #2c2a3d;
      cursor: grab;
      user-select: none;
    }
    .selection-head.dragging { cursor: grabbing; }
    .selection-title { flex: 1; font-size: 12px; font-weight: 850; }
    .selection-head select, .selection-head button { cursor: pointer; }
    .selection-close { width: 31px; padding: 0 !important; font-size: 17px !important; }
    .selection-content {
      display: grid;
      grid-template-columns: 1fr;
      max-height: 390px;
      overflow: auto;
    }
    .selection-card.side .selection-content { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .selection-pane { min-width: 0; padding: 13px 15px 16px; }
    .selection-pane.original { display: none; border-right: 1px solid #2c2a3d; }
    .selection-card.side .selection-pane.original { display: block; }
    .pane-label {
      display: block;
      margin-bottom: 7px;
      color: #8f8ba8;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .pane-text {
      color: #ececf5;
      font-size: 13px;
      line-height: 1.55;
      overflow-wrap: anywhere;
      user-select: text;
      white-space: break-spaces;
      tab-size: 4;
    }
    .pane-text.loading { color: #aaa5c6; }
    .pane-text.error { color: #ff8798; }
    .selection-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      padding: 9px 11px 11px;
      border-top: 1px solid #2c2a3d;
    }
    .selection-actions .copy {
      margin-left: auto;
      border-color: #796bee;
      background: #5f50d2;
      color: #fff !important;
    }
    .selection-actions .copy:hover {
      border-color: #9388ff;
      background: #7162e4;
      color: #fff !important;
    }
    .selection-actions .copy:disabled { color: #dedaff !important; }
    .selection-actions .speak.is-speaking {
      border-color: #8b7df0;
      background: #463f78;
      color: #fff;
    }
    @media (max-width: 620px) {
      .page-bar { align-items: stretch; flex-wrap: wrap; }
      .page-copy { flex: 1; }
      .selection-card.side .selection-content { grid-template-columns: 1fr; }
      .selection-card.side .selection-pane.original { border-right: 0; border-bottom: 1px solid #2c2a3d; }
    }
    @media (prefers-color-scheme: light) {
      .page-bar, .page-mini, .selection-card {
        border-color: rgba(91, 75, 214, .36);
        background: rgba(255, 255, 255, .975);
        color: #17152b;
        box-shadow: 0 14px 42px rgba(30, 24, 65, .18);
      }
      .page-status, .selection-title, .pane-text { color: #17152b; }
      .page-progress, .pane-label { color: #6f6989; }
      .page-bar select, .selection-card select {
        border-color: #d8d4e8;
        background: #f7f6fc;
        color: #29253e;
      }
      .page-bar button, .selection-card button {
        border-color: #d8d4e8;
        background: #f1eff8;
        color: #332e4b;
      }
      .selection-head, .selection-actions { border-color: #e2deee; }
      .selection-pane.original { border-color: #e2deee; }
    }
  `;

  function callBackground(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || response.ok !== true) {
          reject(new Error(response?.error || 'No response from extension background.'));
          return;
        }
        resolve(response);
      });
    });
  }

  function loadSettings() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'getSettings' }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || {});
      });
    });
  }

  function loadPageControlPosition() {
    return new Promise(resolve => {
      chrome.storage.local.get(PAGE_CONTROL_POSITION_KEY, result => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const value = result?.[PAGE_CONTROL_POSITION_KEY];
        resolve(value && Number.isFinite(value.top) && Number.isFinite(value.right) ? value : null);
      });
    });
  }

  function clampPageControlPosition(element, position) {
    const width = element.offsetWidth || (element.classList.contains('page-mini') ? 30 : 420);
    const height = element.offsetHeight || (element.classList.contains('page-mini') ? 30 : 46);
    return {
      top: Math.max(8, Math.min(window.innerHeight - height - 8, position.top)),
      right: Math.max(8, Math.min(window.innerWidth - width - 8, position.right))
    };
  }

  function applyPageControlPosition() {
    if (!state.pageControlPosition) return;
    for (const element of [pageBar, pageMini]) {
      if (!element) continue;
      const position = clampPageControlPosition(element, state.pageControlPosition);
      element.style.top = `${position.top}px`;
      element.style.right = `${position.right}px`;
      element.style.left = 'auto';
    }
  }

  function savePageControlPosition() {
    if (!state.pageControlPosition) return;
    chrome.storage.local.set({ [PAGE_CONTROL_POSITION_KEY]: state.pageControlPosition });
  }

  function makePageControlDraggable(element) {
    let drag = null;
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || (element === pageBar && event.target.closest('button, select'))) return;
      const rect = element.getBoundingClientRect();
      drag = {
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        moved: false
      };
      if (element === pageBar) {
        clearTimeout(state.pageAutoCollapseTimer);
        state.pageAutoCollapseTimer = null;
      }
      element.setPointerCapture(event.pointerId);
      element.classList.add('dragging');
      event.preventDefault();
    });
    element.addEventListener('pointermove', event => {
      if (!drag) return;
      const left = event.clientX - drag.dx;
      const top = event.clientY - drag.dy;
      if (Math.abs(left - element.getBoundingClientRect().left) > 2
          || Math.abs(top - element.getBoundingClientRect().top) > 2) {
        drag.moved = true;
      }
      const position = clampPageControlPosition(element, {
        top,
        right: window.innerWidth - left - (element.offsetWidth || 30)
      });
      state.pageControlPosition = position;
      applyPageControlPosition();
    });
    const finish = event => {
      if (!drag) return;
      if (drag.moved) {
        state.pageControlDraggedUntil = Date.now() + 180;
        savePageControlPosition();
      }
      if (element === pageBar && state.translated) schedulePageAutoCollapse();
      drag = null;
      element.classList.remove('dragging');
      try { element.releasePointerCapture(event.pointerId); } catch { }
    };
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
  }

  function collapsePageControls() {
    if (!pageBar || !pageMini) return;
    pageBar.classList.add('hidden');
    pageMini.classList.remove('hidden');
    applyPageControlPosition();
  }

  function schedulePageAutoCollapse() {
    clearTimeout(state.pageAutoCollapseTimer);
    state.pageAutoCollapseTimer = setTimeout(() => {
      state.pageAutoCollapseTimer = null;
      if (!state.translated || state.translating) return;
      if (pageBar?.matches(':hover')) {
        schedulePageAutoCollapse();
        return;
      }
      collapsePageControls();
    }, PAGE_AUTO_COLLAPSE_MS);
  }

  function fillLanguageSelect(select, selected) {
    select.replaceChildren();
    for (const [code, name] of LANGUAGES) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${name} (${code === 'uk' ? 'UA' : code.toUpperCase()})`;
      select.append(option);
    }
    select.value = LANGUAGE_NAMES[selected] ? selected : 'ru';
  }

  function ensureUi() {
    if (uiHost?.isConnected) return;
    uiHost = document.createElement('div');
    uiHost.dataset.dthPageUi = 'true';
    Object.assign(uiHost.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      width: '0',
      height: '0',
      zIndex: '2147483647',
      pointerEvents: 'none'
    });
    shadow = uiHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.append(style);
    document.documentElement.append(uiHost);
  }

  function ensurePageBar() {
    if (!FULL_PAGE_ALLOWED) return null;
    ensureUi();
    if (pageBar) return pageBar;

    pageBar = document.createElement('div');
    pageBar.className = 'page-bar hidden';

    const icon = document.createElement('span');
    icon.className = 'page-icon';
    icon.textContent = '🌐';

    const copy = document.createElement('span');
    copy.className = 'page-copy';
    pageStatus = document.createElement('strong');
    pageStatus.className = 'page-status';
    pageProgress = document.createElement('small');
    pageProgress.className = 'page-progress';
    copy.append(pageStatus, pageProgress);

    pageLanguage = document.createElement('select');
    pageLanguage.title = 'Translate page to';
    fillLanguageSelect(pageLanguage, state.targetLang);
    pageLanguage.addEventListener('change', () => {
      const targetLang = pageLanguage.value;
      if (!LANGUAGE_NAMES[targetLang]) return;
      chrome.storage.sync.set({ pageTranslationTargetLang: targetLang });
    });

    pageUndo = document.createElement('button');
    pageUndo.type = 'button';
    pageUndo.className = 'page-undo';
    pageUndo.textContent = 'Undo';
    pageUndo.addEventListener('click', () => {
      state.autoPending = false;
      restorePage({ hideBar: false });
    });

    const minimize = document.createElement('button');
    minimize.type = 'button';
    minimize.className = 'page-close';
    minimize.textContent = '×';
    minimize.title = 'Minimize';
    minimize.addEventListener('click', () => {
      clearTimeout(state.pageAutoCollapseTimer);
      collapsePageControls();
    });

    pageMini = document.createElement('button');
    pageMini.type = 'button';
    pageMini.className = 'page-mini hidden';
    pageMini.textContent = '🌐';
    pageMini.title = 'Show page translation controls';
    pageMini.addEventListener('click', () => {
      if (Date.now() < state.pageControlDraggedUntil) return;
      pageMini.classList.add('hidden');
      pageBar.classList.remove('hidden');
      applyPageControlPosition();
    });

    pageBar.append(icon, copy, pageLanguage, pageUndo, minimize);
    shadow.append(pageBar, pageMini);
    makePageControlDraggable(pageBar);
    makePageControlDraggable(pageMini);
    applyPageControlPosition();
    return pageBar;
  }

  function showPageStatus(status, detail = '', { reveal = true } = {}) {
    const bar = ensurePageBar();
    if (!bar) return;
    if (reveal) {
      bar.classList.remove('hidden');
      pageMini.classList.add('hidden');
      applyPageControlPosition();
    }
    pageStatus.textContent = status;
    pageProgress.textContent = detail;
  }

  function setPageControlsBusy(busy) {
    if (pageLanguage) pageLanguage.disabled = busy;
    if (pageUndo) {
      pageUndo.disabled = !busy && state.originals.size === 0;
      pageUndo.textContent = busy ? 'Cancel' : 'Undo';
    }
  }

  function updateBadge(active, targetLang = '') {
    if (!IS_TOP_FRAME) return;
    chrome.runtime.sendMessage({
      type: 'pageTranslationBadge',
      active,
      targetLang
    }, () => void chrome.runtime.lastError);
  }

  function hasTranslatableText(text) {
    const value = String(text || '').trim();
    if (value.length < 2 || !/[\p{L}]/u.test(value)) return false;
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(value)) return false;
    if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(value)) return false;
    return true;
  }

  function isEligibleNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || state.processedNodes.has(node)) return false;
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP_SELECTOR)) return false;
    return hasTranslatableText(node.data);
  }

  function collectTextNodes(root, limit) {
    const nodes = [];
    let chars = 0;
    const add = node => {
      if (!isEligibleNode(node)) return;
      const length = node.data.trim().length;
      if (chars + length > MAX_TOTAL_CHARS || nodes.length >= limit) return;
      chars += length;
      nodes.push(node);
    };

    if (root?.nodeType === Node.TEXT_NODE) add(root);
    const walkerRoot = root?.nodeType === Node.ELEMENT_NODE ? root : document.documentElement;
    if (!walkerRoot) return nodes;
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && nodes.length < limit && chars < MAX_TOTAL_CHARS) add(node);
    return nodes;
  }

  function splitWhitespace(value) {
    const leading = value.match(/^\s*/)?.[0] || '';
    const trailing = value.match(/\s*$/)?.[0] || '';
    return {
      leading,
      trailing,
      core: value.slice(leading.length, value.length - trailing.length)
    };
  }

  async function translateNodes(nodes, targetLang, operation, onProgress) {
    const grouped = new Map();
    for (const node of nodes) {
      if (!isEligibleNode(node)) continue;
      const original = node.data;
      const parts = splitWhitespace(original);
      if (!parts.core) continue;
      if (!grouped.has(parts.core)) grouped.set(parts.core, []);
      grouped.get(parts.core).push({ node, original, ...parts });
    }

    const unique = Array.from(grouped.entries()).map(([text, entries]) => ({ text, entries }));
    let completed = 0;
    let applied = 0;

    for (let offset = 0; offset < unique.length; offset += 160) {
      if (operation !== state.operation) return applied;
      const chunk = unique.slice(offset, offset + 160);
      const response = await callBackground({
        type: 'translatePageSegments',
        segments: chunk.map(item => item.text),
        targetLang
      });
      if (operation !== state.operation) return applied;

      chunk.forEach((item, index) => {
        const translated = String(response.translations?.[index] || item.text).trim();
        for (const entry of item.entries) {
          const { node, original, leading, trailing } = entry;
          if (!node.isConnected || node.data !== original) continue;
          state.processedNodes.add(node);
          if (translated === item.text) continue;
          const nextValue = `${leading}${translated}${trailing}`;
          state.originals.set(node, { original, translated: nextValue });
          state.mutedNodes.add(node);
          node.data = nextValue;
          applied++;
        }
      });

      completed += chunk.length;
      onProgress?.(completed, unique.length);
    }
    return applied;
  }

  function restorePage({ hideBar = false, bumpOperation = true } = {}) {
    clearTimeout(state.pageAutoCollapseTimer);
    state.pageAutoCollapseTimer = null;
    if (bumpOperation) state.operation++;
    state.translating = false;
    for (const [node, record] of state.originals) {
      if (!node.isConnected) continue;
      state.mutedNodes.add(node);
      node.data = record.original;
    }
    state.originals.clear();
    state.processedNodes = new WeakSet();
    state.translated = false;
    state.dynamicRunning = false;
    if (state.originalDocumentLang === null) {
      document.documentElement.removeAttribute('lang');
    } else {
      document.documentElement.setAttribute('lang', state.originalDocumentLang);
    }
    updateBadge(false);
    setPageControlsBusy(false);
    if (pageStatus) {
      pageStatus.textContent = 'Original page restored';
      pageProgress.textContent = '';
    }
    if (hideBar && pageBar) {
      pageBar.classList.add('hidden');
      pageMini.classList.add('hidden');
    }
  }

  async function translateWholePage(targetLang) {
    if (!FULL_PAGE_ALLOWED || !LANGUAGE_NAMES[targetLang]) return;
    clearTimeout(state.pageAutoCollapseTimer);
    state.pageAutoCollapseTimer = null;
    const operation = ++state.operation;
    if (state.originals.size) restorePage({ hideBar: false, bumpOperation: false });

    state.targetLang = targetLang;
    state.translating = true;
    state.translated = false;
    if (!state.originalDocumentLangCaptured) {
      state.originalDocumentLang = document.documentElement.getAttribute('lang');
      state.originalDocumentLangCaptured = true;
    }
    ensurePageBar();
    fillLanguageSelect(pageLanguage, targetLang);
    showPageStatus('Translating page…', 'Collecting text');
    setPageControlsBusy(true);

    try {
      const nodes = collectTextNodes(document.documentElement, MAX_INITIAL_NODES);
      if (!nodes.length) {
        state.translating = false;
        showPageStatus('Nothing to translate', 'No readable page text was found');
        setPageControlsBusy(false);
        return;
      }
      await translateNodes(nodes, targetLang, operation, (done, total) => {
        showPageStatus('Translating page…', `${done} / ${total} text blocks`);
      });
      if (operation !== state.operation) return;

      state.translating = false;
      state.translated = state.originals.size > 0;
      state.autoPending = false;
      document.documentElement.setAttribute('lang', targetLang);
      const name = LANGUAGE_NAMES[targetLang] || targetLang.toUpperCase();
      showPageStatus(`Page translated to ${name}`, `${state.originals.size} text nodes replaced`);
      setPageControlsBusy(false);
      updateBadge(state.translated, targetLang);
      scheduleDynamicTranslation();
      schedulePageAutoCollapse();
    } catch (error) {
      if (operation !== state.operation) return;
      state.autoPending = false;
      restorePage({ hideBar: false, bumpOperation: false });
      showPageStatus('Page translation failed', error.message || String(error));
    }
  }

  function scheduleDynamicTranslation() {
    if (!FULL_PAGE_ALLOWED || !state.translated || state.translating || state.dynamicTimer) return;
    state.dynamicTimer = setTimeout(async () => {
      state.dynamicTimer = null;
      if (!state.translated || state.translating || state.dynamicRunning) return;
      const nodes = collectTextNodes(document.documentElement, MAX_DYNAMIC_NODES);
      if (!nodes.length) return;
      state.dynamicRunning = true;
      const operation = state.operation;
      try {
        await translateNodes(nodes, state.targetLang, operation);
        if (operation === state.operation) {
          const name = LANGUAGE_NAMES[state.targetLang] || state.targetLang.toUpperCase();
          showPageStatus(
            `Page translated to ${name}`,
            `${state.originals.size} text nodes replaced`,
            { reveal: false }
          );
          setPageControlsBusy(false);
        }
      } catch (error) {
        console.warn('[AI Helper] Dynamic page translation failed:', error);
      } finally {
        state.dynamicRunning = false;
      }
    }, 650);
  }

  function scheduleInitialTranslationRetry() {
    if (!FULL_PAGE_ALLOWED || !state.autoPending || state.translating || state.initialRetryTimer) return;
    state.initialRetryTimer = setTimeout(() => {
      state.initialRetryTimer = null;
      if (!state.autoPending || state.translating || state.translated) return;
      const target = state.settings.pageTranslationTargetLang || state.settings.targetLang || 'ru';
      translateWholePage(target);
    }, 700);
  }

  function clampCardPosition(card, left, top) {
    const width = card.offsetWidth || 430;
    const height = card.offsetHeight || 280;
    return {
      left: Math.max(8, Math.min(window.innerWidth - width - 8, left)),
      top: Math.max(8, Math.min(window.innerHeight - height - 8, top))
    };
  }

  function positionSelectionCard(card) {
    const anchor = state.selectionAnchor || { x: 20, y: 70 };
    requestAnimationFrame(() => {
      const position = clampCardPosition(card, anchor.x, anchor.y + 8);
      card.style.left = `${position.left}px`;
      card.style.top = `${position.top}px`;
    });
  }

  function makeSelectionCardDraggable(card, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button, select')) return;
      const rect = card.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag) return;
      const position = clampCardPosition(card, event.clientX - drag.dx, event.clientY - drag.dy);
      card.style.left = `${position.left}px`;
      card.style.top = `${position.top}px`;
    });
    const finish = event => {
      if (!drag) return;
      drag = null;
      handle.classList.remove('dragging');
      try { handle.releasePointerCapture(event.pointerId); } catch { }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const previous = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = previous; }, 1000);
    } catch {
      button.textContent = 'Copy failed';
    }
  }

  function stopSpeech() {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    if (activeSpeechButton) {
      activeSpeechButton.classList.remove('is-speaking');
      activeSpeechButton = null;
    }
  }

  function resolveSpeechLanguage(code) {
    const normalized = String(code || '').toLowerCase().split('-')[0];
    if (SPEECH_LANGUAGES[normalized]) return SPEECH_LANGUAGES[normalized];
    const pageLanguageCode = document.documentElement.lang || navigator.language || 'en-US';
    return SPEECH_LANGUAGES[pageLanguageCode.toLowerCase().split('-')[0]] || pageLanguageCode;
  }

  function createSelectionTranslationPlan(text) {
    const value = String(text || '');
    const newline = value.includes('\r\n') ? '\r\n' : (value.includes('\r') ? '\r' : '\n');
    const lines = value.split(/\r\n|\n|\r/);
    const entries = [];
    const protectedValues = new Map();
    let tokenIndex = 0;

    const protectValue = (match, kind) => {
      const token = `[[DTH_${kind}_${tokenIndex++}_9F4A]]`;
      protectedValues.set(token, match);
      return token;
    };

    const protectInlineFormatting = source => {
      let protectedText = source;
      if (typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        protectedText = Array.from(segmenter.segment(protectedText), item => {
          return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(item.segment)
            ? protectValue(item.segment, 'EMOJI')
            : item.segment;
        }).join('');
      }
      return protectedText.replace(/\t+| {2,}/g, match => protectValue(match, 'SPACE'));
    };

    lines.forEach((line, lineIndex) => {
      if (!line.trim()) return;
      const leading = line.match(/^[\t ]*/)?.[0] || '';
      const trailing = line.match(/[\t ]*$/)?.[0] || '';
      const core = line.slice(leading.length, line.length - trailing.length);
      entries.push({
        id: entries.length,
        lineIndex,
        leading,
        trailing,
        protectedCore: protectInlineFormatting(core)
      });
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

  function restoreProtectedValues(text, protectedValues) {
    let value = String(text || '');
    for (const [token, original] of protectedValues) {
      value = value.split(token).join(original);
    }
    return value;
  }

  function rebuildSelectionTranslation(plan, translations) {
    if (!plan.entries.length) return plan.value;
    const outputLines = plan.lines.slice();
    plan.entries.forEach((entry, index) => {
      const translated = Array.isArray(translations) ? translations[index] : '';
      const restored = restoreProtectedValues(translated || entry.protectedCore, plan.protectedValues);
      const core = restored.replace(/\s*(?:\r\n|\n|\r)+\s*/g, ' ').trim();
      outputLines[entry.lineIndex] = `${entry.leading}${core}${entry.trailing}`;
    });
    return outputLines.join(plan.newline);
  }

  function speakText(text, languageCode, button) {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
    if (activeSpeechButton === button && window.speechSynthesis.speaking) {
      stopSpeech();
      return;
    }

    stopSpeech();
    const value = String(text || '');
    if (!value.trim()) return;
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.lang = resolveSpeechLanguage(languageCode);
    utterance.onstart = () => {
      activeSpeechButton = button;
      button.classList.add('is-speaking');
    };
    const finish = () => {
      if (activeSpeechButton !== button) return;
      button.classList.remove('is-speaking');
      activeSpeechButton = null;
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  }

  async function translateSelectionText(text, targetLang, output, copyButton, speakButton, originalText) {
    const request = ++state.selectionRequest;
    stopSpeech();
    output.className = 'pane-text loading';
    output.textContent = 'Translating…';
    copyButton.disabled = true;
    speakButton.disabled = true;
    const plan = createSelectionTranslationPlan(text);
    try {
      const response = await callBackground({
        type: 'translateSelectionSegments',
        segments: plan.segments,
        targetLang,
        sourceLang: 'auto',
        preserveFormatting: true
      });
      if (request !== state.selectionRequest) return;
      output.className = 'pane-text';
      output.textContent = rebuildSelectionTranslation(plan, response.translations);
      output.dataset.language = targetLang;
      originalText.dataset.language = response.detected || 'auto';
      copyButton.disabled = false;
      speakButton.disabled = !('speechSynthesis' in window);
    } catch (error) {
      if (request !== state.selectionRequest) return;
      output.className = 'pane-text error';
      output.textContent = error.message || String(error);
      speakButton.disabled = true;
    }
  }

  function showSelectionTranslation(rawText) {
    const text = String(rawText || '').slice(0, 12000);
    if (!text.trim()) return;
    ensureUi();
    stopSpeech();
    selectionCard?.remove();

    const card = document.createElement('section');
    card.className = 'selection-card';

    const head = document.createElement('header');
    head.className = 'selection-head';
    const title = document.createElement('strong');
    title.className = 'selection-title';
    title.textContent = '🌐 Selection translation';
    const language = document.createElement('select');
    const defaultTarget = state.settings.pageTranslationTargetLang || state.settings.targetLang || 'ru';
    fillLanguageSelect(language, defaultTarget);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'selection-close';
    close.textContent = '×';
    close.title = 'Close';
    head.append(title, language, close);

    const content = document.createElement('div');
    content.className = 'selection-content';
    const originalPane = document.createElement('div');
    originalPane.className = 'selection-pane original';
    const originalLabel = document.createElement('span');
    originalLabel.className = 'pane-label';
    originalLabel.textContent = 'Original';
    const originalText = document.createElement('div');
    originalText.className = 'pane-text';
    originalText.textContent = text;
    originalPane.append(originalLabel, originalText);

    const translatedPane = document.createElement('div');
    translatedPane.className = 'selection-pane';
    const translatedLabel = document.createElement('span');
    translatedLabel.className = 'pane-label';
    translatedLabel.textContent = 'Translation';
    const translatedText = document.createElement('div');
    translatedText.className = 'pane-text loading';
    translatedText.textContent = 'Translating…';
    translatedPane.append(translatedLabel, translatedText);
    content.append(originalPane, translatedPane);

    const actions = document.createElement('footer');
    actions.className = 'selection-actions';
    const sideBySide = document.createElement('button');
    sideBySide.type = 'button';
    sideBySide.textContent = 'Show original';
    const nearOriginal = document.createElement('button');
    nearOriginal.type = 'button';
    nearOriginal.textContent = 'Place by original';
    const speakOriginal = document.createElement('button');
    speakOriginal.type = 'button';
    speakOriginal.className = 'speak';
    speakOriginal.textContent = '🔊 Original';
    speakOriginal.title = 'Listen to original';
    speakOriginal.disabled = !('speechSynthesis' in window);
    const speakTranslation = document.createElement('button');
    speakTranslation.type = 'button';
    speakTranslation.className = 'speak';
    speakTranslation.textContent = '🔊 Translation';
    speakTranslation.title = 'Listen to translation';
    speakTranslation.disabled = true;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copy translation';
    copy.disabled = true;
    actions.append(sideBySide, nearOriginal, speakOriginal, speakTranslation, copy);

    card.append(head, content, actions);
    shadow.append(card);
    selectionCard = card;
    positionSelectionCard(card);
    makeSelectionCardDraggable(card, head);

    close.addEventListener('click', () => {
      state.selectionRequest++;
      stopSpeech();
      card.remove();
      if (selectionCard === card) selectionCard = null;
    });
    sideBySide.addEventListener('click', () => {
      const side = card.classList.toggle('side');
      sideBySide.textContent = side ? 'Hide original' : 'Show original';
      positionSelectionCard(card);
    });
    nearOriginal.addEventListener('click', () => positionSelectionCard(card));
    speakOriginal.addEventListener('click', () => {
      speakText(originalText.textContent, originalText.dataset.language, speakOriginal);
    });
    speakTranslation.addEventListener('click', () => {
      speakText(translatedText.textContent, translatedText.dataset.language || language.value, speakTranslation);
    });
    copy.addEventListener('click', () => copyText(translatedText.textContent, copy));
    language.addEventListener('change', () => {
      translateSelectionText(text, language.value, translatedText, copy, speakTranslation, originalText);
    });

    translateSelectionText(text, language.value, translatedText, copy, speakTranslation, originalText);
  }

  function getStructuredSelectionText(selection) {
    const fallback = selection?.toString() || '';
    if (!selection?.rangeCount) return fallback;

    let container = null;
    try {
      const range = selection.getRangeAt(0);
      container = document.createElement('div');
      container.dataset.dthPageUi = 'true';
      Object.assign(container.style, {
        position: 'fixed',
        left: '-100000px',
        top: '0',
        width: `${Math.max(320, Math.ceil(range.getBoundingClientRect().width || 0))}px`,
        opacity: '0',
        pointerEvents: 'none',
        zIndex: '-1'
      });
      container.append(range.cloneContents());

      container.querySelectorAll('img').forEach(image => {
        const label = image.getAttribute('alt') || image.getAttribute('aria-label') || '';
        image.replaceWith(document.createTextNode(label));
      });
      container.querySelectorAll('[role="img"][aria-label]').forEach(element => {
        if (element.textContent?.trim()) return;
        element.replaceWith(document.createTextNode(element.getAttribute('aria-label') || ''));
      });

      document.documentElement.append(container);
      const structured = container.innerText;
      if (!structured?.trim()) return fallback;

      const structureScore = value => {
        const text = String(value || '');
        const lineBreaks = (text.match(/\r\n|\n|\r/g) || []).length;
        const blankLines = (text.match(/(?:\r\n|\n|\r)[\t ]*(?:\r\n|\n|\r)/g) || []).length;
        const tabs = (text.match(/\t/g) || []).length;
        const repeatedSpaces = (text.match(/ {2,}/g) || []).length;
        return blankLines * 1000 + lineBreaks * 100 + tabs * 10 + repeatedSpaces;
      };
      return structureScore(fallback) > structureScore(structured) ? fallback : structured;
    } catch {
      return fallback;
    } finally {
      container?.remove();
    }
  }

  document.addEventListener('contextmenu', event => {
    const selection = window.getSelection();
    if (!selection || !selection.toString().trim()) return;
    state.selectionText = getStructuredSelectionText(selection);
    state.selectionCapturedAt = Date.now();
    let rect = null;
    try {
      if (selection.rangeCount) rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch { }
    state.selectionAnchor = rect && (rect.width || rect.height)
      ? { x: rect.left, y: rect.bottom }
      : { x: event.clientX, y: event.clientY };
  }, true);

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'dth-translate-selection') {
      const incoming = String(message.text || '');
      const captured = Date.now() - state.selectionCapturedAt < 10000 ? state.selectionText : '';
      const text = captured?.trim() ? captured : incoming;
      showSelectionTranslation(text);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) {
      state.settings[key] = change.newValue;
    }
    if (!FULL_PAGE_ALLOWED) return;

    const enabled = state.settings.translationEnabled !== false
      && state.settings.pageTranslationEnabled === true;
    if (!enabled) {
      state.autoPending = false;
      if (state.translated || state.translating) restorePage({ hideBar: true });
      return;
    }

    if (changes.pageTranslationEnabled || changes.pageTranslationTargetLang || changes.translationEnabled) {
      const target = state.settings.pageTranslationTargetLang || state.settings.targetLang || 'ru';
      state.autoPending = true;
      translateWholePage(target);
    }
  });

  const pageObserver = new MutationObserver(mutations => {
    let pageChanged = false;
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const node = mutation.target;
        if (state.mutedNodes.has(node)) {
          state.mutedNodes.delete(node);
          continue;
        }
        const record = state.originals.get(node);
        if (record && node.data === record.translated) continue;
        state.processedNodes.delete(node);
        if (record) state.originals.delete(node);
        pageChanged = true;
      } else if (mutation.addedNodes.length) {
        pageChanged = true;
      }
    }
    if (pageChanged) {
      if (state.translated) scheduleDynamicTranslation();
      else scheduleInitialTranslationRetry();
    }
  });
  pageObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.addEventListener('resize', applyPageControlPosition);

  Promise.all([loadSettings(), loadPageControlPosition()]).then(([settings, savedPosition]) => {
    state.settings = settings || {};
    state.pageControlPosition = savedPosition;
    state.targetLang = settings.pageTranslationTargetLang || settings.targetLang || 'ru';
    if (!FULL_PAGE_ALLOWED) {
      if (IS_TOP_FRAME) updateBadge(false);
      return;
    }
    if (settings.translationEnabled !== false && settings.pageTranslationEnabled === true) {
      state.autoPending = true;
      setTimeout(() => translateWholePage(state.targetLang), 500);
    } else {
      updateBadge(false);
    }
  }).catch(error => {
    console.warn('[AI Helper] Could not load page translation settings:', error);
  });
})();
