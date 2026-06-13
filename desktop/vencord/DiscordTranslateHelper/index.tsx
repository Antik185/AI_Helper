/*
 * DiscordTranslateHelper - Vencord userplugin
 *
 * Translates Discord messages and translates your own text before sending.
 * Drop this folder into Vencord's src/userplugins/ and run `pnpm build`.
 */

import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, useState } from "@webpack/common";

// Мост к native-helper'у. Vencord автоматически экспортирует функции из native.ts
// сюда. Использовать обычный fetch нельзя — Discord-renderer блокирует cross-origin.
declare const VencordNative: {
    pluginHelpers: {
        DiscordTranslateHelper: {
            fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; }): Promise<{
                ok: boolean;
                status: number;
                statusText: string;
                headers: Record<string, string>;
                body: string;
            }>;
        };
    };
};

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
    // Сериализуем body и headers — IPC принимает только сериализуемые объекты.
    let body: string | undefined;
    if (init?.body) {
        if (typeof init.body === "string") body = init.body;
        else if (init.body instanceof URLSearchParams) body = init.body.toString();
        else body = String(init.body);
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
        if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(init.headers)) {
            for (const [k, v] of init.headers) headers[k] = v;
        } else {
            Object.assign(headers, init.headers as Record<string, string>);
        }
    }
    const helper = (window as any).VencordNative?.pluginHelpers?.DiscordTranslateHelper;
    if (!helper?.fetch) {
        // Фолбэк на обычный fetch — если native helper не подгрузился.
        // Скорее всего упадёт по CORS, но даём шанс.
        return globalThis.fetch(url, init);
    }
    const r = await helper.fetch(url, { method: init?.method, headers, body });
    return new Response(r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers
    });
}

// ============================================================
// Constants — mirror background.js from the browser extension
// ============================================================

const LANG_NAMES: Record<string, string> = {
    ru: "Russian", en: "English", uk: "Ukrainian", kk: "Kazakh",
    be: "Belarusian", de: "German", fr: "French", es: "Spanish",
    pt: "Portuguese", tr: "Turkish", ja: "Japanese", zh: "Chinese",
    ar: "Arabic", pl: "Polish"
};

const LANG_LABELS: Record<string, string> = {
    uk: "UA", be: "BY", kk: "KZ", ja: "JP", zh: "CN"
};

const ALLOWED_OPENROUTER_MODELS = [
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite"
];

// Shared default key. TODO: route through our own proxy with quota.
const DEFAULT_OPENROUTER_KEY = "";

const TEXTBOX_SELECTORS = [
    'div[role="textbox"][data-slate-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-slate-node="value"]'
];

// ============================================================
// Settings
// ============================================================

const langSelectOptions = (withAuto: boolean, defaultCode: string) => {
    const opts: any[] = [];
    if (withAuto) opts.push({ label: "Auto", value: "auto" });
    for (const code of Object.keys(LANG_NAMES)) {
        const display = LANG_LABELS[code] || code.toUpperCase();
        opts.push({
            label: `${LANG_NAMES[code]} (${display})`,
            value: code,
            ...(code === defaultCode ? { default: true } : {})
        });
    }
    return opts;
};

const settings = definePluginSettings({
    provider: {
        type: OptionType.SELECT,
        description: "Translation provider",
        options: [
            { label: "Google Translate (free, no key)", value: "google", default: true },
            { label: "Google Gemini AI (needs API key)", value: "gemini" },
            { label: "OpenRouter (default key built-in)", value: "openrouter" },
            { label: "MyMemory (free, limited)", value: "mymemory" },
            { label: "DeepL (needs API key)", value: "deepl" },
            { label: "LibreTranslate", value: "libre" }
        ]
    },
    targetLang: {
        type: OptionType.SELECT,
        description: "Translate incoming messages to",
        options: langSelectOptions(false, "ru")
    },
    outboundSourceLang: {
        type: OptionType.SELECT,
        description: "Outgoing translation — from",
        options: langSelectOptions(true, "ru")
    },
    outboundTargetLang: {
        type: OptionType.SELECT,
        description: "Outgoing translation — to",
        options: langSelectOptions(false, "en")
    },
    geminiKey: {
        type: OptionType.STRING,
        description: "Gemini API key",
        default: "",
        disabled() { return settings.store.provider !== "gemini"; }
    },
    geminiModel: {
        type: OptionType.STRING,
        description: "Gemini model",
        default: "gemini-2.0-flash",
        disabled() { return settings.store.provider !== "gemini"; }
    },
    openrouterKey: {
        type: OptionType.STRING,
        description: "OpenRouter API key",
        default: "",
        disabled() { return settings.store.provider !== "openrouter"; }
    },
    openrouterModel: {
        type: OptionType.SELECT,
        description: "OpenRouter model",
        options: [
            { label: "Gemini 2.5 Flash", value: "google/gemini-2.5-flash", default: true },
            { label: "Gemini 2.5 Flash Lite", value: "google/gemini-2.5-flash-lite" }
        ],
        disabled() { return settings.store.provider !== "openrouter"; }
    },
    deeplKey: {
        type: OptionType.STRING,
        description: "DeepL API key",
        default: "",
        disabled() { return settings.store.provider !== "deepl"; }
    },
    libreUrl: {
        type: OptionType.STRING,
        description: "LibreTranslate URL",
        default: "https://libretranslate.de",
        disabled() { return settings.store.provider !== "libre"; }
    },
    libreKey: {
        type: OptionType.STRING,
        description: "LibreTranslate API key (optional)",
        default: "",
        disabled() { return settings.store.provider !== "libre"; }
    },
    myMemoryEmail: {
        type: OptionType.STRING,
        description: "MyMemory email (raises daily limit)",
        default: "",
        disabled() { return settings.store.provider !== "mymemory"; }
    }
});

// ============================================================
// Translators
// ============================================================

type TranslateResult = { translated: string; detected: string; };

async function translateGoogle(text: string, targetLang: string, sourceLang = "auto"): Promise<TranslateResult> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await httpFetch(url);
    if (!res.ok) throw new Error(`Google: HTTP ${res.status}`);
    const data = await res.json();
    const translated = (data[0] || []).map((seg: any) => seg[0]).join("");
    return { translated, detected: data[2] || sourceLang };
}

async function translateMyMemory(text: string, targetLang: string, sourceLang: string, email: string): Promise<TranslateResult> {
    const sl = sourceLang === "auto" ? "autodetect" : sourceLang;
    const params = new URLSearchParams({ q: text, langpair: `${sl}|${targetLang}` });
    if (email) params.set("de", email);
    const res = await httpFetch(`https://api.mymemory.translated.net/get?${params.toString()}`);
    if (!res.ok) throw new Error(`MyMemory: HTTP ${res.status}`);
    const data = await res.json();
    if (!data.responseData) throw new Error("MyMemory: empty");
    return {
        translated: data.responseData.translatedText,
        detected: data.responseData.detectedLanguage || sourceLang
    };
}

async function translateDeepL(text: string, targetLang: string, sourceLang: string, apiKey: string): Promise<TranslateResult> {
    if (!apiKey) throw new Error("DeepL: API key required");
    const isFree = apiKey.endsWith(":fx");
    const host = isFree ? "api-free.deepl.com" : "api.deepl.com";
    const body = new URLSearchParams({ text, target_lang: targetLang.toUpperCase() });
    if (sourceLang && sourceLang !== "auto") body.set("source_lang", sourceLang.toUpperCase());
    const res = await httpFetch(`https://${host}/v2/translate`, {
        method: "POST",
        headers: {
            "Authorization": `DeepL-Auth-Key ${apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
    });
    if (!res.ok) throw new Error(`DeepL: HTTP ${res.status}`);
    const data = await res.json();
    const item = data.translations?.[0];
    if (!item) throw new Error("DeepL: empty");
    return {
        translated: item.text,
        detected: (item.detected_source_language || sourceLang || "").toLowerCase()
    };
}

async function translateLibre(text: string, targetLang: string, sourceLang: string, baseUrl: string, apiKey: string): Promise<TranslateResult> {
    const url = `${baseUrl.replace(/\/$/, "")}/translate`;
    const payload: any = { q: text, source: sourceLang || "auto", target: targetLang, format: "text" };
    if (apiKey) payload.api_key = apiKey;
    const res = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`LibreTranslate: HTTP ${res.status}`);
    const data = await res.json();
    return {
        translated: data.translatedText,
        detected: data.detectedLanguage?.language || sourceLang || "auto"
    };
}

async function translateGemini(text: string, targetLang: string, sourceLang: string, apiKey: string, model: string): Promise<TranslateResult> {
    if (!apiKey) throw new Error("Gemini: API key required");
    const m = model.trim() || "gemini-2.0-flash";
    const targetName = LANG_NAMES[targetLang.toLowerCase()] || targetLang;
    const srcName = sourceLang && sourceLang !== "auto"
        ? (LANG_NAMES[sourceLang.toLowerCase()] || sourceLang)
        : null;
    const direction = srcName
        ? `Translate from ${srcName} to ${targetName}.`
        : `Translate the text to ${targetName} (auto-detect the source language).`;
    const sys = [
        "You translate Discord chat messages.",
        direction,
        "Output ONLY the translation. No explanations, no quotes around the result.",
        "Preserve emojis, @mentions, #channels, URLs, code blocks unchanged.",
        `If the text is already in ${targetName}, output it unchanged.`
    ].join(" ");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    });
    let res!: Response;
    for (let i = 0; i < 3; i++) {
        res = await httpFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (res.status !== 429) break;
        if (i === 2) break;
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
    if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        if (res.status === 429) throw new Error("Gemini: rate limit, try gemini-2.0-flash-lite");
        throw new Error(`Gemini: HTTP ${res.status} ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!translated) throw new Error("Gemini: empty response");
    return { translated, detected: sourceLang || "auto" };
}

async function translateOpenRouter(text: string, targetLang: string, sourceLang: string, apiKey: string, model: string): Promise<TranslateResult> {
    const key = (apiKey && apiKey.trim()) || DEFAULT_OPENROUTER_KEY;
    if (!key) throw new Error("OpenRouter: add an API key in settings");
    const m = ALLOWED_OPENROUTER_MODELS.includes(model) ? model : ALLOWED_OPENROUTER_MODELS[0];
    const targetName = LANG_NAMES[targetLang.toLowerCase()] || targetLang;
    const srcName = sourceLang && sourceLang !== "auto"
        ? (LANG_NAMES[sourceLang.toLowerCase()] || sourceLang)
        : null;
    const direction = srcName
        ? `Translate from ${srcName} to ${targetName}.`
        : `Translate the text to ${targetName} (auto-detect the source language).`;
    const sys = [
        "You translate Discord chat messages.",
        direction,
        "Output ONLY the translation. No explanations, no quotes around the result.",
        "Preserve emojis, @mentions, #channels, URLs, code blocks unchanged.",
        `If the text is already in ${targetName}, output it unchanged.`
    ].join(" ");
    const body = JSON.stringify({
        model: m,
        messages: [
            { role: "system", content: sys },
            { role: "user", content: text }
        ],
        temperature: 0.2,
        max_tokens: 2048
    });
    let res!: Response;
    for (let i = 0; i < 3; i++) {
        res = await httpFetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://discord.com",
                "X-Title": "Discord Translate Helper"
            },
            body
        });
        if (res.status !== 429) break;
        if (i === 2) break;
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
    if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        if (res.status === 429) throw new Error("OpenRouter: rate limit, wait a minute");
        if (res.status === 401) throw new Error("OpenRouter: invalid API key");
        if (res.status === 402) throw new Error("OpenRouter: out of credits");
        throw new Error(`OpenRouter: HTTP ${res.status} ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const translated = data?.choices?.[0]?.message?.content?.trim();
    if (!translated) throw new Error("OpenRouter: empty response");
    return { translated, detected: sourceLang || "auto" };
}

async function translate(text: string, targetLang: string, sourceLang = "auto"): Promise<TranslateResult> {
    if (!text?.trim()) return { translated: "", detected: sourceLang };
    const s = settings.store;
    switch (s.provider) {
        case "google":     return translateGoogle(text, targetLang, sourceLang);
        case "gemini":     return translateGemini(text, targetLang, sourceLang, s.geminiKey, s.geminiModel);
        case "openrouter": return translateOpenRouter(text, targetLang, sourceLang, s.openrouterKey, s.openrouterModel);
        case "mymemory":   return translateMyMemory(text, targetLang, sourceLang, s.myMemoryEmail);
        case "deepl":      return translateDeepL(text, targetLang, sourceLang, s.deeplKey);
        case "libre":      return translateLibre(text, targetLang, sourceLang, s.libreUrl, s.libreKey);
        default:           return translateGoogle(text, targetLang, sourceLang);
    }
}

// ============================================================
// DOM helpers — for the floating input-translate button
// ============================================================

function findEditor(): HTMLElement | null {
    for (const sel of TEXTBOX_SELECTORS) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) return el;
    }
    return null;
}

const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

async function replaceEditorText(editor: HTMLElement, newText: string): Promise<void> {
    editor.focus();
    await nextFrame();
    let selected = false;
    try { selected = document.execCommand("selectAll", false); } catch { selected = false; }
    if (!selected || (window.getSelection()?.toString().length ?? 0) === 0) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
    }
    await nextFrame();
    await nextFrame();
    const dt = new DataTransfer();
    dt.setData("text/plain", newText);
    editor.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
    }));
}

function langLabel(code: string): string {
    if (!code) return "";
    const lc = code.toLowerCase();
    return LANG_LABELS[lc] || lc.toUpperCase();
}

// ============================================================
// Floating input button + arrow dropdown (DOM, position: fixed)
// ============================================================

let inputWrap: HTMLDivElement | null = null;
let inputMainBtn: HTMLButtonElement | null = null;
let inputArrowBtn: HTMLButtonElement | null = null;
let langDropdown: HTMLDivElement | null = null;
let mutationObs: MutationObserver | null = null;
let onResize: (() => void) | null = null;
let onScroll: ((e: Event) => void) | null = null;
let onInputEvt: ((e: Event) => void) | null = null;
let onDocClick: ((e: Event) => void) | null = null;

function positionInputButton() {
    if (!inputWrap) return;
    const editor = findEditor();
    const hasText = !!editor && (editor.textContent || "").trim().length > 0;
    inputWrap.classList.toggle("dth-visible", hasText);
    if (!editor) return;
    const rect = editor.getBoundingClientRect();
    inputWrap.style.left = "auto";
    inputWrap.style.right = Math.max(8, window.innerWidth - rect.right) + "px";
    inputWrap.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + "px";
    inputWrap.style.top = "auto";
}

function refreshInputButtonLabel() {
    if (!inputMainBtn) return;
    if (inputMainBtn.dataset.loading !== "1") {
        inputMainBtn.textContent = `🌐→${langLabel(settings.store.outboundTargetLang || "en")}`;
    }
}

async function runOutboundTranslate(targetLang?: string) {
    const ed = findEditor();
    if (!ed || !inputMainBtn) return;
    const text = (ed.textContent || "").trim();
    if (!text) return;
    inputMainBtn.disabled = true;
    inputMainBtn.dataset.loading = "1";
    inputMainBtn.textContent = "⏳";
    try {
        const { translated } = await translate(
            text,
            targetLang || settings.store.outboundTargetLang || "en",
            settings.store.outboundSourceLang || "auto"
        );
        await replaceEditorText(ed, translated);
    } catch (err: any) {
        console.error("[DTH] translate input error:", err);
        inputMainBtn.title = "Error: " + err.message;
    } finally {
        inputMainBtn.disabled = false;
        inputMainBtn.dataset.loading = "0";
        refreshInputButtonLabel();
    }
}

function populateLangDropdown() {
    if (!langDropdown) return;
    langDropdown.innerHTML = "";
    for (const code of Object.keys(LANG_NAMES)) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "dth-lang-item";

        const codeEl = document.createElement("span");
        codeEl.className = "dth-lang-code";
        codeEl.textContent = LANG_LABELS[code] || code.toUpperCase();

        const nameEl = document.createElement("span");
        nameEl.className = "dth-lang-name";
        nameEl.textContent = LANG_NAMES[code];

        item.appendChild(codeEl);
        item.appendChild(nameEl);

        // Не отбирать фокус у редактора
        item.addEventListener("mousedown", e => e.preventDefault());
        item.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            langDropdown?.classList.remove("dth-open");
            // Сохраняем выбранный язык в настройки + сразу переводим
            settings.store.outboundTargetLang = code;
            refreshInputButtonLabel();
            await runOutboundTranslate(code);
        });
        langDropdown.appendChild(item);
    }
}

function setupInputButton() {
    if (inputWrap) return;

    const wrap = document.createElement("div");
    wrap.className = "dth-input-wrap";

    const mainBtn = document.createElement("button");
    mainBtn.className = "dth-input-btn";
    mainBtn.type = "button";
    mainBtn.title = "Translate what I typed";
    mainBtn.textContent = `🌐→${langLabel(settings.store.outboundTargetLang || "en")}`;
    mainBtn.addEventListener("mousedown", e => e.preventDefault());
    mainBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await runOutboundTranslate();
    });

    const arrowBtn = document.createElement("button");
    arrowBtn.className = "dth-input-arrow";
    arrowBtn.type = "button";
    arrowBtn.title = "Choose language";
    arrowBtn.textContent = "▾";
    arrowBtn.addEventListener("mousedown", e => e.preventDefault());
    arrowBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        langDropdown?.classList.toggle("dth-open");
    });

    const dropdown = document.createElement("div");
    dropdown.className = "dth-lang-dropdown";

    wrap.appendChild(mainBtn);
    wrap.appendChild(arrowBtn);
    wrap.appendChild(dropdown);
    document.body.appendChild(wrap);

    inputWrap = wrap;
    inputMainBtn = mainBtn;
    inputArrowBtn = arrowBtn;
    langDropdown = dropdown;

    populateLangDropdown();

    onResize = () => positionInputButton();
    onScroll = () => positionInputButton();
    onInputEvt = (e: Event) => {
        const t = e.target as HTMLElement | null;
        if (t && t.matches && t.matches(TEXTBOX_SELECTORS.join(","))) {
            positionInputButton();
        }
    };
    onDocClick = (e: Event) => {
        // Закрываем выпадашку при клике вне неё
        if (langDropdown?.classList.contains("dth-open") &&
            !inputWrap?.contains(e.target as Node)) {
            langDropdown.classList.remove("dth-open");
        }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("input", onInputEvt, true);
    document.addEventListener("keyup", onInputEvt, true);
    document.addEventListener("click", onDocClick, true);

    mutationObs = new MutationObserver(() => positionInputButton());
    mutationObs.observe(document.body, { childList: true, subtree: true });

    positionInputButton();
}

function teardownInputButton() {
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
    if (onScroll) { window.removeEventListener("scroll", onScroll, true); onScroll = null; }
    if (onInputEvt) {
        document.removeEventListener("input", onInputEvt, true);
        document.removeEventListener("keyup", onInputEvt, true);
        onInputEvt = null;
    }
    if (onDocClick) {
        document.removeEventListener("click", onDocClick, true);
        onDocClick = null;
    }
    if (inputWrap) { inputWrap.remove(); inputWrap = null; }
    inputMainBtn = null;
    inputArrowBtn = null;
    langDropdown = null;
}

// ============================================================
// React accessory — translate button under each message
// ============================================================

interface AccessoryProps {
    message: { id: string; content: string;[k: string]: any; };
}

function TranslateAccessory({ message }: AccessoryProps) {
    const [translation, setTranslation] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [detected, setDetected] = useState("");

    if (!message?.content?.trim()) return null;

    const onClick = async () => {
        if (loading) return;
        if (translation !== null || error !== null) {
            setTranslation(null);
            setError(null);
            return;
        }
        setLoading(true);
        try {
            const res = await translate(message.content, settings.store.targetLang);
            setTranslation(res.translated);
            setDetected(res.detected);
        } catch (e: any) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    };

    const btnLabel = loading
        ? "⏳ Translating…"
        : error ? "🌐 Retry"
            : translation ? "🌐 Hide"
                : "🌐 Translate";

    return (
        <div className="dth-container">
            <button className="dth-translate-btn" onClick={onClick}>{btnLabel}</button>
            {translation && (
                <div className="dth-translation">
                    <span className="dth-lang">
                        ({detected || "??"} → {settings.store.targetLang})
                    </span>
                    <br />
                    <span>{translation}</span>
                </div>
            )}
            {error && (
                <div className="dth-translation" style={{ borderLeftColor: "#ed4245" }}>
                    Error: {error}
                </div>
            )}
        </div>
    );
}

// ============================================================
// CSS
// ============================================================

const STYLES = `
.dth-container { margin-top: 4px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.dth-translate-btn {
    align-self: flex-start;
    background: transparent;
    color: var(--text-muted, #b5bac1);
    border: 1px solid var(--background-modifier-accent, #3f4147);
    border-radius: 6px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 11px;
    line-height: 1.4;
    transition: background-color 0.1s, color 0.1s;
}
.dth-translate-btn:hover {
    background: var(--background-modifier-hover, rgba(78, 80, 88, 0.4));
    color: var(--interactive-active, #f2f3f5);
}
.dth-translation {
    padding: 6px 10px;
    border-left: 3px solid var(--brand-experiment, #5865f2);
    background: var(--background-secondary, rgba(0, 0, 0, 0.2));
    border-radius: 0 6px 6px 0;
    color: var(--text-normal, #dbdee1);
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-wrap: break-word;
}
.dth-lang { color: var(--text-muted, #949ba4); font-size: 11px; margin-right: 6px; }
/* Обёртка с кнопкой + стрелкой */
.dth-input-wrap {
    position: fixed;
    z-index: 9999;
    display: flex;
    align-items: stretch;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    border-radius: 999px;
    opacity: 0;
    pointer-events: none;
    transform: translateY(6px) scale(0.96);
    transition: opacity 0.18s, transform 0.18s;
}
.dth-input-wrap.dth-visible {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scale(1);
}
.dth-input-btn {
    background: var(--brand-experiment, #5865f2);
    color: #fff;
    border: none;
    border-radius: 999px 0 0 999px;
    padding: 5px 12px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.1s, filter 0.1s;
}
.dth-input-btn:hover:not(:disabled) { filter: brightness(1.08); }
.dth-input-arrow {
    background: var(--brand-experiment, #5865f2);
    color: #fff;
    border: none;
    border-left: 1px solid rgba(0,0,0,0.18);
    border-radius: 0 999px 999px 0;
    padding: 5px 8px 5px 6px;
    font-size: 10px;
    cursor: pointer;
    transition: filter 0.1s;
}
.dth-input-arrow:hover { filter: brightness(1.08); }
/* Выпадашка языков */
.dth-lang-dropdown {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    background: var(--background-floating, #18191c);
    border: 1px solid var(--background-tertiary, #2b2d31);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    max-height: 280px;
    overflow-y: auto;
    min-width: 200px;
    padding: 4px;
    display: none;
}
.dth-lang-dropdown.dth-open { display: block; }
.dth-lang-item {
    display: flex;
    align-items: center;
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text-normal, #dbdee1);
    border: none;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
}
.dth-lang-item:hover {
    background: var(--background-modifier-hover, rgba(78,80,88,0.4));
}
.dth-lang-code {
    font-weight: 700;
    color: var(--text-normal, #f2f3f5);
    margin-right: 10px;
    min-width: 26px;
    display: inline-block;
}
.dth-lang-name {
    color: var(--text-muted, #949ba4);
}
`;

const STYLE_ID = "DiscordTranslateHelper-styles";

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = STYLES;
    document.head.appendChild(tag);
}

function removeStyles() {
    document.getElementById(STYLE_ID)?.remove();
}

// ============================================================
// Plugin
// ============================================================

export default definePlugin({
    name: "DiscordTranslateHelper",
    description:
        "Translates Discord messages and translates your own text before sending. " +
        "Free Google Translate plus optional Gemini, OpenRouter, DeepL, MyMemory, LibreTranslate. " +
        "Default OpenRouter key built in.",
    authors: [
        { name: "DTH", id: 0n }
    ],
    settings,

    start() {
        try {
            injectStyles();
            addMessageAccessory("DiscordTranslateHelper", (props: any) => (
                <TranslateAccessory message={props.message} />
            ));
            setupInputButton();
            console.log("[DiscordTranslateHelper] started");
        } catch (e) {
            console.error("[DiscordTranslateHelper] start failed:", e);
        }
    },

    stop() {
        try {
            removeMessageAccessory("DiscordTranslateHelper");
            teardownInputButton();
            removeStyles();
            console.log("[DiscordTranslateHelper] stopped");
        } catch (e) {
            console.error("[DiscordTranslateHelper] stop failed:", e);
        }
    }
});
