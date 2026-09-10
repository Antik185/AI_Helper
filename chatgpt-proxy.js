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
        
        const uiLabels = new Set([
          'edit', 'edit response', 'copy', 'copy response', 'read aloud', 'regenerate',
          'good response', 'bad response', 'share',
          'редактировать', 'редактировать ответ', 'копировать', 'копировать ответ',
          'озвучить', 'повторить', 'хороший ответ', 'плохой ответ', 'поделиться'
        ]);
        const cleanMessageText = value => {
          const text = String(value || '').replace(/\r\n?/g, '\n').trim();
          if (!text) return '';
          const lines = text.split('\n');
          if (lines.length === 1) return text;
          return lines.filter(line => {
            const label = line.trim().replace(/[.:…]+$/g, '').toLowerCase();
            return !uiLabels.has(label);
          }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        };
        const isVisible = element => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const getAssistantText = element => {
          const contentNodes = Array.from(
            element.querySelectorAll('[data-message-content], .markdown, .prose')
          ).filter(isVisible);
          const content = contentNodes[contentNodes.length - 1];
          if (content) return cleanMessageText(content.innerText || content.textContent);

          const clone = element.cloneNode(true);
          clone.querySelectorAll(
            'button, nav, input, textarea, select, svg, [role="button"], [data-testid*="action"]'
          ).forEach(node => node.remove());
          return cleanMessageText(clone.textContent);
        };
        const getVisibleAssistants = () => Array.from(
          document.querySelectorAll('[data-message-author-role="assistant"]')
        ).filter(isVisible);
        const getLatestAnswer = () => {
          const assistants = getVisibleAssistants();
          for (let index = assistants.length - 1; index >= 0; index--) {
            const text = getAssistantText(assistants[index]);
            if (text) return text;
          }
          const markdown = Array.from(document.querySelectorAll('.markdown')).filter(isVisible);
          return markdown.length
            ? cleanMessageText(markdown[markdown.length - 1].innerText)
            : '';
        };
        const isGenerationActive = () => Array.from(document.querySelectorAll(
          '[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Останов"], .result-streaming'
        )).some(isVisible);
        const hasContinueGenerating = () => Array.from(document.querySelectorAll('button')).some(button => {
          if (!isVisible(button)) return false;
          const label = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`;
          return /continue generating|продолжить генерацию|продолжить ответ/i.test(label);
        });
        
        const oldLastText = getLatestAnswer();
        const oldAssistantCount = getVisibleAssistants().length;
        const oldUserCount = Array.from(
          document.querySelectorAll('[data-message-author-role="user"]')
        ).filter(isVisible).length;

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

        const composerText = () => textarea.tagName === 'TEXTAREA'
          ? (textarea.value || '')
          : (textarea.innerText || textarea.textContent || '');
        const compactComposerText = value => String(value || '').replace(/\s+/g, ' ').trim();
        const selectComposerContents = () => {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(textarea);
          sel.removeAllRanges();
          sel.addRange(range);
        };

        // Вставляем текст (работает и для textarea, и для contenteditable div).
        // Для contenteditable используем только paste: немедленный insertText
        // после paste создавал гонку и иногда дублировал весь prompt.
        textarea.focus();
        
        if (textarea.tagName === 'TEXTAREA') {
          const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSet) {
            nativeSet.call(textarea, msg.text);
          } else {
            textarea.value = msg.text;
          }
        } else {
          selectComposerContents();
          
          const dt = new DataTransfer();
          dt.setData('text/plain', msg.text);
          textarea.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          }));
        }
        
        // Пробуждаем React, чтобы он увидел новый текст
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // React/ProseMirror применяет paste не обязательно в тот же DOM-такт.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise(resolve => setTimeout(resolve, 80));
        const expectedComposer = compactComposerText(msg.text);
        let actualComposer = compactComposerText(composerText());
        if (!actualComposer && textarea.tagName !== 'TEXTAREA') {
          // Повторяем тот же безопасный способ только после подтверждения, что
          // первая вставка действительно не была принята.
          selectComposerContents();
          const retryData = new DataTransfer();
          retryData.setData('text/plain', msg.text);
          textarea.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: retryData,
            bubbles: true,
            cancelable: true
          }));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          actualComposer = compactComposerText(composerText());
        }
        if (!actualComposer) {
          throw new Error('ChatGPT не принял текст запроса. Обнови вкладку и повтори.');
        }
        const firstPromptAt = actualComposer.indexOf(expectedComposer);
        const secondPromptAt = firstPromptAt >= 0
          ? actualComposer.indexOf(expectedComposer, firstPromptAt + expectedComposer.length)
          : -1;
        if (expectedComposer && secondPromptAt >= 0) {
          throw new Error('ChatGPT продублировал текст в поле ввода. Отправка остановлена; очисти поле и повтори запрос.');
        }
        if (expectedComposer && actualComposer !== expectedComposer) {
          throw new Error('В поле ChatGPT остался другой текст. Отправка остановлена, чтобы не смешивать запросы.');
        }

        // Отправка. С длинными промптами (ИИ-чат с контекстом страницы) React
        // обновляет composer не сразу: кнопка может быть disabled или клик может
        // "не засчитаться". Поэтому кликаем в цикле и ПРОВЕРЯЕМ, что сообщение
        // реально ушло (composer опустел или началась генерация).
        const sendingStarted = () =>
          isGenerationActive() ||
          Array.from(document.querySelectorAll('[data-message-author-role="user"]')).filter(isVisible).length > oldUserCount ||
          !composerText().trim();

        await new Promise(r => setTimeout(r, 300));
        let sent = false;
        let nextSendAttemptAt = 0;
        for (let i = 0; i < 50 && !sent; i++) { // до ~10 сек
          const btn = document.querySelector('[data-testid="send-button"]');
          if (btn && !btn.disabled && Date.now() >= nextSendAttemptAt) {
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
        
        // Ждем ответа
        await new Promise(r => setTimeout(r, 500));
        let attempts = 0;
        let finalResponse = '';
        let stableText = '';
        let stableCount = 0;
        let continueCount = 0;
        let generationStarted = false;
        
        while (attempts < 1800) { // до 180 сек (длинный контекст страницы = долгая генерация)
          await new Promise(r => setTimeout(r, 100));
          attempts++;
          
          const currentLastText = getLatestAnswer();
          
          if (!generationStarted) {
            if (currentLastText !== oldLastText
              || getVisibleAssistants().length > oldAssistantCount
              || isGenerationActive()) {
              generationStarted = true;
            }
          }
          
          if (generationStarted) {
            const isGenerating = isGenerationActive();
            const needsContinuation = hasContinueGenerating();
            if (!isGenerating && needsContinuation) {
              continueCount++;
              if (continueCount >= 10) {
                throw new Error('ChatGPT остановил ответ до завершения. Нажми Continue generating и повтори запрос.');
              }
            } else {
              continueCount = 0;
            }

            if (!isGenerating && !needsContinuation) {
               if (currentLastText && currentLastText === stableText) {
                 stableCount++;
               } else {
                 stableText = currentLastText;
                 stableCount = 1;
               }
               
               // После исчезновения Stop ждём устойчивый DOM примерно 2 секунды,
               // затем делаем дополнительную контрольную проверку.
               if (stableCount >= 18 && currentLastText) {
                 await new Promise(r => setTimeout(r, 500));
                 const confirmedText = getLatestAnswer();
                 if (confirmedText === currentLastText && !isGenerationActive() && !hasContinueGenerating()) {
                   finalResponse = confirmedText;
                   break;
                 }
                 stableText = confirmedText;
                 stableCount = 0;
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
