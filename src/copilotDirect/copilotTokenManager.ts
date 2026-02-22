import * as vscode from 'vscode';
import type { CopilotToken, CopilotTokenEnvelope } from './types';
import { getGitHubSession, type GitHubAuthMode, onDidChangeGitHubSessions } from './githubAuth';

function normalizeUrl(url?: string): string | undefined {
	if (!url) return undefined;
	let u = String(url).trim();
	if (!u) return undefined;
	u = u.replace(/\/+$/g, '');
	return u;
}

function asNonEmptyString(v: unknown): string | undefined {
	const s = typeof v === 'string' ? v : v == null ? '' : String(v);
	const t = s.trim();
	return t ? t : undefined;
}

function asNumber(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string') {
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function parseExpiresAtMs(env: any): number | undefined {
	const candidates: unknown[] = [
		env?.expires_at,
		env?.expiresAt,
		env?.expires_at_ms,
		env?.expiresAtMs,
		env?.expires
	];
	for (const c of candidates) {
		const n = asNumber(c);
		if (typeof n !== 'number') continue;
		// Heuristic: values > 1e12 are already in ms; otherwise treat as seconds.
		return n > 1e12 ? n : n * 1000;
	}
	return undefined;
}

function parseEndpoints(env: any): CopilotToken['endpoints'] {
	const endpointsObj =
		(env?.endpoints && typeof env.endpoints === 'object' ? env.endpoints : undefined) ??
		(env?.endpoint && typeof env.endpoint === 'object' ? env.endpoint : undefined) ??
		(env?.endPoints && typeof env.endPoints === 'object' ? env.endPoints : undefined) ??
		(undefined as any);

	const api =
		asNonEmptyString(endpointsObj?.api) ??
		asNonEmptyString(endpointsObj?.api_url) ??
		asNonEmptyString(env?.api) ??
		asNonEmptyString(env?.api_url);

	const proxy =
		asNonEmptyString(endpointsObj?.proxy) ??
		asNonEmptyString(endpointsObj?.proxy_url) ??
		asNonEmptyString(env?.proxy) ??
		asNonEmptyString(env?.proxy_url);

	const telemetry =
		asNonEmptyString(endpointsObj?.telemetry) ??
		asNonEmptyString(endpointsObj?.telemetry_url) ??
		asNonEmptyString(env?.telemetry) ??
		asNonEmptyString(env?.telemetry_url);

	const originTracker =
		asNonEmptyString(endpointsObj?.['origin-tracker']) ??
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

function parseEnvelope(env: CopilotTokenEnvelope | unknown): CopilotToken {
	const anyEnv: any = env as any;
	const token =
		asNonEmptyString(anyEnv?.token) ??
		asNonEmptyString(anyEnv?.access_token) ??
		asNonEmptyString(anyEnv?.copilot_token) ??
		'';

	return {
		token,
		expiresAtMs: parseExpiresAtMs(anyEnv),
		endpoints: parseEndpoints(anyEnv)
	};
}

function isExpiringSoon(t: CopilotToken | undefined, withinMs: number): boolean {
	if (!t?.expiresAtMs) return false;
	return t.expiresAtMs - Date.now() <= withinMs;
}

export class CopilotTokenManager implements vscode.Disposable {
	private cached?: CopilotToken;
	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionVersion: string,
		private readonly authMode: () => GitHubAuthMode,
		private readonly secrets: vscode.SecretStorage
	) {
		this.disposables.push(
			onDidChangeGitHubSessions(() => {
				// GitHub sign-in changes => invalidate cached Copilot token.
				this.cached = undefined;
			})
		);
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.disposables) d.dispose();
		this.disposables.length = 0;
	}

	public reset(): void {
		this.cached = undefined;
	}

	public async getCopilotToken(options?: { force?: boolean; clearSessionPreference?: boolean }): Promise<CopilotToken> {
		if (this.disposed) throw new Error('CopilotTokenManager disposed');
		const force = !!options?.force;
		if (!force && this.cached && !isExpiringSoon(this.cached, 60_000)) {
			return this.cached;
		}

		const session = await getGitHubSession(this.authMode(), {
			clearSessionPreference: !!options?.clearSessionPreference,
			secretStorage: this.secrets
		});

		const cfg = vscode.workspace.getConfiguration('tripilot');
		const overrideUrl = asNonEmptyString(cfg.get<string>('copilotDirect.tokenUrl', ''));
		const candidates = [
			overrideUrl,
			'https://api.github.com/copilot_internal/v2/token',
			'https://api.github.com/copilot_internal/v1/token',
			'https://api.github.com/copilot_internal/token'
		].filter(Boolean) as string[];

		const editorVersion = `vscode/${vscode.version}`;
		const pluginVersion = `tripilot-chat/${this.extensionVersion}`;

		type Attempt = { url: string; status?: number; statusText?: string; body?: string; error?: string };
		const attempts: Attempt[] = [];
		let env: CopilotTokenEnvelope | undefined;

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
					if (res.status === 401 || res.status === 402 || res.status === 403) break;
					continue;
				}

				try {
					env = (await res.json()) as CopilotTokenEnvelope;
					break;
				} catch (e) {
					attempts.push({ url, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
					continue;
				}
			} catch (e) {
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
			throw new Error(
				`Failed to get Copilot token (all endpoints failed). Attempts: ${formatted}`
			);
		}

		const token = parseEnvelope(env);
		if (!token.token) {
			throw new Error('Copilot token response missing token');
		}

		this.cached = token;
		return token;
	}
}

async function safeReadText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return '';
	}
}
