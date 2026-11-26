// Dedicated proxy script to relay background fetch requests through the chatgpt.com DOM.
// This allows the extension to naturally bypass Cloudflare Turnstile and Proof-of-Work checks.

console.log('[DTH] ChatGPT Proxy Script Loaded.');

const CHATGPT_EDITOR_SELECTOR = 'textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const CHATGPT_EDITOR_ANCHORS = '#prompt-textarea, [name="prompt-textarea"], [data-testid="prompt-textarea"], [data-testid="composer-input"]';
const CHATGPT_COMPOSER_REGIONS = 'form[data-type="unified-composer"], [data-testid="composer"], [data-testid="composer-container"], #thread-bottom-container, #thread-bottom, [class*="ComposerLayoutBody-"]';
const CHATGPT_MODERN_EDITOR_SELECTOR = 'main .ProseMirror[role="textbox"][data-virtualkeyboard="true"]';
const CHATGPT_SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[data-testid="composer-send-button"], button#composer-submit-button, button[type="submit"]';
const CHATGPT_EDITOR_BLOCKS = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TD', 'TH']);

function isWritableChatGPTEditor(element) {
  if (!element.matches(CHATGPT_EDITOR_SELECTOR) || element.matches(':disabled, [readonly]')) return false;
  if (element.closest('dialog, [role="dialog"], [hidden], [inert], [aria-hidden="true"], [aria-disabled="true"], [aria-readonly="true"]')) return false;

  return element.getClientRects().length > 0 && window.getComputedStyle(element).visibility === 'visible';
}

function findChatGPTComposer() {
  for (const anchor of document.querySelectorAll(CHATGPT_EDITOR_ANCHORS)) {
    if (isWritableChatGPTEditor(anchor)) return anchor;
    for (const editor of anchor.querySelectorAll(CHATGPT_EDITOR_SELECTOR)) {
      if (isWritableChatGPTEditor(editor)) return editor;
    }
  }

  for (const region of document.querySelectorAll(CHATGPT_COMPOSER_REGIONS)) {
    const editors = Array.from(region.querySelectorAll(CHATGPT_EDITOR_SELECTOR)).filter(isWritableChatGPTEditor);
    if (editors.length === 1) return editors[0];
  }
  const editors = Array.from(document.querySelectorAll(CHATGPT_MODERN_EDITOR_SELECTOR)).filter(isWritableChatGPTEditor);
  return editors.length === 1 ? editors[0] : null;
}

function findChatGPTSendButton(editor) {
  const region = editor.closest(CHATGPT_COMPOSER_REGIONS) || editor.closest('fieldset, form');
  const candidates = region ? region.querySelectorAll('button') : document.querySelectorAll('button[data-testid="send-button"]');
  for (const button of candidates) {
    if (button.disabled || button.getAttribute('aria-disabled') === 'true' || !button.getClientRects().length) continue;
    if (/voice|голос|диктов/i.test(`${button.getAttribute('data-testid') || ''} ${button.getAttribute('aria-label') || ''}`)) continue;
    const label = button.getAttribute('aria-label') || '';
    if (button.matches(CHATGPT_SEND_BUTTON_SELECTOR)
      || /^(send(?: (?:message|prompt))?|отправить(?: (?:сообщение|запрос))?)$/i.test(label.trim())) return button;
  }
  return null;
}

function findChatGPTTextAttachmentActions(editor) {
  const scopes = new Set([editor.closest('fieldset'), editor.closest('form'), editor.closest(CHATGPT_COMPOSER_REGIONS)]);
  for (const scope of scopes) {
    if (!scope) continue;
    const actions = Array.from(scope.querySelectorAll('button, a, [role="button"], [role="link"]')).filter(control => {
      if (!control.getClientRects().length || window.getComputedStyle(control).visibility !== 'visible') return false;
      return [control.getAttribute('aria-label'), control.innerText || control.textContent].some(label =>
        /^(?:show in (?:the )?text field|показать в текстовом поле)$/i.test(String(label || '').replace(/\s+/g, ' ').trim()));
    });
    if (actions.length) return actions;
  }
  return [];
}

function assertNoChatGPTTextAttachment(editor) {
  if (findChatGPTTextAttachmentActions(editor).length) {
    throw new Error('В ChatGPT осталась карточка с текстом предыдущего запроса. Закрой её крестиком и повтори запрос.');
  }
}

function readChatGPTComposerText(editor) {
  if (!editor) return '';
  if (editor.tagName === 'TEXTAREA') return editor.value || '';
  if (!editor.classList.contains('ProseMirror')) return editor.innerText || editor.textContent || '';

  // Link decorations and layout can change innerText without changing the prompt.
  const parts = [];
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.data);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE
      || node.matches('.ProseMirror-widget, .ProseMirror-separator, br.ProseMirror-trailingBreak')) return;
    if (node.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    const block = CHATGPT_EDITOR_BLOCKS.has(node.tagName);
    if (block && parts.length && parts[parts.length - 1] !== '\n') parts.push('\n');
    for (const child of node.childNodes) visit(child);
    if (block) parts.push('\n');
  }
  for (const child of editor.childNodes) visit(child);
  return parts.join('');
}

function normalizeChatGPTComposerText(value) {
  return String(value || '').normalize('NFC').replace(/[\u200B\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

async function insertChatGPTPrompt(editor, text) {
  const expected = normalizeChatGPTComposerText(text);
  if (!expected) throw new Error('Нет текста для отправки в ChatGPT.');
  assertNoChatGPTTextAttachment(editor);

  editor.focus();
  let insertedNatively = false;
  if (editor.tagName === 'TEXTAREA') {
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSet) nativeSet.call(editor, text);
    else editor.value = text;
  } else {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);

      if (text.length >= 4000 && editor.matches('.ProseMirror')) {
        // Native editing lets ProseMirror accept long plain text without going through its paste-to-card feature.
        const before = readChatGPTComposerText(editor);
        try {
          insertedNatively = document.execCommand('insertText', false, text) === true;
        } catch { }
        insertedNatively ||= !editor.isConnected || readChatGPTComposerText(editor) !== before;
      }
    }
    if (!insertedNatively) {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
  }
  if (!insertedNatively) editor.dispatchEvent(new Event('input', { bubbles: true }));

  let deadline = Date.now() + 4_000;
  let expanded = false;
  let actual = '';
  let actions = [];
  do {
    if (!editor?.isConnected) editor = findChatGPTComposer();
    if (editor) {
      actual = normalizeChatGPTComposerText(readChatGPTComposerText(editor));
      actions = findChatGPTTextAttachmentActions(editor);
      if (actual === expected && actions.length === 0) return editor;

      // ChatGPT can move a long clipboard paste into a text attachment instead of the editor.
      if (!actual && !expanded && actions.length === 1) {
        const action = actions[0];
        if (!action.disabled && action.getAttribute('aria-disabled') !== 'true') {
          expanded = true;
          action.click();
          deadline = Math.max(deadline, Date.now() + 4_000);
        }
      }
      if (actions.length > 1) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);

  if (actions.length || (expanded && actual !== expected)) {
    throw new Error('Не удалось развернуть вложенный текст запроса целиком. Проверь черновик в ChatGPT и очисти его перед повтором.');
  }
  if (!actual) throw new Error('ChatGPT не принял текст запроса. Обнови вкладку и повтори.');
  const firstPromptAt = actual.indexOf(expected);
  if (firstPromptAt >= 0 && actual.indexOf(expected, firstPromptAt + expected.length) >= 0) {
    throw new Error('ChatGPT продублировал текст в поле ввода. Отправка остановлена; очисти поле и повтори запрос.');
  }
  throw new Error('В поле ChatGPT остался другой текст. Отправка остановлена, чтобы не смешивать запросы.');
}

async function waitForChatGPTComposer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const editor = findChatGPTComposer();
    if (editor) return editor;
    if (/^(just a moment|один момент)[\s.…]*$/i.test(document.title || '')) {
      const error = new Error('ChatGPT показывает проверку браузера. Пройди её вручную во вкладке ChatGPT и снова включи 1px Mode.');
      error.code = 'verification';
      throw error;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, remainingMs)));
  }
  throw new Error(`Не найдено доступное поле ввода в выбранной вкладке ChatGPT (ширина страницы: ${window.innerWidth}px). Открой окно ChatGPT и проверь, что выбран нужный чат.`);
}

function getChatGPTLocalScreenBounds() {
  return {
    width: window.screen.availWidth, height: window.screen.availHeight,
    left: window.screen.availLeft, top: window.screen.availTop
  };
}

function isChatGPTVisible(element) {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility === 'visible' && element.getClientRects().length > 0;
}

const CHATGPT_RESPONSE_UI_LABELS = new Set([
  'edit', 'edit response', 'copy', 'copy response', 'read aloud', 'regenerate',
  'good response', 'bad response', 'share',
  'редактировать', 'редактировать ответ', 'копировать', 'копировать ответ',
  'озвучить', 'повторить', 'хороший ответ', 'плохой ответ', 'поделиться'
]);

function cleanChatGPTResponseText(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  const lines = text.split('\n');
  if (lines.length === 1) return text;
  return lines.filter(line => {
    const label = line.trim().replace(/[.:…]+$/g, '').toLowerCase();
    return !CHATGPT_RESPONSE_UI_LABELS.has(label);
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readChatGPTResponseBody(element) {
  if (element.matches('[data-response-body], .markdown, .prose')) {
    return cleanChatGPTResponseText(element.innerText || element.textContent);
  }
  const contentNodes = Array.from(element.querySelectorAll('[data-message-content], .markdown, .prose')).filter(isChatGPTVisible);
  const content = contentNodes[contentNodes.length - 1];
  if (content) return cleanChatGPTResponseText(content.innerText || content.textContent);

  const clone = element.cloneNode(true);
  clone.querySelectorAll('button, nav, input, textarea, select, svg, [role="button"], [data-testid*="action"]').forEach(node => node.remove());
  return cleanChatGPTResponseText(clone.textContent);
}

function getLatestChatGPTResponse() {
  let bodies = Array.from(document.querySelectorAll('[data-response-body], [data-message-author-role="assistant"]'))
    .filter(element => isChatGPTVisible(element) && !element.querySelector('[data-response-body]'));
  if (!bodies.length) {
    bodies = Array.from(document.querySelectorAll('.markdown')).filter(element =>
      isChatGPTVisible(element) && !element.closest('[data-message-author-role="user"], [data-user-message-bubble], .rich-text-user-turn'));
  }

  const latest = bodies[bodies.length - 1];
  if (!latest) return { count: 0, key: '', text: '', turnState: '' };
  const responseId = latest.getAttribute('data-response-body');
  const parts = responseId ? bodies.filter(element => element.getAttribute('data-response-body') === responseId) : [latest];
  return {
    count: bodies.length,
    key: responseId || latest.closest('[data-message-id]')?.getAttribute('data-message-id') || '',
    text: parts.map(readChatGPTResponseBody).filter(Boolean).join('\n\n'),
    turnState: latest.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') || ''
  };
}

function isChatGPTGenerating() {
  return Array.from(document.querySelectorAll(
    '[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Останов"], .result-streaming'
  )).some(isChatGPTVisible);
}

function hasChatGPTContinueAction() {
  return Array.from(document.querySelectorAll('button')).some(button => {
    if (!isChatGPTVisible(button)) return false;
    const label = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`;
    return /continue generating|продолжить генерацию|продолжить ответ/i.test(label);
  });
}

function countChatGPTUserMessages() {
  return Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-user-message-bubble]'))
    .filter(isChatGPTVisible).length;
}

async function waitForChatGPTResponse(previous, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let stable = null;
  let continueSince = null;
  while (Date.now() < deadline) {
    const response = getLatestChatGPTResponse();
    const fresh = response.text && (response.key && previous.key
      ? response.key !== previous.key
      : response.count > previous.count || response.text !== previous.text);
    const needsContinuation = fresh && hasChatGPTContinueAction();
    const complete = response.turnState ? response.turnState === 'complete' : !isChatGPTGenerating();
    const now = Date.now();

    if (needsContinuation) {
      continueSince ??= now;
      if (now - continueSince >= 1_000) {
        throw new Error('ChatGPT остановил ответ до завершения. Нажми Continue generating и повтори запрос.');
      }
    } else {
      continueSince = null;
    }

    if (fresh && complete && !needsContinuation) {
      if (stable?.key !== response.key || stable?.text !== response.text) {
        stable = { key: response.key, text: response.text, since: now };
      } else if (now - stable.since >= 2_000) {
        return response.text;
      }
    } else {
      stable = null;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Таймаут ожидания ответа');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.type === 'get-screen-size') {
    sendResponse(getChatGPTLocalScreenBounds());
    return false;
  }

  if (msg && msg.type === 'chatgpt-composer-status') {
    waitForChatGPTComposer(msg.wait === true ? 6_000 : 0).then(
      () => sendResponse({ ok: true }),
      error => sendResponse({ ok: false, code: error.code, error: error.message })
    );
    return true;
  }

  if (msg && msg.type === 'chatgpt-fetch') {
    (async () => {
      try {
        const res = await fetch(msg.url, msg.options);
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, text });
      } catch (err) {
        sendResponse({ ok: false, error: err.message, status: 0 });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'chatgpt-ui-translate') {
    (async () => {
          let stopAudio = () => {};
      try {
        let textarea = await waitForChatGPTComposer();
        assertNoChatGPTTextAttachment(textarea);

            // Трюк с аудио: воспроизводим полную тишину.
            // Chrome думает "вкладка играет звук" и ПОЛНОСТЬЮ отключает заморозку (Occlusion),
            // даже если окно перекрыто другими!
            try {
              const AudioContext = window.AudioContext || window.webkitAudioContext;
              if (AudioContext) {
                const ctx = new AudioContext();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                gain.gain.value = 0; // Полностью без звука
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                stopAudio = () => { try { osc.stop(); ctx.close(); } catch(e){} };
              }
            } catch(e) {}

        // 2. Внедряем скрипт-обманку: заставляем React и ProseMirror думать, что вкладка активна
        try {
          const script = document.createElement('script');
          script.textContent = `
            try {
              if (!window.__dth_injected) {
                window.__dth_injected = true;
                Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
                Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
                Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
                window.requestAnimationFrame = function(cb) {
                   return window.setTimeout(() => cb(performance.now()), 16);
                };
              }
            } catch(e) {}
          `;
          document.documentElement.appendChild(script);
          script.remove();
        } catch(e) {}

        const previousResponse = getLatestChatGPTResponse();
        const oldUserCount = countChatGPTUserMessages();

        // Скриншот: вставляем как файл paste-событием — composer ChatGPT
        // принимает картинки из буфера и показывает превью-вложение.
        if (msg.image) {
          try {
            const blob = await (await fetch(msg.image)).blob();
            const file = new File([blob], 'screenshot.jpg', { type: blob.type || 'image/jpeg' });
            const dt = new DataTransfer();
            dt.items.add(file);
            textarea.focus();
            textarea.dispatchEvent(new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true
            }));
            // Ждём появления превью вложения (пока грузится, send-кнопка disabled —
            // цикл отправки ниже это тоже учитывает).
            for (let i = 0; i < 25; i++) {
              await new Promise(r => setTimeout(r, 200));
              if (document.querySelector('[data-testid*="attachment"], button[aria-label*="Remove"], button[aria-label*="Удалить"]')) break;
            }
          } catch (e) {
            console.warn('[DTH] Не удалось вложить скриншот:', e);
          }
        }

        if (!textarea.isConnected) textarea = await waitForChatGPTComposer();
        textarea = await insertChatGPTPrompt(textarea, msg.text);

        // Отправка. С длинными промптами (ИИ-чат с контекстом страницы) React
        // обновляет composer не сразу: кнопка может быть disabled или клик может
        // "не засчитаться". Поэтому кликаем в цикле и ПРОВЕРЯЕМ, что сообщение
        // реально ушло (composer опустел или началась генерация).
        const sendingStarted = () =>
          isChatGPTGenerating() ||
          countChatGPTUserMessages() > oldUserCount ||
          !readChatGPTComposerText(textarea).trim();

        await new Promise(r => setTimeout(r, 300));
        if (!textarea.isConnected) textarea = findChatGPTComposer();
        if (normalizeChatGPTComposerText(readChatGPTComposerText(textarea)) !== normalizeChatGPTComposerText(msg.text)) {
          throw new Error('Текст запроса изменился после вставки. Отправка остановлена.');
        }
        assertNoChatGPTTextAttachment(textarea);
        let sent = false;
        let nextSendAttemptAt = 0;
        for (let i = 0; i < 50 && !sent; i++) { // до ~10 сек
          const btn = findChatGPTSendButton(textarea);
          if (btn && Date.now() >= nextSendAttemptAt) {
            btn.click();
            // Не кликаем каждые 200 мс: React может принять первый клик с
            // задержкой, а повторный клик способен отправить prompt ещё раз.
            nextSendAttemptAt = Date.now() + 2500;
          } else {
            // Кнопки нет или она disabled — пробуждаем React ещё раз
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            // Каждую секунду пробуем Enter как альтернативный способ отправки
            if (i > 15 && i % 15 === 0 && Date.now() >= nextSendAttemptAt) {
              textarea.focus();
              textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
              nextSendAttemptAt = Date.now() + 2500;
            }
          }
          await new Promise(r => setTimeout(r, 200));
          if (sendingStarted()) sent = true;
        }
        if (!sent) throw new Error('Не удалось отправить сообщение: кнопка отправки не сработала. Обнови вкладку chatgpt.com.');
        
        const finalResponse = await waitForChatGPTResponse(previousResponse);
        sendResponse({ ok: true, text: finalResponse });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      } finally {
        stopAudio();
      }
    })();
    return true;
  }
});

// Mount outside the app's React tree and restore the control if the body is replaced.
if (!document.getElementById('dth-1px-host')) {
  const host = document.createElement('div');
  host.id = 'dth-1px-host';
  host.style.cssText = 'all:initial; position:fixed; bottom:20px; right:20px; z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const btn = document.createElement('button');
  btn.id = 'dth-1px-btn';
  btn.type = 'button';
  btn.textContent = '1px Mode';
  btn.style.cssText = 'padding:7px 10px; background:#087f62; color:white; border:1px solid #ffffff80; border-radius:8px; cursor:pointer; font:600 12px sans-serif; box-shadow:0 2px 8px #0004;';
  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = 'Setting up…';
    const restore = () => {
      btn.disabled = false;
      btn.textContent = '1px Mode';
    };
    const reset = setTimeout(restore, 30_000);
    chrome.runtime.sendMessage({
      type: 'setup-chatgpt-window', screenBounds: getChatGPTLocalScreenBounds()
    }, (resp) => {
      const error = chrome.runtime.lastError?.message || resp?.error || '';
      clearTimeout(reset);
      restore();
      btn.title = error;
      if (error) btn.textContent = '1px Mode (!)';
    });
  };
  root.appendChild(btn);
  const observer = new MutationObserver(mount);
  function mount() {
    if (!document.body || host.parentNode === document.body) return;
    document.body.appendChild(host);
    observer.disconnect();
    observer.observe(document.documentElement, { childList: true });
    observer.observe(document.body, { childList: true });
  }
  mount();
}
