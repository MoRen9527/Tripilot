import * as crypto from 'node:crypto';
import type { OpenAIChatCompletionsChunk, OpenAIChatMessage, OpenAITool, OpenAIToolCall } from '../copilotDirect/types';
import { parseSseStream, type SseDebugBuffer } from '../copilotDirect/sseParser';

function uuid(): string {
	return typeof (crypto as any).randomUUID === 'function' ? (crypto as any).randomUUID() : `${Date.now()}-${Math.random()}`;
}

function normalizeUrl(url: string): string {
	return String(url || '').replace(/\/+$/g, '');
}

function joinPath(baseUrl: string, path: string): string {
	const base = normalizeUrl(baseUrl);
	const p = String(path || '').replace(/^\/+/, '');
	return `${base}/${p}`;
}

export type ModelsDirectModelInfo = {
	id: string;
	displayName?: string;
	maxInputTokens?: number;
	modelTag?: string;
	modelExtra?: any;
	/** Optional provider display name (if the server returns it). */
	provider?: string;
};

export type ModelsDirectClientConfig = {
	baseUrl: string;
	apiKey?: string;
	additionalHeaders?: Record<string, string>;
};

export class ModelsDirectClient {
	constructor(
		private readonly extensionVersion: string,
		private readonly editorVersion: string
	) {}

	private formatNoChoicesError(details: {
		requestId: string;
		url: string;
		contentType?: string;
		seenEvents: number;
		seenJson: number;
		seenChoice: number;
		seenMissingChoice: number;
		seenDeltaContent: number;
		seenDeltaToolCalls: number;
		invalidJson: number;
		lastEventData?: string;
		sseDebug?: SseDebugBuffer;
	}): string {
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

	public async listModels(cfg: ModelsDirectClientConfig, signal?: AbortSignal): Promise<ModelsDirectModelInfo[]> {
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
				const rawId = m?.id ?? m?.model ?? m?.name ?? m?.deployment ?? '';
				const id = String(rawId || '').trim();
				const displayName =
					(m?.display_name ? String(m.display_name) : undefined) ??
					(m?.name ? String(m.name) : undefined) ??
					(m?.id ? String(m.id) : undefined);
				const maxInputTokens =
					typeof m?.max_input_tokens === 'number'
						? m.max_input_tokens
						: typeof m?.context_length === 'number'
							? m.context_length
							: typeof m?.max_context_tokens === 'number'
								? m.max_context_tokens
								: undefined;
				const modelTag = typeof m?.model_tag === 'string' ? m.model_tag : typeof m?.modelTag === 'string' ? m.modelTag : undefined;
				const modelExtra = m?.model_extra ?? m?.modelExtra ?? m?.extra ?? undefined;
				const provider =
					(typeof m?.provider === 'string' ? m.provider : undefined) ??
					(typeof m?.vendor === 'string' ? m.vendor : undefined) ??
					(typeof m?.source === 'string' ? m.source : undefined) ??
					(typeof m?.provider_name === 'string' ? m.provider_name : undefined) ??
					(typeof m?.providerName === 'string' ? m.providerName : undefined);
				return { id, displayName, maxInputTokens, modelTag, modelExtra, provider } as ModelsDirectModelInfo;
			})
			.filter((m: ModelsDirectModelInfo) => Boolean(m.id));
	}

	public async streamChatCompletions(args: {
		cfg: ModelsDirectClientConfig;
		model: string;
		messages: OpenAIChatMessage[];
		tools?: OpenAITool[];
		requestMeta?: { modelTag?: string; modelExtra?: any; extraFieldName?: string };
		headers?: Record<string, string>;
		signal?: AbortSignal;
		onTextDelta?: (delta: string) => void;
	}): Promise<{ assistantText: string; toolCalls: OpenAIToolCall[]; requestId: string; finishReason?: string }> {
		const url = joinPath(args.cfg.baseUrl, 'v1/chat/completions');
		const requestId = uuid();

		const extraFieldName = String(args.requestMeta?.extraFieldName || '').trim() || 'tripilot';
		const extraObj = {
			modelTag: args.requestMeta?.modelTag,
			modelExtra: args.requestMeta?.modelExtra
		};
		const shouldSendExtra = Boolean(extraObj.modelTag || extraObj.modelExtra !== undefined);

		const body: any = {
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
			let json: any;
			try {
				json = text ? JSON.parse(text) : undefined;
			} catch {
				json = undefined;
			}

			if (!json?.choices?.length) {
				throw new Error(
					this.formatNoChoicesError({
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
					})
				);
			}

			const msg = json?.choices?.[0]?.message;
			const assistantText = String(msg?.content ?? '');
			const toolCalls = Array.isArray(msg?.tool_calls) ? (msg.tool_calls as OpenAIToolCall[]) : [];
			if (assistantText) args.onTextDelta?.(assistantText);
			return { assistantText, toolCalls, requestId, finishReason: json?.choices?.[0]?.finish_reason };
		}

		if (!res.body) {
			throw new Error('Models Direct chat failed: missing response body.');
		}

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
				const msg = typeof anyChunk.error?.message === 'string' ? anyChunk.error.message : JSON.stringify(anyChunk.error);
				throw new Error(
					`Models Direct stream error | requestId=${requestId} | url=${url} | contentType=${contentType} | error=${msg}`
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
			throw new Error(
				this.formatNoChoicesError({
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
				})
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
