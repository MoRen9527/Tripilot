import * as crypto from 'node:crypto';
import type {
	CopilotToken,
	OpenAIChatCompletionsChunk,
	OpenAIChatMessage,
	OpenAITool,
	OpenAIToolCall
} from './types';
import { parseSseStream, type SseDebugBuffer } from './sseParser';

function uuid(): string {
	return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function normalizeUrl(url: string): string {
	return String(url || '').replace(/\/+$/g, '');
}

function getProxyBaseUrl(token: CopilotToken): string {
	return token.endpoints.proxy || 'https://copilot-proxy.githubusercontent.com';
}

function getModelsBaseUrl(token: CopilotToken): string {
	// In practice, many tenants expose the richer model catalog on `endpoints.api`.
	// The `proxy` host is primarily for streaming chat traffic and may return a reduced /models set.
	return token.endpoints.api || token.endpoints.proxy || 'https://api.githubcopilot.com';
}

function uniqStrings(items: Array<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const i of items) {
		const v = (i ? String(i).trim() : '').replace(/\/+$/g, '');
		if (!v) continue;
		if (seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
}

function shouldRetryAgainstAlternateBase(status: number): boolean {
	// These usually mean "wrong host/path" rather than entitlement.
	return status === 404 || status === 405 || status === 410 || status === 501;
}

function parseMultiplier(raw: unknown): number | undefined {
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
	if (typeof raw === 'string') {
		const s = raw.trim();
		if (!s) return undefined;
		// Accept formats like "3", "3.0", "3x", "0.33x".
		const cleaned = s.replace(/\s+/g, '').replace(/x$/i, '');
		const n = Number.parseFloat(cleaned);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

export type CopilotModelInfo = {
	id: string;
	displayName?: string;
	maxInputTokens?: number;
	/** Optional request cost multiplier if provided by the catalog. */
	multiplier?: number;
};

export type CopilotAutoModelsSession = {
	availableModels: string[];
	selectedModel: string;
	expiresAt: number; // seconds since epoch
	sessionToken: string;
	discountedCosts?: Record<string, number>;
};

export class CopilotDirectClient {
	constructor(
		private readonly extensionVersion: string,
		private readonly editorVersion: string
	) {}

	public async listModels(token: CopilotToken, signal?: AbortSignal): Promise<CopilotModelInfo[]> {
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
				if (shouldRetryAgainstAlternateBase(res.status) && i < bases.length - 1) continue;
				throw new Error(lastErr);
			}
			rawText = await safeReadText(res);
			break;
		}
		if (!rawText && lastErr) throw new Error(lastErr);
		let json: any;
		try {
			json = rawText ? JSON.parse(rawText) : undefined;
		} catch {
			json = undefined;
		}

		const data =
			(Array.isArray(json?.data) ? json.data : undefined) ??
			(Array.isArray(json?.models) ? json.models : undefined) ??
			(Array.isArray(json?.items) ? json.items : undefined) ??
			(Array.isArray(json?.data?.models) ? json.data.models : undefined) ??
			(Array.isArray(json) ? json : []);

		return (data as any[])
			.map((m: any) => {
				// Different proxies/tenants use slightly different shapes.
				// Prefer a stable id if present; otherwise fall back to a name-like field.
				const rawId =
					m?.id ??
					m?.model ??
					m?.name ??
					m?.slug ??
					m?.deployment ??
					m?.deployment_name ??
					m?.azure_deployment ??
					'';

				const id = String(rawId || '').trim();
				const displayName =
					(m?.display_name ? String(m.display_name) : undefined) ??
					(m?.name ? String(m.name) : undefined) ??
					(m?.model ? String(m.model) : undefined);

				const maxInputTokens =
					typeof m?.max_input_tokens === 'number'
						? m.max_input_tokens
						: typeof m?.context_length === 'number'
							? m.context_length
							: typeof m?.max_context_tokens === 'number'
								? m.max_context_tokens
								: undefined;

				const rawMultiplier =
					(typeof m?.multiplier === 'number' ? m.multiplier : undefined) ??
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
					(undefined as number | undefined);

				const multiplier = parseMultiplier(rawMultiplier);

				return {
					id,
					displayName,
					maxInputTokens,
					multiplier: typeof multiplier === 'number' && Number.isFinite(multiplier) ? multiplier : undefined
				} as CopilotModelInfo;
			})
			.filter((m: CopilotModelInfo) => !!m.id);
	}

	public async createAutoModelsSession(args: {
		token: CopilotToken;
		modelHint?: string;
		previousSessionToken?: string;
		signal?: AbortSignal;
	}): Promise<CopilotAutoModelsSession> {
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
				if (shouldRetryAgainstAlternateBase(res.status) && i < bases.length - 1) continue;
				throw new Error(lastErr);
			}
			const rawText = await safeReadText(res);
			let json: any;
			try {
				json = rawText ? JSON.parse(rawText) : undefined;
			} catch {
				json = undefined;
			}
			const availableModels = Array.isArray(json?.available_models) ? json.available_models.map((x: any) => String(x)) : [];
			const selectedModel = String(json?.selected_model ?? '').trim();
			const expiresAt = typeof json?.expires_at === 'number' ? json.expires_at : 0;
			const sessionToken = String(json?.session_token ?? '').trim();
			const discountedCostsRaw = json?.discounted_costs;
			const discountedCosts =
				discountedCostsRaw && typeof discountedCostsRaw === 'object'
					? Object.fromEntries(
							Object.entries(discountedCostsRaw as Record<string, any>)
								.map(([k, v]) => [String(k), typeof v === 'number' ? v : Number(v)])
								.filter(([k, v]) => Boolean(k) && typeof v === 'number' && Number.isFinite(v))
						)
					: undefined;

			if (!selectedModel || !sessionToken) {
				throw new Error(`Invalid auto models session response (missing selected_model/session_token) base=${base}`);
			}
			return { availableModels, selectedModel, expiresAt, sessionToken, discountedCosts };
		}
		throw new Error(lastErr || 'Failed to create auto models session');
	}

	public async streamChatCompletions(args: {
		copilotToken: CopilotToken;
		model: string;
		messages: OpenAIChatMessage[];
		tools?: OpenAITool[];
		intent?: string;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		onTextDelta?: (delta: string) => void;
	}): Promise<{ assistantText: string; toolCalls: OpenAIToolCall[]; requestId: string; finishReason?: string }> {
		const bases = uniqStrings([
			getProxyBaseUrl(args.copilotToken),
			args.copilotToken.endpoints.api,
			args.copilotToken.endpoints.proxy,
			'https://copilot-proxy.githubusercontent.com',
			'https://api.githubcopilot.com'
		]);
		const requestId = uuid();

		let res: Response | undefined;
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
				if (shouldRetryAgainstAlternateBase(res.status) && i < bases.length - 1) continue;
				throw new Error(lastErr);
			}
			break;
		}
		if (!res || !res.body) throw new Error(lastErr || 'Copilot chat failed (no response body)');
		const contentType = String(res.headers.get('content-type') || '').toLowerCase();

		let assistantText = '';
		let finishReason: string | undefined;
		const toolCalls = new Map<number, OpenAIToolCall>();

		let seenEvents = 0;
		let seenJson = 0;
		let invalidJson = 0;
		let seenChoice = 0;
		let seenMissingChoice = 0;
		let seenDeltaContent = 0;
		let seenDeltaToolCalls = 0;
		let lastEventData = '';
		const sseDebug: SseDebugBuffer = { maxLines: 80, lines: [] };
		for await (const ev of parseSseStream(res.body, { signal: args.signal, debug: sseDebug })) {
			seenEvents++;
			if (ev.data === '[DONE]') break;
			if (ev.data && ev.data !== '[DONE]') lastEventData = String(ev.data);
			let chunk: OpenAIChatCompletionsChunk;
			try {
				chunk = JSON.parse(ev.data);
			} catch {
				invalidJson++;
				continue;
			}
			seenJson++;

			const anyChunk: any = chunk as any;
			if (anyChunk?.error) {
				const msg =
					typeof anyChunk.error?.message === 'string' ? anyChunk.error.message : JSON.stringify(anyChunk.error);
				throw new Error(
					`Copilot stream error | requestId=${requestId} | contentType=${contentType} | error=${msg}`
				);
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
					if (td.id) existing.id = td.id;
					if (td.function?.name) existing.function.name = td.function.name;
					if (td.function?.arguments) existing.function.arguments += td.function.arguments;
					toolCalls.set(idx, existing);
				}
			}
		}

		if (!assistantText && toolCalls.size === 0) {
			const last = lastEventData.trim();
			const lastShort = last.length > 800 ? `${last.slice(0, 800)}…(truncated)` : last;
			const dbg = sseDebug.lines.length ? sseDebug.lines.join('\n') : '';
			const dbgShort = dbg.length > 1200 ? `${dbg.slice(0, 1200)}…(truncated)` : dbg;
			throw new Error(
				[
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
					.join(' | ')
			);
		}

		return { assistantText, toolCalls: Array.from(toolCalls.values()), requestId, finishReason };
	}
}

async function safeReadText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return '';
	}
}
