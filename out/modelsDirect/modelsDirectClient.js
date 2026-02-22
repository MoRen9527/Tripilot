"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelsDirectClient = void 0;
const crypto = __importStar(require("node:crypto"));
const sseParser_1 = require("../copilotDirect/sseParser");
function uuid() {
    return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
function normalizeUrl(url) {
    return String(url || '').replace(/\/+$/g, '');
}
function joinPath(baseUrl, path) {
    const base = normalizeUrl(baseUrl);
    const p = String(path || '').replace(/^\/+/, '');
    return `${base}/${p}`;
}
class ModelsDirectClient {
    extensionVersion;
    editorVersion;
    constructor(extensionVersion, editorVersion) {
        this.extensionVersion = extensionVersion;
        this.editorVersion = editorVersion;
    }
    formatNoChoicesError(details) {
        const last = (details.lastEventData || '').trim();
        const lastShort = last.length > 800 ? `${last.slice(0, 800)}…(truncated)` : last;
        const dbg = details.sseDebug?.lines?.length ? details.sseDebug.lines.join('\n') : '';
        const dbgShort = dbg.length > 1200 ? `${dbg.slice(0, 1200)}…(truncated)` : dbg;
        return [
            'Models Direct response contained no choices.',
            `requestId=${details.requestId}`,
            `url=${details.url}`,
            details.contentType ? `contentType=${details.contentType}` : undefined,
            `seenEvents=${details.seenEvents}`,
            `seenJson=${details.seenJson}`,
            `seenChoice=${details.seenChoice}`,
            `seenMissingChoice=${details.seenMissingChoice}`,
            `seenDeltaContent=${details.seenDeltaContent}`,
            `seenDeltaToolCalls=${details.seenDeltaToolCalls}`,
            `invalidJson=${details.invalidJson}`,
            lastShort ? `lastEventData=${lastShort}` : undefined,
            dbgShort ? `sseRawTail=${dbgShort}` : undefined
        ]
            .filter(Boolean)
            .join(' | ');
    }
    async listModels(cfg, signal) {
        const url = joinPath(cfg.baseUrl, 'v1/models');
        const res = await fetch(url, {
            headers: {
                ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
                Accept: 'application/json',
                'User-Agent': `tripilot-chat/${this.extensionVersion}`,
                'Editor-Version': this.editorVersion,
                'Editor-Plugin-Version': `tripilot-chat/${this.extensionVersion}`,
                ...(cfg.additionalHeaders ?? {})
            },
            signal
        });
        if (!res.ok) {
            const text = await safeReadText(res);
            throw new Error(`Failed to list models (${res.status}): ${text || res.statusText}`);
        }
        const rawText = await safeReadText(res);
        let json;
        try {
            json = rawText ? JSON.parse(rawText) : undefined;
        }
        catch {
            json = undefined;
        }
        const data = (Array.isArray(json?.data) ? json.data : undefined) ??
            (Array.isArray(json?.models) ? json.models : undefined) ??
            (Array.isArray(json?.items) ? json.items : undefined) ??
            (Array.isArray(json?.data?.models) ? json.data.models : undefined) ??
            (Array.isArray(json) ? json : []);
        return data
            .map((m) => {
            const rawId = m?.id ?? m?.model ?? m?.name ?? m?.deployment ?? '';
            const id = String(rawId || '').trim();
            const displayName = (m?.display_name ? String(m.display_name) : undefined) ??
                (m?.name ? String(m.name) : undefined) ??
                (m?.id ? String(m.id) : undefined);
            const maxInputTokens = typeof m?.max_input_tokens === 'number'
                ? m.max_input_tokens
                : typeof m?.context_length === 'number'
                    ? m.context_length
                    : typeof m?.max_context_tokens === 'number'
                        ? m.max_context_tokens
                        : undefined;
            const modelTag = typeof m?.model_tag === 'string' ? m.model_tag : typeof m?.modelTag === 'string' ? m.modelTag : undefined;
            const modelExtra = m?.model_extra ?? m?.modelExtra ?? m?.extra ?? undefined;
            const provider = (typeof m?.provider === 'string' ? m.provider : undefined) ??
                (typeof m?.vendor === 'string' ? m.vendor : undefined) ??
                (typeof m?.source === 'string' ? m.source : undefined) ??
                (typeof m?.provider_name === 'string' ? m.provider_name : undefined) ??
                (typeof m?.providerName === 'string' ? m.providerName : undefined);
            return { id, displayName, maxInputTokens, modelTag, modelExtra, provider };
        })
            .filter((m) => Boolean(m.id));
    }
    async streamChatCompletions(args) {
        const url = joinPath(args.cfg.baseUrl, 'v1/chat/completions');
        const requestId = uuid();
        const extraFieldName = String(args.requestMeta?.extraFieldName || '').trim() || 'tripilot';
        const extraObj = {
            modelTag: args.requestMeta?.modelTag,
            modelExtra: args.requestMeta?.modelExtra
        };
        const shouldSendExtra = Boolean(extraObj.modelTag || extraObj.modelExtra !== undefined);
        const body = {
            model: args.model,
            stream: true,
            messages: args.messages,
            ...(args.tools?.length ? { tools: args.tools, tool_choice: 'auto' } : {}),
            temperature: 0.1
        };
        if (shouldSendExtra) {
            body[extraFieldName] = extraObj;
        }
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                ...(args.cfg.apiKey ? { Authorization: `Bearer ${args.cfg.apiKey}` } : {}),
                'Content-Type': 'application/json',
                Accept: 'text/event-stream, application/json',
                'User-Agent': `tripilot-chat/${this.extensionVersion}`,
                'Editor-Version': this.editorVersion,
                'Editor-Plugin-Version': `tripilot-chat/${this.extensionVersion}`,
                'X-Request-Id': requestId,
                ...(args.cfg.additionalHeaders ?? {}),
                ...(args.headers ?? {})
            },
            body: JSON.stringify(body),
            signal: args.signal
        });
        if (!res.ok) {
            const text = await safeReadText(res);
            throw new Error(`Models Direct chat failed (${res.status}): ${text || res.statusText}`);
        }
        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('text/event-stream')) {
            // Non-stream fallback.
            const text = await safeReadText(res);
            let json;
            try {
                json = text ? JSON.parse(text) : undefined;
            }
            catch {
                json = undefined;
            }
            if (!json?.choices?.length) {
                throw new Error(this.formatNoChoicesError({
                    requestId,
                    url,
                    contentType,
                    seenEvents: 0,
                    seenJson: json ? 1 : 0,
                    seenChoice: 0,
                    seenMissingChoice: 0,
                    seenDeltaContent: 0,
                    seenDeltaToolCalls: 0,
                    invalidJson: json ? 0 : 1,
                    lastEventData: text
                }));
            }
            const msg = json?.choices?.[0]?.message;
            const assistantText = String(msg?.content ?? '');
            const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
            if (assistantText)
                args.onTextDelta?.(assistantText);
            return { assistantText, toolCalls, requestId, finishReason: json?.choices?.[0]?.finish_reason };
        }
        if (!res.body) {
            throw new Error('Models Direct chat failed: missing response body.');
        }
        let assistantText = '';
        let finishReason;
        const toolCalls = new Map();
        let seenEvents = 0;
        let seenJson = 0;
        let invalidJson = 0;
        let seenChoice = 0;
        let seenMissingChoice = 0;
        let seenDeltaContent = 0;
        let seenDeltaToolCalls = 0;
        let lastEventData = '';
        const sseDebug = { maxLines: 80, lines: [] };
        for await (const ev of (0, sseParser_1.parseSseStream)(res.body, { signal: args.signal, debug: sseDebug })) {
            seenEvents++;
            if (ev.data === '[DONE]')
                break;
            if (ev.data && ev.data !== '[DONE]')
                lastEventData = String(ev.data);
            let chunk;
            try {
                chunk = JSON.parse(ev.data);
            }
            catch {
                invalidJson++;
                continue;
            }
            seenJson++;
            const anyChunk = chunk;
            if (anyChunk?.error) {
                const msg = typeof anyChunk.error?.message === 'string' ? anyChunk.error.message : JSON.stringify(anyChunk.error);
                throw new Error(`Models Direct stream error | requestId=${requestId} | url=${url} | contentType=${contentType} | error=${msg}`);
            }
            const choice = chunk.choices?.[0];
            if (!choice) {
                seenMissingChoice++;
                continue;
            }
            seenChoice++;
            finishReason = (choice.finish_reason ?? undefined) || finishReason;
            const delta = choice.delta;
            if (delta?.content) {
                assistantText += delta.content;
                seenDeltaContent++;
                args.onTextDelta?.(delta.content);
            }
            const tds = delta?.tool_calls;
            if (Array.isArray(tds)) {
                seenDeltaToolCalls++;
                for (const td of tds) {
                    const idx = typeof td.index === 'number' ? td.index : 0;
                    const existing = toolCalls.get(idx) ?? {
                        id: td.id || uuid(),
                        type: 'function',
                        function: { name: '', arguments: '' }
                    };
                    if (td.id)
                        existing.id = td.id;
                    if (td.function?.name)
                        existing.function.name = td.function.name;
                    if (td.function?.arguments)
                        existing.function.arguments += td.function.arguments;
                    toolCalls.set(idx, existing);
                }
            }
        }
        if (!assistantText && toolCalls.size === 0) {
            throw new Error(this.formatNoChoicesError({
                requestId,
                url,
                contentType,
                seenEvents,
                seenJson,
                seenChoice,
                seenMissingChoice,
                seenDeltaContent,
                seenDeltaToolCalls,
                invalidJson,
                lastEventData,
                sseDebug
            }));
        }
        return { assistantText, toolCalls: Array.from(toolCalls.values()), requestId, finishReason };
    }
}
exports.ModelsDirectClient = ModelsDirectClient;
async function safeReadText(res) {
    try {
        return await res.text();
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=modelsDirectClient.js.map