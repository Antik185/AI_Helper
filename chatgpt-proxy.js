// Dedicated proxy script to relay background fetch requests through the chatgpt.com DOM.
// This allows the extension to naturally bypass Cloudflare Turnstile and Proof-of-Work checks.

console.log('[DTH] ChatGPT Proxy Script Loaded.');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.type === 'get-screen-size') {
    sendResponse({ width: window.screen.availWidth, height: window.screen.availHeight });
    return false;
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

        const textarea = document.querySelector('#prompt-textarea');
        if (!textarea) throw new Error('Не найдено поле ввода на chatgpt.com');
        
        const getLatestAnswer = () => {
          const asst = document.querySelectorAll('[data-message-author-role="assistant"]');
          if (asst.length > 0) {
            const el = asst[asst.length - 1];
            const md = el.querySelector('.markdown');
            return md ? md.innerText : el.innerText;
          }
          const mds = document.querySelectorAll('.markdown');
          if (mds.length > 0) {
            return mds[mds.length - 1].innerText;
          }
          return '';
        };
        
        const oldLastText = getLatestAnswer();

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

        // Вставляем текст (работает и для textarea, и для contenteditable div)
        textarea.focus();
        
        if (textarea.tagName === 'TEXTAREA') {
          const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSet) {
            nativeSet.call(textarea, msg.text);
          } else {
            textarea.value = msg.text;
          }
        } else {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(textarea);
          sel.removeAllRanges();
          sel.addRange(range);
          
          const dt = new DataTransfer();
          dt.setData('text/plain', msg.text);
          textarea.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          }));
          
          if (!textarea.textContent.trim()) {
            document.execCommand('insertText', false, msg.text);
          }
        }
        
        // Пробуждаем React, чтобы он увидел новый текст
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // Отправка. С длинными промптами (ИИ-чат с контекстом страницы) React
        // обновляет composer не сразу: кнопка может быть disabled или клик может
        // "не засчитаться". Поэтому кликаем в цикле и ПРОВЕРЯЕМ, что сообщение
        // реально ушло (composer опустел или началась генерация).
        const composerText = () => textarea.tagName === 'TEXTAREA'
          ? (textarea.value || '')
          : (textarea.textContent || '');
        const sendingStarted = () =>
          document.querySelector('[data-testid="stop-button"]') != null ||
          document.querySelector('button[aria-label*="Stop"]') != null ||
          document.querySelector('.result-streaming') != null ||
          !composerText().trim();

        await new Promise(r => setTimeout(r, 300));
        let sent = false;
        for (let i = 0; i < 50 && !sent; i++) { // до ~10 сек
          const btn = document.querySelector('[data-testid="send-button"]');
          if (btn && !btn.disabled) {
            btn.click();
          } else {
            // Кнопки нет или она disabled — пробуждаем React ещё раз
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            // Каждую секунду пробуем Enter как альтернативный способ отправки
            if (i > 0 && i % 5 === 0) {
              textarea.focus();
              textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
            }
          }
          await new Promise(r => setTimeout(r, 200));
          if (sendingStarted()) sent = true;
        }
        if (!sent) throw new Error('Не удалось отправить сообщение: кнопка отправки не сработала. Обнови вкладку chatgpt.com.');
        
        // Ждем ответа
        await new Promise(r => setTimeout(r, 500));
        let attempts = 0;
        let finalResponse = '';
        let stableText = '';
        let stableCount = 0;
        let generationStarted = false;
        
        while (attempts < 1800) { // до 180 сек (длинный контекст страницы = долгая генерация)
          await new Promise(r => setTimeout(r, 100));
          attempts++;
          
          const currentLastText = getLatestAnswer();
          
          if (!generationStarted) {
            const isGeneratingBtn = document.querySelector('[data-testid="stop-button"]') != null;
            const isStreamingNode = document.querySelector('.result-streaming') != null;
            
            if (currentLastText !== oldLastText || isGeneratingBtn || isStreamingNode) {
              generationStarted = true;
            }
          }
          
          if (generationStarted) {
            const isGenerating = document.querySelector('[data-testid="stop-button"]') != null;
            const hasStopBtn = document.querySelector('button[aria-label*="Stop"]') != null;
            const isStreaming = document.querySelector('.result-streaming') != null;
            
            if (!isGenerating && !hasStopBtn && !isStreaming) {
               if (currentLastText && currentLastText === stableText) {
                 stableCount++;
               } else {
                 stableText = currentLastText;
                 stableCount = 1;
               }
               
               // Если текст не меняется 4 проверки подряд (400мс) и кнопок генерации нет
               if (stableCount >= 4 && currentLastText) {
                 finalResponse = currentLastText;
                 break;
               }
            } else {
               stableCount = 0;
               stableText = '';
            }
          }
        }
        
        if (!finalResponse) throw new Error('Таймаут ожидания ответа');
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

// Добавляем маленькую кнопку "1px Mode" прямо на страницу ChatGPT
if (!document.getElementById('dth-1px-btn')) {
  const btn = document.createElement('button');
  btn.id = 'dth-1px-btn';
  btn.innerText = '📌 1px Mode';
  btn.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:999999; padding:8px 12px; background:#10a37f; color:white; border:none; border-radius:8px; cursor:pointer; font-size:12px; opacity:0.3; transition:0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.1); font-family: sans-serif;';
  btn.onmouseover = () => btn.style.opacity = '1';
  btn.onmouseout = () => btn.style.opacity = '0.3';
  btn.onclick = () => {
    btn.innerText = '⏳...';
    // Страховка: если ответ потерялся (вкладку перенесли в новое окно и канал
    // умер), не оставляем вечный спиннер.
    const reset = setTimeout(() => { btn.innerText = '📌 1px Mode'; }, 12000);
    chrome.runtime.sendMessage({ type: 'setup-chatgpt-window' }, (resp) => {
      void chrome.runtime.lastError;
      clearTimeout(reset);
      btn.innerText = (resp && resp.ok === false) ? '⚠ ' + (resp.error || '').slice(0, 30) : '📌 1px Mode';
    });
  };
  document.body.appendChild(btn);
}
