# AI Helper

AI Helper is a Chrome extension for fast translation and page-aware AI help.

It started as a Discord translation helper, but now also supports X/Twitter and common text inputs on most websites.

## Features

- Translate Discord messages inline.
- Translate your own text before sending it in Discord, X/Twitter, Google Search, YouTube, and many other sites.
- Quick target-language dropdown next to the translate button.
- Movable translate button: drag it by the small handle, double-click the handle to reset its position.
- Smart dropdown direction: opens upward when the input is near the bottom of the screen.
- Translation can be enabled or disabled from the popup.
- AI chat on pages, marked as beta and disabled by default.
- Light/dark popup theme.
- Interface languages: English, Russian, Ukrainian, German, French, Spanish, Portuguese, Turkish, Polish, Arabic, Chinese, and Japanese.

## Translation Providers

- `OpenRouter Free` - uses OpenRouter's free-model route. It still requires an OpenRouter API key, but routes requests to free models.
- `Google Translate` - no key required, uses the public Google Translate endpoint.
- `ChatGPT` - uses the active ChatGPT tab/session.
- `Gemini` - requires your Gemini API key.
- `OpenRouter` - requires your own OpenRouter API key. Supports Gemini Flash, Gemini Flash Lite, and OpenRouter Free model routing.
- `MyMemory` - no email field, simple free translation endpoint.
- `DeepL` - requires a DeepL API key.

LibreTranslate was removed from the popup and permissions to keep the first Chrome version simpler.

## Install In Chrome

1. Download or clone this repository.
2. Open `chrome://extensions/`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the project folder, for example `E:\discordHelper`.
6. Open or refresh Discord, X/Twitter, or another website.
7. Open the extension popup and choose your translation provider and languages.

If you edit the source code, reload the extension in `chrome://extensions/` and refresh the website tab.

## How To Use

### Translate Discord Messages

1. Open Discord in the browser.
2. Hover or look near a message.
3. Click the translate button.
4. The translation appears under the original message.

### Translate Your Own Message

1. Start typing in a message box or text input.
2. The translate button appears near the input.
3. Click the main button to replace your draft with the translated text.
4. Use the arrow button to choose another target language quickly.
5. Drag the small handle if the button covers something important.

### AI Chat Beta

AI chat is disabled by default.

To enable it:

1. Open the extension popup.
2. Turn on `AI Chat`.
3. Choose the AI chat provider.
4. Open a page and use the floating AI button.

The AI chat can use page context, so it is intended for prompts like:

- "Analyze this page."
- "Pick the best option from this website."
- "Summarize the selected text."
- "Explain what this product page is saying."

## Notes For Public Builds

The public extension source code does not contain a shared API key. `OpenRouter Free` uses the user's OpenRouter API key and routes requests to free models.

Do not put paid API keys into public extension source code.

---

# AI Helper на русском

AI Helper - расширение для Chrome, которое помогает быстро переводить текст и пользоваться AI-помощником с учетом текущей страницы.

Сначала это был помощник для Discord, но теперь он также работает в X/Twitter и во многих обычных полях ввода на сайтах.

## Возможности

- Перевод сообщений в Discord прямо под оригинальным сообщением.
- Перевод твоего текста перед отправкой в Discord, X/Twitter, Google Search, YouTube и на других сайтах.
- Быстрый выбор языка через стрелочку рядом с кнопкой перевода.
- Кнопку перевода можно двигать: тяни за маленькую ручку, двойной клик по ручке сбрасывает позицию.
- Выпадающее меню само открывается вверх, если поле ввода находится снизу экрана.
- Перевод можно включить или выключить в popup-окне расширения.
- AI-чат на страницах помечен как beta и по умолчанию выключен.
- Светлая и темная тема popup-окна.
- Языки интерфейса: английский, русский, украинский, немецкий, французский, испанский, португальский, турецкий, польский, арабский, китайский и японский.

## Провайдеры перевода

- `OpenRouter Free` - использует free-model route от OpenRouter. OpenRouter API key всё равно нужен, но запросы идут в бесплатные модели.
- `Google Translate` - без ключа, использует публичный endpoint Google Translate.
- `ChatGPT` - использует активную вкладку/сессию ChatGPT.
- `Gemini` - нужен твой Gemini API key.
- `OpenRouter` - нужен твой OpenRouter API key. Есть Gemini Flash, Gemini Flash Lite и OpenRouter Free routing.
- `MyMemory` - без email-поля, простой бесплатный endpoint.
- `DeepL` - нужен DeepL API key.

LibreTranslate убран из popup и permissions, чтобы первая Chrome-версия была проще и стабильнее.

## Установка в Chrome

1. Скачай или склонируй этот репозиторий.
2. Открой `chrome://extensions/`.
3. Включи `Режим разработчика`.
4. Нажми `Загрузить распакованное`.
5. Выбери папку проекта, например `E:\discordHelper`.
6. Открой или обнови Discord, X/Twitter или другой сайт.
7. Открой popup расширения и выбери провайдера перевода и языки.

Если меняешь код, перезагрузи расширение в `chrome://extensions/` и обнови вкладку сайта.

## Как пользоваться

### Перевод сообщений Discord

1. Открой Discord в браузере.
2. Найди сообщение.
3. Нажми кнопку перевода рядом с сообщением.
4. Перевод появится под оригинальным текстом.

### Перевод своего сообщения

1. Начни писать в поле сообщения или обычное поле ввода.
2. Рядом появится кнопка перевода.
3. Нажми основную кнопку, чтобы заменить черновик на перевод.
4. Нажми стрелочку, чтобы быстро выбрать другой язык.
5. Если кнопка мешает, перетащи ее за маленькую ручку.

### AI-чат Beta

AI-чат по умолчанию выключен.

Чтобы включить:

1. Открой popup расширения.
2. Включи `AI Chat`.
3. Выбери провайдера AI-чата.
4. Открой страницу и используй плавающую AI-кнопку.

AI-чат может учитывать контекст страницы, поэтому его можно использовать для запросов вроде:

- "Сделай анализ этого сайта."
- "Подбери лучший вариант из тех, что есть на странице."
- "Кратко перескажи выделенный текст."
- "Объясни, что написано на этой странице товара."

## Важно для публичной сборки

Публичный исходный код расширения не содержит общий API-ключ. `OpenRouter Free` использует OpenRouter API key пользователя и отправляет запросы в бесплатные модели.

Не добавляй платные API-ключи в публичный исходный код расширения.
