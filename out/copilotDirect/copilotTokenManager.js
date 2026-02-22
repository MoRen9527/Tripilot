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
exports.CopilotTokenManager = void 0;
const vscode = __importStar(require("vscode"));
const githubAuth_1 = require("./githubAuth");
function normalizeUrl(url) {
    if (!url)
        return undefined;
    let u = String(url).trim();
    if (!u)
        return undefined;
    u = u.replace(/\/+$/g, '');
    return u;
}
function asNonEmptyString(v) {
    const s = typeof v === 'string' ? v : v == null ? '' : String(v);
    const t = s.trim();
    return t ? t : undefined;
}
function asNumber(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}
function parseExpiresAtMs(env) {
    const candidates = [
        env?.expires_at,
        env?.expiresAt,
        env?.expires_at_ms,
        env?.expiresAtMs,
        env?.expires
    ];
    for (const c of candidates) {
        const n = asNumber(c);
        if (typeof n !== 'number')
            continue;
        // Heuristic: values > 1e12 are already in ms; otherwise treat as seconds.
        return n > 1e12 ? n : n * 1000;
    }
    return undefined;
}
function parseEndpoints(env) {
    const endpointsObj = (env?.endpoints && typeof env.endpoints === 'object' ? env.endpoints : undefined) ??
        (env?.endpoint && typeof env.endpoint === 'object' ? env.endpoint : undefined) ??
        (env?.endPoints && typeof env.endPoints === 'object' ? env.endPoints : undefined) ??
        undefined;
    const api = asNonEmptyString(endpointsObj?.api) ??
        asNonEmptyString(endpointsObj?.api_url) ??
        asNonEmptyString(env?.api) ??
        asNonEmptyString(env?.api_url);
    const proxy = asNonEmptyString(endpointsObj?.proxy) ??
        asNonEmptyString(endpointsObj?.proxy_url) ??
        asNonEmptyString(env?.proxy) ??
        asNonEmptyString(env?.proxy_url);
    const telemetry = asNonEmptyString(endpointsObj?.telemetry) ??
        asNonEmptyString(endpointsObj?.telemetry_url) ??
        asNonEmptyString(env?.telemetry) ??
        asNonEmptyString(env?.telemetry_url);
    const originTracker = asNonEmptyString(endpointsObj?.['origin-tracker']) ??
        asNonEmptyString(endpointsObj?.origin_tracker) ??
        asNonEmptyString(endpointsObj?.originTracker) ??
        asNonEmptyString(env?.origin_tracker) ??
        asNonEmptyString(env?.originTracker);
    return {
        api: normalizeUrl(api),
        proxy: normalizeUrl(proxy),
        telemetry: normalizeUrl(telemetry),
        originTracker: normalizeUrl(originTracker)
    };
}
function parseEnvelope(env) {
    const anyEnv = env;
    const token = asNonEmptyString(anyEnv?.token) ??
        asNonEmptyString(anyEnv?.access_token) ??
        asNonEmptyString(anyEnv?.copilot_token) ??
        '';
    return {
        token,
        expiresAtMs: parseExpiresAtMs(anyEnv),
        endpoints: parseEndpoints(anyEnv)
    };
}
function isExpiringSoon(t, withinMs) {
    if (!t?.expiresAtMs)
        return false;
    return t.expiresAtMs - Date.now() <= withinMs;
}
class CopilotTokenManager {
    extensionVersion;
    authMode;
    secrets;
    cached;
    disposed = false;
    disposables = [];
    constructor(extensionVersion, authMode, secrets) {
        this.extensionVersion = extensionVersion;
        this.authMode = authMode;
        this.secrets = secrets;
        this.disposables.push((0, githubAuth_1.onDidChangeGitHubSessions)(() => {
            // GitHub sign-in changes => invalidate cached Copilot token.
            this.cached = undefined;
        }));
    }
    dispose() {
        this.disposed = true;
        for (const d of this.disposables)
            d.dispose();
        this.disposables.length = 0;
    }
    reset() {
        this.cached = undefined;
    }
    async getCopilotToken(options) {
        if (this.disposed)
            throw new Error('CopilotTokenManager disposed');
        const force = !!options?.force;
        if (!force && this.cached && !isExpiringSoon(this.cached, 60_000)) {
            return this.cached;
        }
        const session = await (0, githubAuth_1.getGitHubSession)(this.authMode(), {
            clearSessionPreference: !!options?.clearSessionPreference,
            secretStorage: this.secrets
        });
        const cfg = vscode.workspace.getConfiguration('tripilot');
        const overrideUrl = asNonEmptyString(cfg.get('copilotDirect.tokenUrl', ''));
        const candidates = [
            overrideUrl,
            'https://api.github.com/copilot_internal/v2/token',
            'https://api.github.com/copilot_internal/v1/token',
            'https://api.github.com/copilot_internal/token'
        ].filter(Boolean);
        const editorVersion = `vscode/${vscode.version}`;
        const pluginVersion = `tripilot-chat/${this.extensionVersion}`;
        const attempts = [];
        let env;
        for (const url of candidates) {
            try {
                const res = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `token ${session.accessToken}`,
                        'Accept': 'application/json',
                        'User-Agent': pluginVersion,
                        'X-GitHub-Api-Version': '2022-11-28',
                        'Editor-Version': editorVersion,
                        'Editor-Plugin-Version': pluginVersion
                    }
                });
                if (!res.ok) {
                    const body = await safeReadText(res);
                    attempts.push({ url, status: res.status, statusText: res.statusText, body: body?.slice(0, 500) });
                    // If v2 is missing (404/410), try older fallbacks.
                    // For auth/entitlement errors (401/403/402), don't keep hammering.
                    if (res.status === 401 || res.status === 402 || res.status === 403)
                        break;
                    continue;
                }
                try {
                    env = (await res.json());
                    break;
                }
                catch (e) {
                    attempts.push({ url, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
                    continue;
                }
            }
            catch (e) {
                attempts.push({ url, error: e instanceof Error ? e.message : String(e) });
                continue;
            }
        }
        if (!env) {
            const formatted = attempts
                .map((a) => {
                const statusPart = typeof a.status === 'number' ? ` ${a.status}${a.statusText ? ` ${a.statusText}` : ''}` : '';
                const errPart = a.error ? ` err=${a.error}` : '';
                const bodyPart = a.body ? ` body=${a.body}` : '';
                return `${a.url}${statusPart}${errPart}${bodyPart}`;
            })
                .join(' | ');
            throw new Error(`Failed to get Copilot token (all endpoints failed). Attempts: ${formatted}`);
        }
        const token = parseEnvelope(env);
        if (!token.token) {
            throw new Error('Copilot token response missing token');
        }
        this.cached = token;
        return token;
    }
}
exports.CopilotTokenManager = CopilotTokenManager;
async function safeReadText(res) {
    try {
        return await res.text();
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=copilotTokenManager.js.map