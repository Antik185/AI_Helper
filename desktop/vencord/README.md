# Discord Translate Helper — Vencord-плагин

Userplugin для [Vencord](https://vencord.dev/). Тот же функционал, что у браузерного расширения и BetterDiscord-плагина, но интегрирован в React-дерево Discord нативно через Vencord API.

## Что внутри
- Кнопка **🌐 Translate** под каждым сообщением
- Кнопка-глобус рядом с полем ввода — переводит твой текст перед отправкой
- Настройки в родной панели Vencord — провайдер, языки, ключи
- Провайдеры: Google, Gemini, OpenRouter, MyMemory, DeepL, LibreTranslate
- Для первого теста лучше использовать Google Translate, он работает без API-ключа

## Быстрая установка через installer

Для Windows есть готовый установочный скрипт:

```powershell
cd E:\discordHelper\desktop\vencord
.\install-discord-translate-helper.ps1
```

Или можно запустить двойным кликом:

```text
install-discord-translate-helper.cmd
```

Что делает installer:

1. Проверяет `git`, `node`, `npm`, `pnpm`.
2. Если `pnpm` не установлен — ставит его через `npm`.
3. Клонирует Vencord в `E:\Vencord`, если его ещё нет.
4. Если Vencord уже есть — обновляет его через `git pull --ff-only`.
5. Копирует `DiscordTranslateHelper` в `E:\Vencord\src\userplugins\`.
6. Запускает `pnpm install`.
7. Собирает Vencord через `pnpm build`.
8. Запускает `pnpm inject`, чтобы установить Vencord в Discord.

Обычно выбирай **Discord Stable**, если installer Vencord спросит, куда ставить.

После установки:

1. Перезапусти Discord.
2. Открой **User Settings → Vencord → Plugins**.
3. Найди `DiscordTranslateHelper`.
4. Включи плагин.
5. Для первого теста выбери провайдер **Google Translate**, он работает без API-ключа.

Параметры installer:

```powershell
.\install-discord-translate-helper.ps1 -Discord stable
.\install-discord-translate-helper.ps1 -Discord canary
.\install-discord-translate-helper.ps1 -VencordDir D:\Vencord
.\install-discord-translate-helper.ps1 -NoUpdate
.\install-discord-translate-helper.ps1 -SkipInject
```

## Ручная установка

Userplugins в Vencord требуют сборки из исходников. Без обходных путей — это сознательное решение разработчиков, чтобы не разрешать загрузку произвольного кода в один клик.

### Что понадобится

- [Git](https://git-scm.com/downloads)
- [Node.js](https://nodejs.org/) (LTS, 20+)
- pnpm: `npm i -g pnpm`

### Шаг 1 — клонировать Vencord

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install
```

### Шаг 2 — положить наш плагин

В папке `Vencord/src/` создай `userplugins/` (если её нет), и скопируй туда папку `DiscordTranslateHelper` из этого репо:

```
Vencord/
└── src/
    └── userplugins/
        └── DiscordTranslateHelper/
            ├── index.tsx
            └── native.ts
```

Путь к папке плагина: [`DiscordTranslateHelper/`](DiscordTranslateHelper/)

### Шаг 3 — собрать и поставить

В папке Vencord выполни:

```bash
pnpm build
pnpm inject
```

`pnpm inject` запустит интерактивный установщик. Выбери свою установку Discord (обычно Discord Stable) → Install.

Перезапусти Discord.

### Шаг 4 — включить плагин

1. В Discord: **Settings → Vencord → Plugins**.
2. Найди `DiscordTranslateHelper` в списке, включи тумблер.
3. Нажми ⚙ Settings рядом с ним.
4. Выбери провайдера. Для первого теста рекомендую **Google Translate**, он работает без ключа.
5. Настрой языки.

Зайди в любой чат — у сообщений появится «🌐 Translate», справа от инпута появится кнопка-глобус.

## Обновление

Когда выйдет новая версия плагина:
1. Замени папку `Vencord/src/userplugins/DiscordTranslateHelper`
2. `pnpm build`
3. Перезапусти Discord (Ctrl+R или закрой/открой)

`pnpm inject` повторно делать не надо — Vencord уже установлен.

## Когда Vencord обновляется

Внутри своей папки Vencord:
```bash
git pull
pnpm install
pnpm build
```
Discord перезапустить. Наш плагин останется в userplugins и переберётся вместе со всем остальным.

## Удаление

В папке Vencord:
```bash
pnpm uninject
```

И/или удали папку `src/userplugins/DiscordTranslateHelper`.

## Про баны

Vencord, как и BetterDiscord, формально нарушает Discord ToS. Но Vencord:
- активнее обходит детект (использует injectionless подход через установщик),
- не патчит сетевой стек,
- сообщество массивное, баны исчезающе редки.

Наш плагин из «безопасной» категории — только UI-изменения, никакой автоматизации, никаких запросов к Discord API.

## Отличия от BetterDiscord-версии

| | BD-плагин | Vencord-плагин |
|---|---|---|
| Установка | один .plugin.js файл | сборка из исходников |
| Инжект | MutationObserver по DOM | Vencord API + native helper для fetch |
| Кнопка ввода | плавающая, position: fixed | плавающая, position: fixed |
| Стиль кнопок | повторяет Discord-классы | повторяет Discord-классы |
| Производительность | чуть тяжелее (MutationObserver) | чуть легче (React-интеграция) |

Функционально — одинаково.
