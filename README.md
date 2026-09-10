# AI Helper

AI Helper is a Chrome extension for fast translation and page-aware AI help.

It started as a Discord translation helper, but now also supports X/Twitter and common text inputs on most websites.

## Features

- Translate Discord messages inline.
- Translate your own text before sending it in Discord, X/Twitter, Google Search, YouTube, and many other sites.
- Translate one X post in place with the small globe button after the author name; click again to restore the original.
- Quick target-language dropdown next to the translate button.
- Movable translate button: drag it by the small handle, double-click the handle to reset its position.
- Smart dropdown direction: opens upward when the input is near the bottom of the screen.
- Translation can be enabled or disabled from the popup.
- Optional automatic full-page translation with a movable status bar, language switcher, Undo, automatic collapse, and an extension-icon language badge.
- Translate selected text from the right-click menu in a movable overlay, with preserved formatting, text-to-speech, and side-by-side layouts.
- AI chat on pages, marked as beta and disabled by default.
- X Reply Agent Beta can analyze X posts, write reply drafts, and optionally run through a feed with a reply limit.
- Popup settings save automatically, and the X Reply Agent section can be collapsed.
- X Agent reports support local 1-5 ratings and written preferences that influence future replies through prompt examples.
- Light/dark popup theme.
- Interface languages: English, Russian, Ukrainian, German, French, Spanish, Portuguese, Turkish, Polish, Arabic, Chinese, and Japanese.

## Translation Providers

- `OpenRouter Free` - uses OpenRouter's free-model route. It still requires an OpenRouter API key, but routes requests to free models.
- `Google Translate` - no key required, uses the public Google Translate endpoint.
- `ChatGPT` - uses the active ChatGPT tab/session.
- `Gemini` - requires your Gemini API key. The model selector is loaded from Gemini's `ListModels` API. `Auto` chooses the newest stable text Flash model and falls back to another compatible Flash model when the selected model is retired or temporarily unavailable. If Google blocks `ListModels` because the current region is unsupported, the popup shows a built-in fallback catalog, but direct Gemini requests remain unavailable; choose OpenRouter or another provider instead.
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

### Translate A Whole Page Or Selected Text

1. Open the extension popup and enable `Translate pages automatically`.
2. Choose the page language. Full-page mode uses Google translation to avoid AI token costs.
3. Reload the website, or enable the option while the website is open. A toolbar appears in the top-right corner while the page is translated.
4. Use the toolbar to change the language, undo the translation, or minimize the controls. You can drag both the toolbar and its compact icon; after a successful translation it collapses automatically in five seconds. The extension icon also shows the active language code.
5. To translate only part of a page, select text, right-click it, and choose `Translate selected text`.
6. Drag the result card anywhere on the screen, use `Place by original`, enable `Show original`, or listen to the original and translated text. Line breaks, indentation, spacing, and emojis are preserved where supported by the selected provider.

Full-page mode stores original text only in the current page memory so Undo can restore it. Readable text blocks are sent to Google for translation, but page HTML is not uploaded. Selection translation uses the provider selected in the popup.

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

#### Use Your ChatGPT Subscription

AI Chat Beta can also work through your existing ChatGPT subscription instead of paid API requests.

Recommended setup:

1. Log in at `https://chatgpt.com/` in the same Chrome profile where the extension is installed.
2. Open a normal ChatGPT chat page with the message input visible.
3. Open the AI Helper popup.
4. Turn on `AI Chat`.
5. Select `ChatGPT` as the AI chat provider.
6. Choose how the helper should use ChatGPT:
   - For any chat, open the ChatGPT tab you want and press its floating `1px Mode` button. This explicitly selects that tab.
   - For one permanent chat, paste its full `https://chatgpt.com/c/...` URL into `ChatGPT conversation URL`, then press `Open configured chat in 1px mode`. Future requests will stay in that conversation until you select another tab with its own `1px Mode` button.
7. Keep the selected ChatGPT tab open. In `1px mode`, the page is moved into a tiny helper window behind your main browser, so the extension can send prompts through your logged-in ChatGPT session.
8. Return to the website you want to analyze and use the floating AI button.

This mode is useful if you already pay for ChatGPT and do not want every request to go through paid API providers. It depends on the ChatGPT web interface, so if ChatGPT changes its page layout, reload the ChatGPT tab and the target website first. If it still stops working, update the extension.

### X Reply Agent Beta

X Reply Agent is enabled by default. You can turn it off at any time from the extension popup or with the close button on its X panel.

To use it:

1. Open the extension popup.
2. Make sure `X Reply Agent` is enabled. It is enabled by default on new installations.
3. Choose `OpenRouter` or `ChatGPT subscription` in the separate Agent provider selector.
4. Choose the reply language in the outgoing `Translate to` setting. X Agent always uses this language, even when X automatically translates a post.
5. Write your agent prompt: tone, length, emojis, and what to avoid.
6. Set the feed run limit, for example `3` or `10`.
7. Choose how many saved memory examples are sent with each request. `0` disables memory; higher values increase input-token usage, cost, and response time.
8. Set a random delay range between `5` and `600` seconds. The default is `30-90` seconds.
9. Open X/Twitter. Posts will get a small `✦ AI` button in the action row.
10. Hover over `✦ AI` to turn `Auto send` on or off without opening the popup.
11. Click `✦ AI` to answer one specific post manually. The post is highlighted with a green border, the agent analyzes it, opens the reply composer, and inserts a reply.
12. The animated character sleeps while the agent is idle and digs while it is working. Drag the character to place it anywhere on the screen. Click it to open the full auto-saved Agent settings, a large countdown, and prominent Start, Pause/Resume, and Stop controls. The panel automatically opens toward the available screen space. The `×` button disables X Agent; re-enable it from the extension popup.
13. If `Auto send` is off, the agent inserts a draft and stops so you can review it. If `Auto send` is on, it submits and continues to the next post after a random delay.
14. When the run finishes, AI Helper can play a sound, show a Chrome notification, and open a local report with post links, generated replies, and error statistics.

The agent keeps a local registry of up to 1,000 processed post IDs. A new run skips posts already answered or drafted by AI Helper, posts present in Relationship CRM history, posts visibly liked by you, and posts where X displays `You replied`. If X API is configured, each Start also uses one Recent Search request to sync targets of up to 100 recent replies created outside the current local registry. If every loaded post was handled, it scrolls further before stopping.

Only the latest report is stored in `chrome.storage.local`. It is not uploaded anywhere. You can reopen it with `Open last report` in the popup.

Rate a reply from `1` to `5`, optionally describe how it should be improved, and press `Save feedback`. Unsaved edits are never added to memory. Saved records stay in the browser as JSON, and the configured number of relevant examples is included in future prompts for both ChatGPT and OpenRouter. `Reset memory` deletes all records; `Export feedback` downloads them as JSON.

Each memory record can add roughly `100-400` input tokens per reply. The popup shows an estimate for the selected memory limit. This is local prompt adaptation, not model fine-tuning.

Use auto-send carefully. The safer default is draft-only mode.

### Relationship CRM

Relationship CRM is a separate, explicitly started workflow for authors you choose to track. All CRM data stays in this Chrome profile; no server is required.

1. Hover over the `✦ AI` button under a post and choose `Track @handle`, or open `Relationship CRM` from the popup and add a handle/profile URL manually.
2. Open the local dashboard to review tracked authors, notes, interaction history, follow status, follow-backs, and aggregate public engagement on your replies.
3. Press `Start automatic relationship session`. AI Helper opens the first active author in the local queue and resumes automatically after each X profile navigation.
4. On every profile it reads X's localized `Follows you` badge. Confirmed follow-backs are saved locally and highlighted in green as `Follows you`. They are skipped by default; enable `Reply to authors who follow you` to keep them in Relationship Mode.
5. Otherwise it finds the first recent post not already present in local/API reply history, not visibly liked by you, and not marked by X as `You replied`. It uses the separate `Relationship Mode prompt`, includes the author's recent CRM history, and sends the reply automatically.
6. If `Auto-like in Relationship Mode` is enabled, the agent likes the selected post only after X confirms the reply was sent. It then waits for the configured random delay and opens the next author. Use `End` to stop the relationship session. Following remains manual.
7. `Refresh data` verifies engagement and optional API follow-back data. Profile-page follow-back detection itself does not require X API.
8. Use `Export JSON` and `Import CRM JSON` for backup or transfer. You can also bulk-add handles with `Import handles TXT`, using one handle per line such as `@X`, `@Y`, and `@Z`. Existing authors keep their history and are not duplicated. `Reset CRM` removes every locally stored author and interaction.

Replies generated by the regular X Agent for an already tracked author are added to that author's CRM history automatically. The stored record includes the source post, generated reply, creation/sent dates, posted reply URL when it can be detected, result-check date, aggregate public like/reply counts, and follow-back status. Confirmed aggregate outcomes are included in later AI prompts for that author so the agent can reuse approaches that earned engagement and avoid repetitive replies.

Each sent reply has a `Reply signal score` from 0 to 100. Every public like counts regardless of who left it: the first like gives `+22`, and each additional like gives `+5`, up to `+40`. The first public direct reply gives `+40`, and each additional direct reply gives `+10`, up to `+60`. A continuation you post under somebody else's reply is not part of the direct-reply count of your original reply. Relationship progress uses these aggregate engagement signals and never claims that a particular reply came from the tracked author. These are transparent indicators, not predictions or judgments of writing quality. Without X API, reply scores display `Awaiting API refresh` instead of treating unknown outcomes as zero.

For cross-page updates, expand `X API connection`, enter your own handle and a read-only X API Bearer Token, save it, then press `Refresh data`. Your handle is required because an app-only token does not identify your account; AI Helper uses it to find your published replies, build their links, and read aggregate metrics. The token batch-updates at most 20 due replies per run. New replies are checked hourly, then less often as they age. Own-account lookup and own-post discovery are cached. Optional follow-back scanning is off by default, reads only the first API page of up to 1,000 followers, never reads the full following list, and runs at most once per UTC day. AI Helper does not request the identity of users who liked or replied. X API charges per returned resource and deduplicates the same resource within a UTC day, so review current rates in the [official X API documentation](https://docs.x.com/x-api/getting-started/pricing).

Do not paste API tokens into issues, commits, or public chats.

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
- Перевод отдельного поста X на месте через маленькую кнопку-глобус после имени автора; повторный клик возвращает оригинал.
- Быстрый выбор языка через стрелочку рядом с кнопкой перевода.
- Кнопку перевода можно двигать: тяни за маленькую ручку, двойной клик по ручке сбрасывает позицию.
- Выпадающее меню само открывается вверх, если поле ввода находится снизу экрана.
- Перевод можно включить или выключить в popup-окне расширения.
- Можно включить автоматический перевод всей страницы с верхней панелью, сменой языка, отменой и badge языка на иконке расширения.
- Выделенный текст можно перевести через контекстное меню в отдельной перемещаемой карточке или рядом с оригиналом.
- AI-чат на страницах помечен как beta и по умолчанию выключен.
- X Reply Agent Beta может анализировать посты в X, писать черновики ответов и опционально проходить ленту с заданным лимитом.
- Настройки popup сохраняются автоматически, а секцию X Reply Agent можно свернуть.
- В отчёте X Agent можно оценивать ответы; локальные оценки влияют на следующие ответы через примеры в prompt.
- Светлая и темная тема popup-окна.
- Языки интерфейса: английский, русский, украинский, немецкий, французский, испанский, португальский, турецкий, польский, арабский, китайский и японский.

## Провайдеры перевода

- `OpenRouter Free` - использует free-model route от OpenRouter. OpenRouter API key всё равно нужен, но запросы идут в бесплатные модели.
- `Google Translate` - без ключа, использует публичный endpoint Google Translate.
- `ChatGPT` - использует активную вкладку/сессию ChatGPT.
- `Gemini` - нужен твой Gemini API key. Список моделей загружается через Gemini `ListModels`. Режим `Auto` выбирает самую новую стабильную текстовую Flash-модель и переключается на совместимую Flash-модель, если выбранная модель отключена или временно недоступна. Если Google блокирует `ListModels` из-за неподдерживаемого региона, popup показывает встроенный резервный каталог, но прямые запросы Gemini всё равно недоступны; в этом случае выбери OpenRouter или другого провайдера.
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

### Перевод всей страницы или выделенного текста

1. Открой popup расширения и включи `Translate pages automatically`.
2. Выбери язык страницы. Полный перевод использует Google, чтобы не расходовать AI-токены.
3. Обнови сайт или включи функцию на уже открытой вкладке. Во время перевода справа сверху появится панель управления.
4. На панели можно сменить язык, отменить перевод или свернуть управление. Панель и её компактный значок можно двигать; через пять секунд после успешного перевода панель сворачивается автоматически. На иконке расширения отображается код активного языка.
5. Чтобы перевести только часть страницы, выдели текст, нажми правой кнопкой и выбери `Translate selected text`.
6. Карточку результата можно двигать, вернуть рядом с оригиналом, включить режим `Show original` или озвучить исходный текст и перевод. Переносы строк, отступы, пробелы и эмодзи сохраняются, если выбранный провайдер их поддерживает.

Оригинальный текст для отмены хранится только в памяти текущей страницы. Читаемые текстовые блоки отправляются в Google для перевода, но HTML страницы не загружается. Перевод выделения использует провайдера, выбранного в popup.

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

#### Использование подписки ChatGPT

AI-чат Beta может работать через твою обычную подписку ChatGPT вместо платных API-запросов.

Рекомендуемая настройка:

1. Войди на `https://chatgpt.com/` в том же профиле Chrome, где установлено расширение.
2. Открой обычный чат ChatGPT, чтобы было видно поле ввода сообщения.
3. Открой popup AI Helper.
4. Включи `AI Chat`.
5. Выбери `ChatGPT` как провайдера AI-чата.
6. Выбери способ работы с ChatGPT:
   - Для любого чата открой нужную вкладку ChatGPT и нажми плавающую кнопку `1px Mode` на самой странице. Расширение запомнит именно эту вкладку.
   - Для постоянного чата вставь полную ссылку `https://chatgpt.com/c/...` в поле `Ссылка на чат ChatGPT`, затем нажми `Открыть настроенный чат в режиме 1px`. Следующие запросы будут попадать в этот чат, пока ты не выберешь другую вкладку её кнопкой `1px Mode`.
7. Не закрывай выбранную вкладку ChatGPT. В `1px mode` страница прячется в маленькое вспомогательное окно под основным браузером, а расширение отправляет запросы через твою залогиненную сессию ChatGPT.
8. Вернись на сайт, который хочешь анализировать, и используй плавающую AI-кнопку.

Такой режим удобен, если у тебя уже есть подписка ChatGPT и ты не хочешь тратить платные API-запросы. Он зависит от веб-интерфейса ChatGPT, поэтому если ChatGPT изменит разметку страницы, сначала обнови вкладку ChatGPT и нужный сайт. Если после этого режим не работает, нужно обновить расширение.

### X Reply Agent Beta

X Reply Agent по умолчанию включён. Его можно в любой момент выключить в popup расширения или крестиком на панели агента в X.

Как использовать:

1. Открой popup расширения.
2. Убедись, что `X Reply Agent` включён. В новых установках он включён по умолчанию.
3. Выбери `OpenRouter` или `ChatGPT subscription` в отдельном селекте провайдера агента.
4. Выбери язык ответа в общей настройке исходящего `Translate to`. X Agent всегда использует этот язык, даже если X автоматически перевёл пост.
5. Напиши prompt для агента: тон, длина ответа, эмодзи и чего избегать.
6. Укажи лимит прохода по ленте, например `3` или `10`.
7. Выбери, сколько сохранённых примеров памяти отправлять с каждым запросом. `0` отключает память; большие значения увеличивают расход входных токенов, стоимость и время ответа.
8. Укажи диапазон случайной задержки от `5` до `600` секунд. По умолчанию используется `30-90` секунд.
9. Открой X/Twitter. У постов появится маленькая кнопка `✦ AI` в панели действий.
10. Наведи курсор на `✦ AI`, чтобы включить или выключить `Auto send` без открытия popup.
11. Нажми `✦ AI`, чтобы вручную ответить на конкретный пост. Пост подсветится зелёной рамкой, агент проанализирует его, откроет reply composer и вставит ответ.
12. Анимированный персонаж спит, пока агент бездействует, и копает во время работы. Перетащи персонажа в удобное место экрана. По клику открываются полные настройки агента с автосохранением, крупный таймер и заметные кнопки Start, Pause/Resume и Stop. Панель сама выбирает направление открытия по свободному месту. Крестик `×` отключает X Agent; включить его снова можно в popup расширения.
13. Если `Auto send` выключен, агент вставит один черновик и остановится, чтобы ты проверил ответ. Если `Auto send` включён, он отправит ответ и после случайной задержки пойдёт к следующему посту.
14. После завершения AI Helper может проиграть звук, показать уведомление Chrome и открыть локальный отчёт со ссылками на посты, ответами агента и статистикой ошибок.

Агент локально хранит до 1 000 ID обработанных постов. Новый запуск пропускает посты, для которых AI Helper уже создал ответ или черновик, посты из истории Relationship CRM, видимо лайкнутые вами посты и посты с маркером X `You replied`. Если настроен X API, каждый Start также делает один запрос Recent Search и синхронизирует цели до 100 недавних реплаев, которых ещё нет в локальном реестре. Если все загруженные посты уже обработаны, агент несколько раз прокручивает ленту дальше и только потом останавливается.

В `chrome.storage.local` хранится только последний отчёт, он никуда не отправляется. Повторно открыть его можно кнопкой `Open last report` в popup.

В отчёте можно поставить оценку от `1` до `5`, описать желаемое улучшение и нажать `Save feedback`. Несохранённые изменения в память не попадают. Сохранённые записи остаются локально в JSON, а выбранное количество релевантных примеров добавляется в следующие запросы ChatGPT и OpenRouter. `Reset memory` удаляет память, `Export feedback` выгружает её в JSON.

Одна запись памяти может добавлять примерно `100-400` входных токенов к каждому ответу. Popup показывает приблизительный расход для выбранного лимита. Это локальная адаптация через контекст, а не настоящее дообучение модели.

Авто-отправку лучше использовать аккуратно. Более безопасный режим по умолчанию — только черновик.

### Relationship CRM

Relationship CRM — отдельный режим для работы только с теми авторами, которых пользователь сам добавил. Все данные хранятся локально в текущем профиле Chrome, сервер не требуется.

1. Наведи курсор на `✦ AI` под постом и нажми `Track @handle` либо открой `Relationship CRM` из popup и вручную добавь username или ссылку на профиль.
2. В локальном dashboard видны авторы, заметки, история контактов, статус подписки, follow-back и общая публичная активность под вашими ответами.
3. Нажми `Start automatic relationship session`. AI Helper откроет первого активного автора из локальной очереди и автоматически продолжит работу после каждого перехода между профилями X.
4. На каждом профиле расширение проверяет локализованную метку X `Follows you / Читает вас`. Подтверждённый follow-back сохраняется локально и подсвечивается зелёным статусом `Follows you`. По умолчанию такой автор пропускается; включи `Reply to authors who follow you`, чтобы продолжать отвечать ему в Relationship Mode.
5. Иначе агент найдёт первый свежий пост, которого нет в локальной/API-истории ответов, который не отмечен вашим лайком и для которого X не показывает `You replied`. Для ответа используется отдельный `Relationship Mode prompt` и локальная история автора, а reply отправляется автоматически.
6. Если включён `Auto-like in Relationship Mode`, агент ставит лайк выбранному посту только после того, как X подтвердил отправку ответа. Затем он выдерживает случайную задержку и открывает следующего автора. Кнопка `End` останавливает сессию. Подписка остаётся ручным действием.
7. `Refresh data` проверяет engagement и опциональные API-данные follow-back. Определение follow-back непосредственно на странице профиля не требует X API.
8. `Export JSON` и `Import CRM JSON` позволяют сделать резервную копию. Через `Import handles TXT` можно массово добавить авторов из обычного TXT-файла: по одному username на строку, например `@X`, `@Y`, `@Z`. Существующие авторы не дублируются и сохраняют историю. `Reset CRM` удаляет всю локальную историю авторов.

Если обычный X Agent отвечает автору, который уже добавлен в CRM, взаимодействие сохраняется автоматически. Запоминаются исходный пост, наш ответ, даты создания и отправки, ссылка на опубликованный ответ (если её удалось определить), дата проверки результата, общие счётчики лайков и ответов и follow-back. Подтверждённые общие результаты передаются AI при следующих ответах этому автору, чтобы учитывать удачные подходы и меньше повторяться.

У каждого отправленного ответа есть `Reply signal score` от 0 до 100. Учитывается каждый публичный лайк независимо от автора: первый лайк даёт `+22`, каждый следующий — `+5`, максимум `+40`. Первый публичный прямой ответ даёт `+40`, каждый следующий — `+10`, максимум `+60`. Продолжение, которое вы оставили под чужим ответом, не входит в счётчик прямых ответов на ваш исходный реплай. `Relationship progress` использует только эти общие engagement-сигналы и не утверждает, что конкретный ответ оставил отслеживаемый автор. Это прозрачные индикаторы, а не прогноз или оценка качества текста. Без X API шкала ответа показывает `Awaiting API refresh`, а неизвестные результаты не считаются нулевыми.

Для обновления между страницами раскрой `X API connection`, укажи свой X handle и read-only X API Bearer Token, сохрани настройки и нажми `Refresh data`. Handle нужен потому, что app-only token не сообщает, какой аккаунт ваш: расширение использует handle для поиска опубликованных вами реплаев, построения ссылок и чтения общих метрик. За один запуск обновляется не более 20 ответов, для которых наступило время проверки. Новые ответы проверяются каждый час, затем реже по мере их старения. Определение собственного аккаунта и поиск своих реплаев кэшируются. Опциональная проверка follow-back по умолчанию выключена, читает только первую страницу до 1 000 подписчиков, не загружает полный список ваших подписок и выполняется не чаще одного раза за UTC-день. AI Helper не запрашивает личности пользователей, поставивших лайк или оставивших ответ. Токен хранится только в `chrome.storage.local`, не показывается обратно странице и не попадает в JSON-экспорт CRM. X API тарифицирует возвращённые ресурсы и не считает повторно один и тот же ресурс в течение UTC-дня, поэтому актуальную стоимость нужно смотреть в [официальной документации X API](https://docs.x.com/x-api/getting-started/pricing).

Не отправляй токен в issues, коммиты или публичные чаты.

## Важно для публичной сборки

Публичный исходный код расширения не содержит общий API-ключ. `OpenRouter Free` использует OpenRouter API key пользователя и отправляет запросы в бесплатные модели.

Не добавляй платные API-ключи в публичный исходный код расширения.
