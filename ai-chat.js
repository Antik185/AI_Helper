// AI Chat panel — floating chat with an LLM that "sees" the current page.
// Injected on all sites except Discord/X/chatgpt.com (same matches as universal-content.js).

(() => {
  if (window.__dthAiChatLoaded) return;
  window.__dthAiChatLoaded = true;

  const HISTORY_KEY = 'dthAiChatHistory';
  // OpenRouter (Gemini Flash) спокойно ест большой контекст; ChatGPT скромнее —
  // промпт печатается в composer на вкладке, гигантский вставлять рискованно.
  const MAX_PAGE_TEXT_API = 60000;
  const MAX_PAGE_TEXT_CHATGPT = 24000;

  let overrideMessages = null;
  let history = loadHistory();
  let busy = false;
  let aiSettings = {};

  // --- i18n ---

  async function ensureOverrideLocale(uiLang) {
    if (!uiLang || uiLang === 'auto') { overrideMessages = null; return; }
    try {
      const url = chrome.runtime.getURL(`_locales/${uiLang}/messages.json`);
      const res = await fetch(url);
      overrideMessages = await res.json();
    } catch { overrideMessages = null; }
  }

  function t(key) {
    if (overrideMessages && overrideMessages[key] && overrideMessages[key].message) {
      return overrideMessages[key].message;
    }
    try { return chrome.i18n.getMessage(key) || key; }
    catch { return key; }
  }

  // --- History (per-tab, survives reloads within the tab) ---

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function saveHistory() {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-40))); } catch { }
  }

  // --- Page context ---

  // Кусочек текста из центра видимой области — якорь, чтобы при обрезке
  // длинной страницы сохранить именно то место, которое пользователь смотрит.
  function viewportAnchorSnippet() {
    try {
      let elAt = document.elementFromPoint(
        Math.floor(window.innerWidth / 2),
        Math.floor(window.innerHeight / 2)
      );
      while (elAt && elAt !== document.body) {
        const txt = (elAt.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (txt.length >= 40) return txt.slice(0, 80);
        elAt = elAt.parentElement;
      }
    } catch { }
    return '';
  }

  function extractPageText(maxLen) {
    const root = document.querySelector('article')
      || document.querySelector('main')
      || document.querySelector('[role="main"]')
      || document.body;
    if (!root) return '';
    let text = '';
    try { text = root.innerText || ''; } catch { }
    // Если контент берём из всего body — вычитаем «обвязку»:
    // меню, шапки, подвалы, сайдбары, куки-баннеры.
    if (root === document.body) {
      const junk = document.body.querySelectorAll(
        'nav, footer, aside, header, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-modal="true"], [id*="cookie" i], [class*="cookie-banner" i], [class*="cookie-consent" i]'
      );
      for (const elJunk of junk) {
        let jt = '';
        try { jt = elJunk.innerText || ''; } catch { }
        if (jt && jt.length > 10) text = text.replace(jt, '');
      }
    }
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    if (text.length <= maxLen) return text;

    // Страница не влезает: берём начало + окно вокруг видимой области экрана.
    const headLen = Math.floor(maxLen * 0.5);
    const snippet = viewportAnchorSnippet();
    const anchorPos = snippet ? text.indexOf(snippet) : -1;
    if (anchorPos > headLen) {
      const winLen = maxLen - headLen;
      const start = Math.max(headLen, Math.min(anchorPos - Math.floor(winLen / 3), text.length - winLen));
      return text.slice(0, headLen)
        + '\n\n[... part of the page skipped ...]\n\n'
        + text.slice(start, start + winLen);
    }
    return text.slice(0, maxLen);
  }

  // Инлайновые <svg> живут только в DOM — храним ссылки на элементы,
  // чтобы по референсу svg-N сериализовать их в файл при скачивании.
  let lastSvgEls = [];

  function collectMedia() {
    const items = [];
    const seen = new Set();
    lastSvgEls = [];
    for (const img of document.querySelectorAll('img')) {
      if (items.length >= 25) break;
      const src = img.currentSrc || img.src || '';
      if (!/^https?:/.test(src) || seen.has(src)) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if ((w && w < 64) || (h && h < 64)) continue; // иконки пропускаем
      seen.add(src);
      items.push({ kind: 'image', src, alt: (img.alt || '').slice(0, 120), w, h });
    }
    for (const svg of document.querySelectorAll('svg')) {
      if (lastSvgEls.length >= 10 || items.length >= 35) break;
      if (panel && panel.contains(svg)) continue;
      const r = svg.getBoundingClientRect();
      if (r.width < 64 || r.height < 64) continue;
      const titleEl = svg.querySelector('title');
      lastSvgEls.push(svg);
      items.push({
        kind: 'svg',
        ref: 'svg-' + (lastSvgEls.length - 1),
        w: Math.round(r.width),
        h: Math.round(r.height),
        alt: (svg.getAttribute('aria-label') || (titleEl && titleEl.textContent) || '').slice(0, 120)
      });
    }
    for (const v of document.querySelectorAll('video')) {
      if (items.length >= 40) break;
      const srcEl = v.querySelector('source');
      const src = v.currentSrc || v.src || (srcEl && srcEl.src) || '';
      if (!src || seen.has(src)) continue;
      seen.add(src);
      items.push({
        kind: 'video',
        src: /^https?:/.test(src) ? src : '',
        streaming: src.startsWith('blob:')
      });
    }
    return items;
  }

  // Интерактивные элементы страницы для директив-действий ([[click:el-N]] и т.п.).
  // Ссылки на DOM-узлы храним отдельно — модель оперирует только номерами.
  let lastActEls = [];

  function collectActions() {
    lastActEls = [];
    const seen = new Set();
    const cand = [];
    // Помимо обычных кнопок/ссылок — ARIA-роли и ячейки календарей
    // (дни в датапикерах часто <td>/<div> с role или классом *day*).
    const sel = 'a[href], button, [role="button"], [role="link"], [role="menuitem"],'
      + ' [role="menuitemradio"], [role="option"], [role="tab"], [role="gridcell"],'
      + ' [role="radio"], [role="checkbox"], [class*="day" i][aria-label],'
      + ' input, textarea, select';
    for (const e of document.querySelectorAll(sel)) {
      if (cand.length >= 300) break;
      if (panel && panel.contains(e)) continue;
      if (e.disabled || e.getAttribute('aria-disabled') === 'true') continue;
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue; // скрытые/схлопнутые
      const tag = e.tagName;
      if (tag === 'INPUT' && /^(hidden|checkbox|radio|file|range|color)$/i.test(e.type || '')) continue;
      let kind, label;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (/^(submit|button|image)$/i.test(e.type || '')) {
          kind = 'button';
          label = e.value || e.getAttribute('aria-label') || '';
        } else {
          kind = 'input';
          label = e.placeholder || e.getAttribute('aria-label') || e.name || '';
        }
      } else if (tag === 'SELECT') {
        kind = 'select';
        label = e.getAttribute('aria-label') || e.name || '';
      } else if (tag === 'A') {
        kind = 'link';
        label = (e.innerText || e.getAttribute('aria-label') || e.title || '').trim();
      } else {
        kind = 'button';
        // У ячеек дат текст «15» ни о чём — aria-label («15 июня 2026») полезнее.
        const txt = (e.innerText || '').replace(/\s+/g, ' ').trim();
        const aria = (e.getAttribute('aria-label') || '').trim();
        label = (txt.length <= 2 && aria) ? aria : (txt || aria || e.title || '');
      }
      label = (label || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!label) continue;
      const key = kind + '|' + label;
      if (seen.has(key)) continue; // дубли (повторяющиеся кнопки в списках) не плодим
      seen.add(key);
      const inVp = r.bottom > 0 && r.top < window.innerHeight
        && r.right > 0 && r.left < window.innerWidth;
      let href = '';
      if (kind === 'link' && e.href && !e.href.startsWith('javascript:')) {
        href = e.href.slice(0, 200);
      }
      cand.push({ e, kind, label, href, inVp });
    }
    // Видимые на экране — в приоритете: открывшийся диалог/календарь всегда
    // во вьюпорте и не должен вытесняться кнопками из подвала страницы.
    const pick = cand.filter(c => c.inVp).concat(cand.filter(c => !c.inVp)).slice(0, 80);
    return pick.map((c) => {
      const ref = 'el-' + lastActEls.length;
      lastActEls.push(c.e);
      const item = { ref, kind: c.kind, label: c.label };
      if (c.href) item.href = c.href;
      return item;
    });
  }

  function collectContext(includePage) {
    // Галочка «видеть страницу» выключена — не передаём ничего о странице,
    // даже URL/заголовок: только сам диалог (цитата уже вшита в сообщение).
    if (!includePage) return null;
    const ctx = {
      url: location.href,
      title: document.title || ''
    };
    const sel = (window.getSelection && String(window.getSelection())) || '';
    if (sel.trim()) ctx.selection = sel.trim();
    const maxLen = aiSettings.aiChatProvider === 'chatgpt'
      ? MAX_PAGE_TEXT_CHATGPT
      : MAX_PAGE_TEXT_API;
    ctx.pageText = extractPageText(maxLen);
    ctx.media = collectMedia();
    ctx.actions = collectActions();
    return ctx;
  }

  // --- Download directives ([[download:URL]] в ответе модели) ---

  // Терпимо к причудам модели: пробелы/переносы вокруг URL, регистр, "download :".
  const DL_RE = /\[\[\s*download\s*:\s*([^\]\s]+)\s*\]\]/gi;
  // Действия на странице: [[scroll:el-3]], [[click:el-7]], [[type:el-5:текст]]
  const ACT_RE = /\[\[\s*(scroll|click|type)\s*:\s*(el-\d+)\s*(?::([^\]]*))?\]\]/gi;
  // [[end]] — модель помечает действие финальным: обновление страницы не нужно.
  const END_RE = /\[\[\s*end\s*\]\]/i;

  function visibleText(s) {
    // Прячем готовые директивы и недопечатанный «хвост» во время стриминга.
    return s
      .replace(DL_RE, '')
      .replace(ACT_RE, '')
      .replace(new RegExp(END_RE.source, 'gi'), '')
      .replace(/\[\[[^\]]*$/, '')
      .trim();
  }

  function extractDownloads(s) {
    const urls = [];
    const re = new RegExp(DL_RE.source, 'gi');
    let m;
    while ((m = re.exec(s)) && urls.length < 5) urls.push(m[1]);
    return urls;
  }

  function extractActions(s) {
    const acts = [];
    const re = new RegExp(ACT_RE.source, 'gi');
    let m;
    while ((m = re.exec(s)) && acts.length < 5) {
      acts.push({ op: m[1].toLowerCase(), ref: m[2], text: (m[3] || '').trim() });
    }
    return acts;
  }

  function actTarget(ref) {
    const e = lastActEls[parseInt(ref.slice(3), 10)];
    return e && e.isConnected ? e : null;
  }

  function highlightEl(e) {
    e.classList.add('dth-ai-highlight');
    setTimeout(() => e.classList.remove('dth-ai-highlight'), 2500);
  }

  // Ждём, пока DOM «устаканится»: минимум minMs, дальше — пока не будет
  // quietMs без мутаций (мутации внутри нашей панели не считаются),
  // но не дольше maxMs. Так диалоги и аякс-подгрузки успевают дорисоваться.
  function waitForDomSettle(minMs, quietMs, maxMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      let last = Date.now();
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (panel && panel.contains(m.target)) continue;
          last = Date.now();
          return;
        }
      });
      try {
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      } catch { }
      const timer = setInterval(() => {
        const now = Date.now();
        if ((now - start >= minMs && now - last >= quietMs) || now - start >= maxMs) {
          clearInterval(timer);
          obs.disconnect();
          resolve();
        }
      }, 150);
    });
  }

  // После подтверждённого действия даём странице время отработать
  // (открыть диалог, подгрузить результаты) и автоматически отправляем
  // модели обновлённый контекст, чтобы она продолжила цепочку шагов.
  async function scheduleFollowup(label) {
    await waitForDomSettle(600, 500, 5000);
    if (busy) return;
    let msg = t('aiChatActFollowup');
    msg = msg !== 'aiChatActFollowup'
      ? msg.replace('{0}', label || '?')
      : `Done: "${label}". Continue with the updated page state.`;
    dispatch(msg, '', true);
  }

  function bgMsg(m) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage(m, (r) => {
          void chrome.runtime.lastError;
          res(r || null);
        });
      } catch { res(null); }
    });
  }

  // Точка клика: центр может быть накрыт чем-то чужим (в т.ч. нашей кнопкой
  // перевода внутри поля) — пробуем несколько точек и берём ту, где
  // elementFromPoint попадает в сам элемент или его потомка.
  function pickPoint(e2) {
    const r = e2.getBoundingClientRect();
    const pts = [[0.5, 0.5], [0.3, 0.5], [0.5, 0.3], [0.15, 0.5], [0.7, 0.5], [0.5, 0.7]];
    for (const [fx, fy] of pts) {
      const x = Math.round(r.left + r.width * fx);
      const y = Math.round(r.top + r.height * fy);
      const top = document.elementFromPoint(x, y);
      if (top && (top === e2 || e2.contains(top))) return { x, y };
    }
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2)
    };
  }

  // «Доверенный» клик через chrome.debugger в background: события уровня
  // браузера с isTrusted=true — сайты, игнорирующие синтетику, их принимают.
  let debugUsed = false;

  async function trustedClick(e2) {
    const at = await bgMsg({ type: 'aiDebugAttach' });
    if (!at || !at.ok) return false;
    debugUsed = true;
    // attach мог показать инфобар и сдвинуть страницу — координаты меряем после
    await new Promise(r => setTimeout(r, 250));
    // resize от инфобара мог закрыть открытый дропдаун вместе с элементом —
    // лучше честная ошибка, чем клик по пустому месту.
    if (!e2.isConnected) throw new Error(t('aiChatActGone'));
    let r = e2.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      e2.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
    const { x, y } = pickPoint(e2);
    const resp = await bgMsg({ type: 'aiDebugClick', x, y });
    return !!(resp && resp.ok);
  }

  // Цепочка действий закончена — отцепляем debugger (инфобар исчезнет).
  function endDebugSession() {
    if (!debugUsed) return;
    debugUsed = false;
    bgMsg({ type: 'aiDebugDetach' });
  }

  // Поиск элемента в точке с проникновением в Shadow DOM: elementFromPoint
  // возвращает хост веб-компонента, а реальный клик уходит вглубь теневого дерева.
  function deepElementFromPoint(x, y) {
    let e = document.elementFromPoint(x, y);
    let guard = 0;
    while (e && e.shadowRoot && guard++ < 5) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  }

  function isOwnUi(e) {
    return !!(e && ((panel && panel.contains(e)) || (fab && fab.contains(e))
      || (e.closest && e.closest('.dth-input-wrap'))));
  }

  // Полная имитация клика: многие виджеты (календари, кастомные дропдауны)
  // реагируют на mousedown/pointerdown или focus, а не на голый click().
  function simulateClick(e2) {
    const { x, y } = pickPoint(e2);
    // Реальная мышь бьёт в самый верхний элемент в точке (включая глубину
    // Shadow DOM) — обработчики часто висят не на элементе из списка.
    let target = deepElementFromPoint(x, y);
    if (!target || isOwnUi(target)) target = e2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true, // пересекать границы Shadow DOM, как настоящие события
      view: window,
      button: 0,
      detail: 1,      // у реального клика detail=1; синтетический 0 часто фильтруют
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y
    };
    const pDown = { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5, width: 1, height: 1 };
    const pUp = { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0, width: 1, height: 1 };
    // Hover-цепочка: часть виджетов не реагирует на down без неё.
    try { target.dispatchEvent(new PointerEvent('pointerover', pUp)); } catch { }
    target.dispatchEvent(new MouseEvent('mouseover', base));
    try { target.dispatchEvent(new PointerEvent('pointermove', pUp)); } catch { }
    target.dispatchEvent(new MouseEvent('mousemove', base));
    try { target.dispatchEvent(new PointerEvent('pointerdown', pDown)); } catch { }
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    try {
      const f = target.closest ? (target.closest('button, a, input, textarea, select, [tabindex]') || e2) : e2;
      f.focus({ preventScroll: true });
    } catch { }
    try { target.dispatchEvent(new PointerEvent('pointerup', pUp)); } catch { }
    target.dispatchEvent(new MouseEvent('mouseup', base));
    target.dispatchEvent(new MouseEvent('click', base));
  }

  // Само исполнение действия (клик или ввод в поле). Бросает при ошибке.
  async function execAction(act) {
    const e2 = actTarget(act.ref);
    if (!e2) throw new Error(t('aiChatActGone'));
    // Скроллим только если элемент вне экрана: лишний скролл закрывает
    // некоторые выпадающие меню/календари. Скролл мгновенный — smooth не
    // успевал завершиться к моменту клика, и координаты уезжали.
    const r = e2.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      e2.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
    highlightEl(e2);
    if (act.op === 'click') {
      simulateClick(e2);
    } else {
      e2.focus();
      const proto = e2.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(e2, act.text);
      else e2.value = act.text;
      e2.dispatchEvent(new Event('input', { bubbles: true }));
      e2.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function runAction(act, chainEnd) {
    const target = actTarget(act.ref);
    if (!target) {
      const card = el('div', 'dth-ai-msg dth-ai-assistant dth-ai-error', t('aiChatActGone'));
      msgsEl.appendChild(card);
      scrollToBottom();
      return;
    }

    if (act.op === 'scroll') {
      // Безопасно — выполняем сразу, без подтверждения.
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightEl(target);
      return;
    }

    const label = (target.innerText || target.value || target.placeholder
      || target.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);

    // ⚡ Авто-режим: выполняем сразу. Важно для выпадающих меню —
    // клик по кнопке подтверждения уводил бы фокус и закрывал их.
    if (actAutoToggle && actAutoToggle.checked) {
      const card = el('div', 'dth-ai-msg dth-ai-assistant dth-ai-act');
      (async () => {
        try {
          await execAction(act);
          const what = act.op === 'click'
            ? `${t('aiChatActClicked')} «${label || '?'}»`
            : `${t('aiChatActTyped')} «${label || '?'}»: “${act.text.slice(0, 80)}”`;
          card.textContent = '⚡ ' + what;
          msgsEl.appendChild(card);
          scrollToBottom();
          if (!chainEnd) scheduleFollowup(label);
          else endDebugSession();
        } catch (err) {
          card.classList.add('dth-ai-error');
          card.textContent = t('errorPrefix') + (err.message || err);
          msgsEl.appendChild(card);
          scrollToBottom();
        }
      })();
      return;
    }

    // Обычный режим: click / type — только с подтверждения пользователя.
    const card = el('div', 'dth-ai-msg dth-ai-assistant dth-ai-act');
    const desc = act.op === 'click'
      ? `${t('aiChatActClick')} «${label || '?'}»`
      : `${t('aiChatActType')} «${label || '?'}»: “${act.text.slice(0, 80)}”`;
    card.appendChild(el('div', 'dth-ai-act-desc', desc));
    const btns = el('div', 'dth-ai-act-btns');
    const okBtn = el('button', 'dth-ai-act-btn dth-ai-act-ok', t('aiChatActRun'));
    okBtn.type = 'button';
    const noBtn = el('button', 'dth-ai-act-btn', t('aiChatActCancel'));
    noBtn.type = 'button';
    const done = (text, isErr) => {
      btns.remove();
      const st = el('div', 'dth-ai-act-status', text);
      if (isErr) card.classList.add('dth-ai-error');
      card.appendChild(st);
      scrollToBottom();
    };
    okBtn.addEventListener('click', async () => {
      try {
        await execAction(act);
        done('✓ ' + t('aiChatActDone'));
        if (!chainEnd) scheduleFollowup(label);
        else endDebugSession();
      } catch (err) {
        done(t('errorPrefix') + (err.message || err), true);
      }
    });
    noBtn.addEventListener('click', () => done(t('aiChatActCanceled')));
    btns.appendChild(okBtn);
    btns.appendChild(noBtn);
    card.appendChild(btns);
    msgsEl.appendChild(card);
    scrollToBottom();
  }

  function startDownload(token, media) {
    const card = el('div', 'dth-ai-msg dth-ai-assistant dth-ai-dl');
    let url = token;
    let filename = '';
    let name;
    let isImage;

    if (/^svg-\d+$/i.test(token)) {
      // Инлайновый <svg>: сериализуем в data-URL
      const svgEl = lastSvgEls[parseInt(token.slice(4), 10)];
      if (!svgEl || !svgEl.isConnected) {
        card.classList.add('dth-ai-error');
        card.textContent = t('errorPrefix') + 'SVG не найден на странице (она изменилась).';
        msgsEl.appendChild(card);
        scrollToBottom();
        return;
      }
      let xml = new XMLSerializer().serializeToString(svgEl);
      if (!xml.includes('xmlns=')) xml = xml.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
      const item = (media || []).find(x => x.ref === token.toLowerCase());
      const base = (item && item.alt ? item.alt.replace(/[^\wЀ-ӿ-]+/g, '_').slice(0, 40) : '') || 'image';
      filename = base + '.svg';
      name = filename;
      isImage = true;
    } else {
      isImage = (media || []).some(m => m.kind === 'image' && m.src === token)
        || /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(token);
      name = decodeURIComponent((token.split(/[?#]/)[0].split('/').pop() || 'file')).slice(0, 60) || 'file';
    }

    if (isImage) {
      const im = document.createElement('img');
      im.className = 'dth-ai-thumb';
      im.src = url;
      im.addEventListener('error', () => im.remove());
      card.appendChild(im);
    }
    const caption = el('div', 'dth-ai-dl-caption', '⬇ ' + name + ' — ' + t('aiChatDownloading'));
    card.appendChild(caption);
    msgsEl.appendChild(card);
    scrollToBottom();
    chrome.runtime.sendMessage({ type: 'downloadFile', url, filename }, (resp) => {
      if (resp && resp.ok) {
        caption.textContent = '✓ ' + name + ' — ' + t('aiChatDownloaded');
      } else {
        card.classList.add('dth-ai-error');
        caption.textContent = '⬇ ' + name + ' — ' + t('errorPrefix') + ((resp && resp.error) || '…');
      }
      scrollToBottom();
    });
  }

  // --- UI ---

  let fab = null, panel = null, msgsEl = null, inputEl = null, sendBtn = null, ctxToggle = null;
  let shotToggle = null, shotLabel = null, shotFullToggle = null, actAutoToggle = null;
  let quoteBar = null, quoteTextEl = null;
  let pendingQuote = '';

  function setQuote(text) {
    pendingQuote = (text || '').trim().slice(0, 8000);
    if (!quoteBar) return;
    quoteTextEl.textContent = pendingQuote;
    quoteBar.classList.remove('dth-ai-quote-expanded');
    quoteBar.classList.toggle('dth-ai-quote-visible', !!pendingQuote);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function buildUI() {
    fab = el('button', 'dth-ai-fab', '✦');
    fab.type = 'button';
    fab.title = t('aiChatFabTitle');
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);

    panel = el('div', 'dth-ai-panel');

    const head = el('div', 'dth-ai-head');
    const title = el('div', 'dth-ai-title', t('aiChatTitle'));
    const headBtns = el('div', 'dth-ai-head-btns');
    const clearBtn = el('button', 'dth-ai-iconbtn', '🗑');
    clearBtn.type = 'button';
    clearBtn.title = t('aiChatClear');
    clearBtn.addEventListener('click', () => {
      history = [];
      saveHistory();
      renderAll();
    });
    const closeBtn = el('button', 'dth-ai-iconbtn', '✕');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', togglePanel);
    headBtns.appendChild(clearBtn);
    headBtns.appendChild(closeBtn);
    head.appendChild(title);
    head.appendChild(headBtns);

    msgsEl = el('div', 'dth-ai-msgs');

    const ctxRow = el('div', 'dth-ai-ctx');
    const ctxLabel = el('label', 'dth-ai-ctx-item');
    ctxToggle = document.createElement('input');
    ctxToggle.type = 'checkbox';
    ctxToggle.checked = true;
    const ctxText = el('span', null, t('aiChatContext'));
    ctxLabel.appendChild(ctxToggle);
    ctxLabel.appendChild(ctxText);
    const ctxPage = el('span', 'dth-ai-ctx-page', '— ' + (document.title || location.hostname));
    ctxRow.appendChild(ctxLabel);
    ctxRow.appendChild(ctxPage);

    const shotRow = el('div', 'dth-ai-ctx dth-ai-shotrow');
    shotLabel = el('label', 'dth-ai-ctx-item');
    shotLabel.title = t('aiChatShotTitle');
    shotToggle = document.createElement('input');
    shotToggle.type = 'checkbox';
    shotLabel.appendChild(shotToggle);
    shotLabel.appendChild(el('span', null, '📷 ' + t('aiChatShot')));
    shotRow.appendChild(shotLabel);
    const shotFullLabel = el('label', 'dth-ai-ctx-item');
    shotFullLabel.title = t('aiChatShotFullTitle');
    shotFullToggle = document.createElement('input');
    shotFullToggle.type = 'checkbox';
    shotFullLabel.appendChild(shotFullToggle);
    shotFullLabel.appendChild(el('span', null, '↕ ' + t('aiChatShotFull')));
    shotRow.appendChild(shotFullLabel);
    const actAutoLabel = el('label', 'dth-ai-ctx-item');
    actAutoLabel.title = t('aiChatActAutoTitle');
    actAutoToggle = document.createElement('input');
    actAutoToggle.type = 'checkbox';
    try { actAutoToggle.checked = sessionStorage.getItem('dthAiActAuto') === '1'; } catch { }
    actAutoToggle.addEventListener('change', () => {
      try { sessionStorage.setItem('dthAiActAuto', actAutoToggle.checked ? '1' : ''); } catch { }
    });
    actAutoLabel.appendChild(actAutoToggle);
    actAutoLabel.appendChild(el('span', null, '⚡ ' + t('aiChatActAuto')));
    shotRow.appendChild(actAutoLabel);

    const inputRow = el('div', 'dth-ai-inputrow');
    inputEl = document.createElement('textarea');
    inputEl.className = 'dth-ai-input';
    inputEl.rows = 1;
    inputEl.placeholder = t('aiChatPlaceholder');
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
      e.stopPropagation();
    });
    inputEl.addEventListener('keyup', e => e.stopPropagation());
    inputEl.addEventListener('input', autosize);
    sendBtn = el('button', 'dth-ai-send', '➤');
    sendBtn.type = 'button';
    sendBtn.addEventListener('click', send);
    inputRow.appendChild(inputEl);
    inputRow.appendChild(sendBtn);

    quoteBar = el('div', 'dth-ai-quotebar');
    quoteTextEl = el('div', 'dth-ai-quote-text');
    quoteTextEl.title = t('aiChatQuoteMore');
    quoteTextEl.addEventListener('click', () =>
      quoteBar.classList.toggle('dth-ai-quote-expanded'));
    const quoteX = el('button', 'dth-ai-iconbtn', '✕');
    quoteX.type = 'button';
    quoteX.addEventListener('click', () => setQuote(''));
    quoteBar.appendChild(quoteTextEl);
    quoteBar.appendChild(quoteX);

    panel.appendChild(head);
    panel.appendChild(msgsEl);
    panel.appendChild(ctxRow);
    panel.appendChild(shotRow);
    panel.appendChild(quoteBar);
    panel.appendChild(inputRow);
    document.body.appendChild(panel);

    // Изоляция панели: клики/фокус внутри чата не должны «протекать» на
    // страницу — сайты закрывают дропдауны и календари по событию снаружи
    // (document-слушатели). Наши обработчики на кнопках срабатывают раньше,
    // чем событие доплывёт до границы панели, так что внутри ничего не ломается.
    const isolate = (e) => e.stopPropagation();
    for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click',
      'dblclick', 'touchstart', 'touchend', 'focusin', 'keydown', 'keyup', 'keypress']) {
      panel.addEventListener(ev, isolate);
      fab.addEventListener(ev, isolate);
    }

    renderAll();
  }

  async function captureScreenshot() {
    panel.style.visibility = 'hidden';
    try {
      await new Promise(r => setTimeout(r, 80)); // дать странице перерисоваться без панели
      const resp = await new Promise((res) => {
        try {
          chrome.runtime.sendMessage({ type: 'captureTab' }, (r) => {
            void chrome.runtime.lastError;
            res(r || null);
          });
        } catch { res(null); }
      });
      if (!resp || !resp.ok) return null;
      return await downscaleImage(resp.dataUrl);
    } finally {
      panel.style.visibility = '';
    }
  }

  function downscaleImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxW = 1920;
        if (img.width <= maxW) return resolve(dataUrl);
        const c = document.createElement('canvas');
        c.width = maxW;
        c.height = Math.round(img.height * maxW / img.width);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/jpeg', 0.85)); } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function loadImg(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // На многих SPA скроллится не окно, а внутренний контейнер — ищем его
  // от центра экрана вверх по дереву. Иначе — обычный scrollingElement.
  function findScrollRoot() {
    const de = document.scrollingElement || document.documentElement;
    if (de.scrollHeight > de.clientHeight + 50) return de;
    let e = document.elementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2)
    );
    while (e && e !== document.body && e !== document.documentElement) {
      if (!(panel && panel.contains(e))) {
        const cs = getComputedStyle(e);
        if (e.scrollHeight > e.clientHeight + 50 && /(auto|scroll|overlay)/.test(cs.overflowY)) {
          return e;
        }
      }
      e = e.parentElement;
    }
    return de;
  }

  // Полный скриншот: прокручиваем страницу экранами, снимаем каждый кадр
  // и склеиваем на canvas. Кадров максимум 8 (лимит размера и токенов),
  // пауза 600мс — Chrome ограничивает captureVisibleTab ~2 вызовами в секунду.
  async function captureFullPage() {
    panel.style.visibility = 'hidden';
    let root, vh, total, startY;
    const shots = [];
    try {
      root = findScrollRoot();
      vh = root.clientHeight || window.innerHeight;
      total = Math.min(root.scrollHeight, vh * 8);
      if (total <= vh + 50) {
        panel.style.visibility = '';
        return captureScreenshot(); // скроллить некуда
      }
      startY = root.scrollTop;
      for (let y = 0; y < total; y += vh) {
        const top = Math.min(y, total - vh);
        root.scrollTop = top;
        await new Promise(r => setTimeout(r, 600));
        const resp = await new Promise((res) => {
          try {
            chrome.runtime.sendMessage({ type: 'captureTab' }, (r) => {
              void chrome.runtime.lastError;
              res(r || null);
            });
          } catch { res(null); }
        });
        if (!resp || !resp.ok) break;
        // фиксируем фактическую позицию: scrollTop мог упереться в границу
        shots.push({ top: root.scrollTop, dataUrl: resp.dataUrl });
        if (top >= total - vh) break;
      }
    } finally {
      try { if (root) root.scrollTop = startY || 0; } catch { }
      panel.style.visibility = '';
    }
    if (!shots.length) return null;
    if (shots.length === 1) return downscaleImage(shots[0].dataUrl);

    try {
      const imgs = await Promise.all(shots.map(s => loadImg(s.dataUrl)));
      const px = imgs[0].width / window.innerWidth; // физические пиксели на CSS-пиксель
      const outW = Math.min(imgs[0].width, 1280);
      const k = outW / imgs[0].width;
      const c = document.createElement('canvas');
      c.width = outW;
      c.height = Math.round(total * px * k);
      const g = c.getContext('2d');
      shots.forEach((s, idx) => {
        const im = imgs[idx];
        g.drawImage(im, 0, Math.round(s.top * px * k), outW, Math.round(im.height * k));
      });
      return c.toDataURL('image/jpeg', 0.8);
    } catch {
      return downscaleImage(shots[0].dataUrl);
    }
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  function togglePanel() {
    const open = panel.classList.toggle('dth-ai-open');
    fab.classList.toggle('dth-ai-hidden', open);
    if (open) {
      const ctxPage = panel.querySelector('.dth-ai-ctx-page');
      if (ctxPage) ctxPage.textContent = '— ' + (document.title || location.hostname);
      scrollToBottom();
      inputEl.focus();
    }
  }

  // --- Markdown (упрощённый, безопасный: только DOM-узлы, без innerHTML) ---

  function mdInline(s) {
    const frag = document.createDocumentFragment();
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      if (m[1]) {
        const c = document.createElement('code');
        c.textContent = m[1].slice(1, -1);
        frag.appendChild(c);
      } else if (m[2]) {
        const b = document.createElement('strong');
        b.appendChild(mdInline(m[2].slice(2, -2)));
        frag.appendChild(b);
      } else if (m[3]) {
        const i = document.createElement('em');
        i.appendChild(mdInline(m[3].slice(1, -1)));
        frag.appendChild(i);
      } else if (m[4]) {
        const a = document.createElement('a');
        a.textContent = m[4];
        a.href = m[5];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        frag.appendChild(a);
      }
      last = re.lastIndex;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  }

  const MD_LIST_RE = /^\s*([-*•]|\d+[.)])\s+/;

  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // закрывающий ```
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        const e = document.createElement('div');
        e.className = 'dth-ai-mdh dth-ai-mdh' + h[1].length;
        e.appendChild(mdInline(h[2]));
        frag.appendChild(e);
        i++;
        continue;
      }
      if (MD_LIST_RE.test(line)) {
        const ordered = /^\s*\d/.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && MD_LIST_RE.test(lines[i])) {
          const li = document.createElement('li');
          li.appendChild(mdInline(lines[i].replace(MD_LIST_RE, '')));
          list.appendChild(li);
          i++;
        }
        frag.appendChild(list);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim()
        && !/^```|^#{1,4}\s/.test(lines[i]) && !MD_LIST_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const p = document.createElement('p');
      buf.forEach((l, idx) => {
        if (idx) p.appendChild(document.createElement('br'));
        p.appendChild(mdInline(l));
      });
      frag.appendChild(p);
    }
    return frag;
  }

  function setMd(target, text) {
    target.classList.add('dth-ai-md');
    target.textContent = '';
    target.appendChild(renderMarkdown(text));
  }

  const QUOTE_PREVIEW = 220;

  function addBubble(role, text, quote) {
    const b = el('div', 'dth-ai-msg dth-ai-' + role);
    if (quote) {
      const q = el('div', 'dth-ai-msg-quote');
      if (quote.length > QUOTE_PREVIEW) {
        const qt = el('span', null, quote.slice(0, QUOTE_PREVIEW) + '…');
        const more = el('button', 'dth-ai-quote-more', t('aiChatQuoteMore'));
        more.type = 'button';
        let expanded = false;
        more.addEventListener('click', () => {
          expanded = !expanded;
          qt.textContent = expanded ? quote : quote.slice(0, QUOTE_PREVIEW) + '…';
          more.textContent = expanded ? t('aiChatQuoteLess') : t('aiChatQuoteMore');
          if (!expanded) scrollToBottom();
        });
        q.appendChild(qt);
        q.appendChild(more);
      } else {
        q.textContent = quote;
      }
      b.appendChild(q);
      b.appendChild(el('div', null, text));
    } else if (role === 'assistant' && text) {
      setMd(b, text);
    } else {
      b.textContent = text;
    }
    msgsEl.appendChild(b);
    scrollToBottom();
    return b;
  }

  function renderAll() {
    msgsEl.innerHTML = '';
    if (!history.length) {
      msgsEl.appendChild(el('div', 'dth-ai-empty', t('aiChatEmpty')));
      return;
    }
    for (const m of history) addBubble(m.role, m.content, m.quote);
  }

  function scrollToBottom() {
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    sendBtn.textContent = v ? '⏳' : '➤';
  }

  // --- Send flow ---

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autosize();
    dispatch(text, pendingQuote);
  }

  async function dispatch(text, quote, isFollowup) {
    if (busy) return;
    if (!history.length) msgsEl.innerHTML = '';
    setQuote('');
    history.push(quote ? { role: 'user', content: text, quote } : { role: 'user', content: text });
    saveHistory();
    addBubble('user', text, quote);
    setBusy(true);

    let context = collectContext(ctxToggle.checked);
    if (shotToggle && shotToggle.checked) {
      // В середине цепочки действий полностраничный скриншот нельзя:
      // его прокрутка закрывает открытые диалоги/календари.
      const wantFull = shotFullToggle && shotFullToggle.checked && !isFollowup;
      const shot = wantFull ? await captureFullPage() : await captureScreenshot();
      if (shot) (context || (context = {})).screenshot = shot;
    }
    const bubble = addBubble('assistant', '');
    bubble.classList.add('dth-ai-typing');
    for (let i = 0; i < 3; i++) bubble.appendChild(document.createElement('span'));
    let acc = '';
    let finished = false;

    let port;
    try {
      port = chrome.runtime.connect({ name: 'dth-ai-chat' });
    } catch (e) {
      bubble.classList.add('dth-ai-error');
      bubble.textContent = t('errorPrefix') + e.message;
      setBusy(false);
      return;
    }

    const finish = (errText) => {
      if (finished) return;
      finished = true;
      try { port.disconnect(); } catch { }
      bubble.classList.remove('dth-ai-typing');
      if (errText) {
        bubble.classList.add('dth-ai-error');
        bubble.textContent = errText;
      } else if (acc) {
        const clean = visibleText(acc);
        const urls = extractDownloads(acc);
        if (clean) setMd(bubble, clean);
        else bubble.remove();
        history.push({ role: 'assistant', content: clean || acc });
        saveHistory();
        for (const u of urls) startDownload(u, context && context.media);
        const chainEnd = END_RE.test(acc);
        const acts = extractActions(acc);
        for (const a of acts) runAction(a, chainEnd);
        // Ответ без кликов/ввода = цепочка действий закончилась.
        if (!acts.some(a => a.op !== 'scroll')) endDebugSession();
      } else {
        bubble.remove();
      }
      setBusy(false);
    };

    port.onMessage.addListener((m) => {
      if (!m) return;
      if (m.type === 'chunk') {
        if (!acc) bubble.classList.remove('dth-ai-typing');
        acc += m.text;
        setMd(bubble, visibleText(acc) || '…');
        scrollToBottom();
      } else if (m.type === 'done') {
        finish();
      } else if (m.type === 'error') {
        finish(t('errorPrefix') + m.error);
      }
    });

    port.onDisconnect.addListener(() => {
      if (!finished) {
        if (acc) finish();
        else finish(t('errorPrefix') + (chrome.runtime.lastError?.message || 'connection lost'));
      }
    });

    // Цитаты вшиваем в текст сообщения для модели
    const outMessages = history.slice(-16).map(m => m.quote
      ? { role: m.role, content: `[Quoted from the page]\n"""\n${m.quote}\n"""\n\n${m.content}` }
      : { role: m.role, content: m.content });
    port.postMessage({ type: 'ask', messages: outMessages, context });
  }

  // --- Settings / locale ---

  async function init() {
    try {
      const s = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getSettings' }, (resp) => resolve(resp || {}));
      });
      aiSettings = s;
      await ensureOverrideLocale(s.uiLang);
    } catch { }
    if (document.body) buildUI();
    else document.addEventListener('DOMContentLoaded', buildUI, { once: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ai-quote') {
      if (!panel) return;
      // selectionText из контекстного меню схлопывает переносы строк и может
      // обрезаться — берём живое выделение со страницы, если оно ещё есть.
      const live = (window.getSelection && String(window.getSelection()).trim()) || '';
      setQuote(live || msg.text);
      if (!panel.classList.contains('dth-ai-open')) togglePanel();
      else inputEl.focus();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    chrome.runtime.sendMessage({ type: 'getSettings' }, (s) => { if (s) aiSettings = s; });
    if (!changes.uiLang) return;
    ensureOverrideLocale(changes.uiLang.newValue).then(() => {
      if (!panel) return;
      panel.querySelector('.dth-ai-title').textContent = t('aiChatTitle');
      inputEl.placeholder = t('aiChatPlaceholder');
      fab.title = t('aiChatFabTitle');
    });
  });

  init();
})();
