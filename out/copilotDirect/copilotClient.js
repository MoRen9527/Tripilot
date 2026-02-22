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
exports.CopilotDirectClient = void 0;
const crypto = __importStar(require("node:crypto"));
const sseParser_1 = require("./sseParser");
function uuid() {
    return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
function normalizeUrl(url) {
    return String(url || '').replace(/\/+$/g, '');
}
function getProxyBaseUrl(token) {
    return token.endpoints.proxy || 'https://copilot-proxy.githubusercontent.com';
}
function getModelsBaseUrl(token) {
    // In practice, many tenants expose the richer model catalog on `endpoints.api`.
    // The `proxy` host is primarily for streaming chat traffic and may return a reduced /models set.
    return token.endpoints.api || token.endpoints.proxy || 'https://api.githubcopilot.com';
}
function uniqStrings(items) {
    const out = [];
    const seen = new Set();
    for (const i of items) {
        const v = (i ? String(i).trim() : '').replace(/\/+$/g, '');
        if (!v)
            continue;
        if (seen.has(v))
            continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}
function shouldRetryAgainstAlternateBase(status) {
    // These usually mean "wrong host/path" rather than entitlement.
    return status === 404 || status === 405 || status === 410 || status === 501;
}
function parseMultiplier(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s)
            return undefined;
        // Accept formats like "3", "3.0", "3x", "0.33x".
        const cleaned = s.replace(/\s+/g, '').replace(/x$/i, '');
        const n = Number.parseFloat(cleaned);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}
class CopilotDirectClient {
    extensionVersion;
    editorVersion;
    constructor(extensionVersion, editorVersion) {
        this.extensionVersion = extensionVersion;
        this.editorVersion = editorVersion;
    }
    async listModels(token, signal) {
        const bases = uniqStrings([
            getModelsBaseUrl(token),
            token.endpoints.proxy,
            token.endpoints.api,
            'https://api.githubcopilot.com',
            'https://copilot-proxy.githubusercontent.com'
        ]);
        let rawText = '';
        let lastErr = '';
        for (let i = 0; i < bases.length; i++) {
            const base = bases[i];
            const url = `${normalizeUrl(base)}/models`;
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token.token}`,
                    'Accept': 'application/json',
                    'User-Agent': `tripilot-chat/${this.extensionVersion}`,
                    'Editor-Version': this.editorVersion,
                    'Editor-Plugin-Version': `tripilot-chat/${this.extensionVersion}`
                },
                signal
            });
            if (!res.ok) {
                const text = await safeReadText(res);
                lastErr = `Failed to list models (${res.status}) base=${base}: ${text || res.statusText}`;
                if (shouldRetryAgainstAlternateBase(res.status) && i < bases.length - 1)
                    continue;
                throw new Error(lastErr);
            }
            rawText = await safeReadText(res);
            break;
        }
        if (!rawText && lastErr)
            throw new Error(lastErr);
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
            // Different proxies/tenants use slightly different shapes.
            // Prefer a stable id if present; otherwise fall back to a name-like field.
            const rawId = m?.id ??
                m?.model ??
                m?.name ??
                m?.slug ??
                m?.deployment ??
                m?.deployment_name ??
                m?.azure_deployment ??
                '';
            const id = String(rawId || '').trim();
            const displayName = (m?.display_name ? String(m.display_name) : undefined) ??
                (m?.name ? String(m.name) : undefined) ??
                (m?.model ? String(m.model) : undefined);
            const maxInputTokens = typeof m?.max_input_tokens === 'number'
                ? m.max_input_tokens
                : typeof m?.context_length === 'number'
                    ? m.context_length
                    : typeof m?.max_context_tokens === 'number'
                        ? m.max_context_tokens
                        : undefined;
            const rawMultiplier = (typeof m?.multiplier === 'number' ? m.multiplier : undefined) ??
                (typeof m?.request_multiplier === 'number' ? m.request_multiplier : undefined) ??
                (typeof m?.premium_multiplier === 'number' ? m.premium_multiplier : undefined) ??
                (typeof m?.cost_multiplier === 'number' ? m.cost_multiplier : undefined) ??
                (typeof m?.billing?.multiplier === 'number' ? m.billing.multiplier : undefined) ??
                (typeof m?.pricing?.multiplier === 'number' ? m.pricing.multiplier : undefined) ??
                (typeof m?.multiplier === 'string' ? m.multiplier : undefined) ??
                (typeof m?.request_multiplier === 'string' ? m.request_multiplier : undefined) ??
                (typeof m?.premium_multiplier === 'string' ? m.premium_multiplier : undefined) ??
                (typeof m?.cost_multiplier === 'string' ? m.cost_multiplier : undefined) ??
                (typeof m?.billing?.multiplier === 'string' ? m.billing.multiplier : undefined) ??
                (typeof m?.pricing?.multiplier === 'string' ? m.pricing.multiplier : undefined) ??
                undefined;
            const multiplier = parseMultiplier(rawMultiplier);
            return {
                id,
                displayName,
                maxInputTokens,
                multiplier: typeof multiplier === 'number' && Number.isFinite(multiplier) ? multiplier : undefined
            };
        })
            .filter((m) => !!m.id);
    }
    async createAutoModelsSession(args) {
        const bases = uniqStrings([
            getModelsBaseUrl(args.token),
            args.token.endpoints.api,
            'https://api.githubcopilot.com'
        ]);
        const hint = String(args.modelHint ?? 'auto').trim() || 'auto';
        let lastErr = '';
        for (let i = 0; i < bases.length; i++) {
            const base = bases[i];
            const url = `${normalizeUrl(base)}/models/session`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${args.token.token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': `tripilot-chat/${this.extensionVersion}`,
                    'Editor-Version': this.editorVersion,
                    'Editor-Plugin-Version': `tripilot-chat/${this.extensionVersion}`,
                    ...(args.previousSessionToken ? { 'Copilot-Session-Token': args.previousSessionToken } : {})
                },
                body: JSON.stringify({ auto_mode: { model_hints: [hint] } }),
                signal: args.signal
            });
            if (!res.ok) {
                const text = await safeReadText(res);
                lastErr = `Failed to create auto models session (${res.status}) base=${base}: ${text || res.statusText}`;
                if (shouldRetryAgainstAlternateBase(res.status) && i < bases.length - 1)
                    continue;
                throw new Error(lastErr);
            }
            const rawText = await safeReadText(res);
            let json;
            try {
                json = rawText ? JSON.parse(rawText) : undefined;
            }
            catch {
                json = undefined;
            }
            const availableModels = Array.isArray(json?.available_models) ? json.available_models.map((x) => String(x)) : [];
            const selectedModel = String(json?.selected_model ?? '').trim();
            const expiresAt = typeof json?.expires_at === 'number' ? json.expires_at : 0;
            const sessionToken = String(json?.session_token ?? '').trim();
            const discountedCostsRaw = json?.discounted_costs;
            const discountedCosts = discountedCostsRaw && typeof discountedCostsRaw === 'object'
                ? Object.fromEntries(Object.entries(discountedCostsRaw)
                    .map(([k, v]) => [String(k), typeof v === 'number' ? v : Number(v)])
                    .filter(([k, v]) => Boolean(k) && typeof v === 'number' && Number.isFinite(v)))
                : undefined;
            if (!selectedModel || !sessionToken) {
                throw new Error(`Invalid auto models session response (missing selected_model/session_token) base=${base}`);
            }
            return { availableModels, selectedModel, expiresAt, sessionToken, discountedCosts };
        }
        throw new Error(lastErr || 'Failed to create auto models session');
    }
    async streamChatCompletions(args) {
        const bases = uniqStrings([
            getProxyBaseUrl(args.copilotToken),
            args.copilotToken.endpoints.api,
            args.copilotToken.endpoints.proxy,
            'https://copilot-proxy.githubusercontent.com',
            'https://api.githubcopilot.com'
        ]);
        const requestId = uuid();
        let res;
        let lastErr = '';
        for (let i = 0; i < bases.length; i++) {
            const base = bases[i];
            const url = `${normalizeUrl(base)}/chat/completions`;
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${args.copilotToken.token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'User-Agent': `tripilot-chat/${this.extensionVersion}`,
                    'Editor-Version': this.editorVersion,
                    'Editor-Plugin-Version': `tripilot-chat/${this.extensionVersion}`,
                    'X-Request-Id': requestId,
                    ...(args.intent ? { 'OpenAI-Intent': args.intent } : {}),
                    ...(args.headers ?? {})
                },
                body: JSON.stringify({
                    model: args.model,
                    stream: true,
                    messages: args.messages,
                    // Copilot proxy generally supports OpenAI-style tools.
                    ...(args.tools?.length ? { tools: args.tools, tool_choice: 'auto' } : {}),
                    temperature: 0.1
                }),
                signal: args.signal
            });
            if (!res.ok || !res.body) {
                const text = await safeReadText(res);
                lastErr = `Copilot chat failed (${res.status}) base=${base}: ${text || res.statusText}`;
                if (shouldRetryAgainstAlternateBase(res.status) && i < bases.length - 1)
                    continue;
                throw new Error(lastErr);
            }
            break;
        }
        if (!res || !res.body)
            throw new Error(lastErr || 'Copilot chat failed (no response body)');
        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
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
                throw new Error(`Copilot stream error | requestId=${requestId} | contentType=${contentType} | error=${msg}`);
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
            const last = lastEventData.trim();
            const lastShort = last.length > 800 ? `${last.slice(0, 800)}…(truncated)` : last;
            const dbg = sseDebug.lines.length ? sseDebug.lines.join('\n') : '';
            const dbgShort = dbg.length > 1200 ? `${dbg.slice(0, 1200)}…(truncated)` : dbg;
            throw new Error([
                'Copilot response contained no choices.',
                `requestId=${requestId}`,
                contentType ? `contentType=${contentType}` : undefined,
                `seenEvents=${seenEvents}`,
                `seenJson=${seenJson}`,
                `seenChoice=${seenChoice}`,
                `seenMissingChoice=${seenMissingChoice}`,
                `seenDeltaContent=${seenDeltaContent}`,
                `seenDeltaToolCalls=${seenDeltaToolCalls}`,
                `invalidJson=${invalidJson}`,
                lastShort ? `lastEventData=${lastShort}` : undefined,
                dbgShort ? `sseRawTail=${dbgShort}` : undefined
            ]
                .filter(Boolean)
                .join(' | '));
        }
        return { assistantText, toolCalls: Array.from(toolCalls.values()), requestId, finishReason };
    }
}
exports.CopilotDirectClient = CopilotDirectClient;
async function safeReadText(res) {
    try {
        return await res.text();
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=copilotClient.js.map