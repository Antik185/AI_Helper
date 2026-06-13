# Discord Translate Helper — Vencord-плагин

Userplugin для [Vencord](https://vencord.dev/). Тот же функционал, что у браузерного расширения и BetterDiscord-плагина, но интегрирован в React-дерево Discord нативно через Vencord API.

## Что внутри
- Кнопка **🌐 Translate** под каждым сообщением (через `addAccessory`)
- Кнопка-глобус в **chat bar** рядом с эмодзи (через `addChatBarButton`) — переводит твой текст перед отправкой
- Настройки в родной панели Vencord — провайдер, языки, ключи
- 6 провайдеров: Google, Gemini, OpenRouter, MyMemory, DeepL, LibreTranslate
- Дефолтный OpenRouter-ключ встроен (можно сразу пользоваться без регистрации)

## Установка

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
            └── index.tsx     ← наш файл
```

Путь к нашему файлу: [`DiscordTranslateHelper/index.tsx`](DiscordTranslateHelper/index.tsx)

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
4. Выбери провайдера (рекомендую **OpenRouter** — будет работать с дефолтным ключом сразу).
5. Настрой языки.

Зайди в любой чат — у сообщений появится «🌐 Translate», справа от инпута появится кнопка-глобус.

## Обновление

Когда выйдет новая версия плагина:
1. Замени файл `Vencord/src/userplugins/DiscordTranslateHelper/index.tsx`
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
| Инжект | MutationObserver по DOM | нативный Vencord API (`addAccessory`, `addChatBarButton`) |
| Кнопка ввода | плавающая, position: fixed | в chat bar рядом с эмодзи |
| Стиль кнопок | повторяет Discord-классы | повторяет Discord-классы |
| Производительность | чуть тяжелее (MutationObserver) | чуть легче (React-интеграция) |

Функционально — одинаково.
