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
exports.peekCopilotDirectDeviceFlowSession = peekCopilotDirectDeviceFlowSession;
exports.clearCopilotDirectDeviceFlowSessions = clearCopilotDirectDeviceFlowSessions;
exports.getGitHubSession = getGitHubSession;
exports.getGitHubScopes = getGitHubScopes;
exports.onDidChangeGitHubSessions = onDidChangeGitHubSessions;
const vscode = __importStar(require("vscode"));
const GITHUB_AUTH_PROVIDER_ID = 'github';
// Scopes are best-effort; GitHub auth provider will prompt when needed.
const MINIMAL_SCOPES = ['read:user'];
// Copilot Chat upstream uses a broader "permissive" session for some features.
const PERMISSIVE_SCOPES = ['read:user', 'user:email', 'repo'];
const DEVICE_FLOW_SECRET_PREFIX = 'tripilot.copilotDirect.deviceFlow.session';
function getDeviceFlowSettings() {
    const cfg = vscode.workspace.getConfiguration('tripilot');
    const enabled = !!cfg.get('copilotDirect.deviceFlow.enabled', true);
    const clientId = String(cfg.get('copilotDirect.deviceFlow.clientId', '') ?? '').trim();
    return { enabled, clientId };
}
function getDeviceFlowSecretKey(mode) {
    return `${DEVICE_FLOW_SECRET_PREFIX}.${mode}`;
}
function safeToString(e) {
    if (e instanceof Error)
        return e.message;
    return String(e);
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
async function tryGetVsCodeGitHubSession(scopes, options) {
    // Some forks/builds might not ship a working auth provider.
    if (!vscode.authentication || typeof vscode.authentication.getSession !== 'function') {
        throw new Error('VS Code authentication API unavailable');
    }
    const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, scopes, {
        createIfNone: true,
        clearSessionPreference: !!options?.clearSessionPreference
    });
    return { accessToken: session.accessToken, accountLabel: session.account.label, source: 'vscode-auth' };
}
async function fetchGitHubAccountLabel(accessToken) {
    const res = await fetch('https://api.github.com/user', {
        method: 'GET',
        headers: {
            'Authorization': `token ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'tripilot-chat'
        }
    });
    if (!res.ok)
        return undefined;
    let json;
    try {
        json = await res.json();
    }
    catch {
        json = undefined;
    }
    const login = json?.login ? String(json.login) : '';
    const name = json?.name ? String(json.name) : '';
    const label = (login || name).trim();
    return label || undefined;
}
async function readStoredDeviceFlowSession(secretStorage, mode) {
    const raw = await secretStorage.get(getDeviceFlowSecretKey(mode));
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.accessToken !== 'string' || !String(parsed.accessToken).trim())
            return undefined;
        return {
            accessToken: String(parsed.accessToken),
            accountLabel: parsed.accountLabel ? String(parsed.accountLabel) : undefined,
            scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map((s) => String(s)) : undefined,
            updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : undefined
        };
    }
    catch {
        return undefined;
    }
}
async function peekCopilotDirectDeviceFlowSession(secretStorage, mode) {
    const sess = await readStoredDeviceFlowSession(secretStorage, mode);
    if (!sess?.accessToken)
        return undefined;
    return { accountLabel: sess.accountLabel, updatedAtMs: sess.updatedAtMs };
}
async function writeStoredDeviceFlowSession(secretStorage, mode, sess) {
    await secretStorage.store(getDeviceFlowSecretKey(mode), JSON.stringify({
        accessToken: sess.accessToken,
        accountLabel: sess.accountLabel,
        scopes: sess.scopes,
        updatedAtMs: Date.now()
    }));
}
async function clearStoredDeviceFlowSession(secretStorage, mode) {
    try {
        await secretStorage.delete(getDeviceFlowSecretKey(mode));
    }
    catch {
        // ignore
    }
}
async function clearCopilotDirectDeviceFlowSessions(secretStorage, mode) {
    const modes = mode ? [mode] : ['minimal', 'permissive'];
    let deleted = 0;
    for (const m of modes) {
        const key = getDeviceFlowSecretKey(m);
        try {
            const existing = await secretStorage.get(key);
            if (existing) {
                await secretStorage.delete(key);
                deleted++;
            }
        }
        catch {
            // ignore
        }
    }
    return deleted;
}
async function getGitHubSessionViaDeviceFlow(mode, scopes, options) {
    const { enabled, clientId } = getDeviceFlowSettings();
    if (!enabled) {
        throw new Error('GitHub device-flow fallback disabled (tripilot.copilotDirect.deviceFlow.enabled=false)');
    }
    if (!options?.secretStorage) {
        throw new Error('GitHub device-flow fallback requires SecretStorage (ExtensionContext.secrets)');
    }
    if (!clientId) {
        throw new Error('未能使用 VS Code 的 GitHub 登录；同时未配置 device-flow clientId。\n' +
            '请设置 tripilot.copilotDirect.deviceFlow.clientId（GitHub OAuth App Client ID），然后重试。');
    }
    // If caller wants to re-prompt, clear cached device-flow token too.
    if (options?.clearSessionPreference) {
        await clearStoredDeviceFlowSession(options.secretStorage, mode);
    }
    // 1) Try cached token first.
    const cached = await readStoredDeviceFlowSession(options.secretStorage, mode);
    if (cached?.accessToken) {
        const label = cached.accountLabel || (await fetchGitHubAccountLabel(cached.accessToken));
        if (label) {
            // Refresh stored label if missing.
            if (!cached.accountLabel) {
                await writeStoredDeviceFlowSession(options.secretStorage, mode, {
                    accessToken: cached.accessToken,
                    accountLabel: label,
                    scopes
                });
            }
            return { accessToken: cached.accessToken, accountLabel: label, source: 'device-flow' };
        }
        // Token likely revoked/expired; clear it.
        await clearStoredDeviceFlowSession(options.secretStorage, mode);
    }
    const deviceRes = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: clientId,
            scope: scopes.join(' ')
        })
    });
    if (!deviceRes.ok) {
        const text = await deviceRes.text().catch(() => '');
        throw new Error(`GitHub device-flow 初始化失败 (${deviceRes.status}): ${text || deviceRes.statusText}`);
    }
    let dc;
    try {
        dc = (await deviceRes.json());
    }
    catch (e) {
        throw new Error(`GitHub device-flow 初始化响应解析失败: ${safeToString(e)}`);
    }
    const userCode = String(dc.user_code || '').trim();
    const verification = String(dc.verification_uri_complete || dc.verification_uri || '').trim();
    const expiresIn = typeof dc.expires_in === 'number' ? dc.expires_in : 900;
    let intervalSec = typeof dc.interval === 'number' && dc.interval > 0 ? dc.interval : 5;
    if (!userCode || !verification) {
        throw new Error('GitHub device-flow 初始化响应缺少 user_code / verification_uri');
    }
    const openLabel = '打开浏览器';
    const copyLabel = '复制代码';
    const cancelLabel = '取消';
    const picked = await vscode.window.showInformationMessage(`Tripilot 需要登录 GitHub（device flow）。请打开页面并输入代码：${userCode}`, { modal: true }, openLabel, copyLabel, cancelLabel);
    if (picked === cancelLabel || !picked) {
        throw new Error('User cancelled GitHub device-flow sign-in');
    }
    if (picked === copyLabel) {
        await vscode.env.clipboard.writeText(userCode);
    }
    // Always try to open the browser after the prompt.
    try {
        await vscode.env.openExternal(vscode.Uri.parse(verification));
    }
    catch {
        // ignore
    }
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: clientId,
                device_code: String(dc.device_code || ''),
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            })
        });
        let tj;
        try {
            tj = await tokenRes.json();
        }
        catch {
            tj = undefined;
        }
        const accessToken = tj?.access_token ? String(tj.access_token).trim() : '';
        const err = tj?.error ? String(tj.error) : '';
        if (accessToken) {
            const label = (await fetchGitHubAccountLabel(accessToken)) || 'GitHub';
            await writeStoredDeviceFlowSession(options.secretStorage, mode, {
                accessToken,
                accountLabel: label,
                scopes
            });
            return { accessToken, accountLabel: label, source: 'device-flow' };
        }
        if (err === 'authorization_pending') {
            await sleep(intervalSec * 1000);
            continue;
        }
        if (err === 'slow_down') {
            intervalSec = Math.min(intervalSec + 5, 60);
            await sleep(intervalSec * 1000);
            continue;
        }
        if (err === 'access_denied') {
            throw new Error('GitHub device-flow: access denied');
        }
        if (err === 'expired_token') {
            throw new Error('GitHub device-flow: device code expired');
        }
        // Unknown error.
        const detail = tj ? JSON.stringify(tj) : '';
        throw new Error(`GitHub device-flow 失败: ${err || 'unknown_error'}${detail ? `: ${detail}` : ''}`);
    }
    throw new Error('GitHub device-flow 登录超时');
}
async function getGitHubSession(mode, options) {
    const scopes = mode === 'permissive' ? PERMISSIVE_SCOPES : MINIMAL_SCOPES;
    try {
        return await tryGetVsCodeGitHubSession(scopes, options);
    }
    catch (e) {
        // Fallback to device-flow when VS Code auth provider isn't available/working.
        try {
            return await getGitHubSessionViaDeviceFlow(mode, scopes, options);
        }
        catch (fallbackErr) {
            // Preserve both error messages for easier troubleshooting.
            throw new Error(`GitHub 登录失败。VS Code 认证错误：${safeToString(e)}\n` +
                `device-flow 降级也失败：${safeToString(fallbackErr)}`);
        }
    }
}
function getGitHubScopes(mode) {
    return mode === 'permissive' ? [...PERMISSIVE_SCOPES] : [...MINIMAL_SCOPES];
}
function onDidChangeGitHubSessions(listener) {
    // If authentication API is unavailable, return a no-op disposable.
    if (!vscode.authentication || typeof vscode.authentication.onDidChangeSessions !== 'function') {
        return { dispose() { } };
    }
    return vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === GITHUB_AUTH_PROVIDER_ID)
            listener();
    });
}
//# sourceMappingURL=githubAuth.js.map