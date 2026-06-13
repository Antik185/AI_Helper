/*
 * Native helper для DiscordTranslateHelper.
 *
 * Vencord автоматически подхватывает файл с именем native.ts в папке плагина
 * и делает экспортированные функции доступными из renderer-процесса через
 * VencordNative.pluginHelpers.DiscordTranslateHelper.xxx
 *
 * Эти функции выполняются в Electron main-процессе, где нет CORS-ограничений —
 * именно сюда вынесены все запросы к API переводчиков.
 */

import type { IpcMainInvokeEvent } from "electron";

interface NativeFetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
}

interface NativeFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

export async function fetch(
    _event: IpcMainInvokeEvent,
    url: string,
    init?: NativeFetchInit
): Promise<NativeFetchResponse> {
    const res = await globalThis.fetch(url, init);
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers,
        body
    };
}
