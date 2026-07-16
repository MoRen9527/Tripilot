import * as vscode from 'vscode';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as https from 'node:https';
import * as http from 'node:http';
import { McpClientManager, makeMcpLmToolName, type McpServerConfig, type McpServerStatus } from './mcpClient';
import { JsonlChatHistoryStore, type ChatHistoryEvent } from './chatHistory';
import { CopilotTokenManager } from './copilotDirect/copilotTokenManager';
import { CopilotDirectClient, type CopilotAutoModelsSession, type CopilotModelInfo } from './copilotDirect/copilotClient';
import type { OpenAIChatMessage, OpenAITool, OpenAIToolCall } from './copilotDirect/types';
import {
	clearCopilotDirectDeviceFlowSessions,
	getGitHubScopes,
	getGitHubSession,
	peekCopilotDirectDeviceFlowSession
} from './copilotDirect/githubAuth';
import { ModelsDirectClient, type ModelsDirectModelInfo } from './modelsDirect/modelsDirectClient';
import { applyPatch as applyUnifiedPatch, diffLines, parsePatch } from 'diff';

type WebviewInboundMessage =
	| { type: 'webviewReady' }
	| { type: 'chatUserMessage'; text: string }
	| { type: 'cancel' }
	| { type: 'requestWorkspaceContext' }
	| { type: 'editApprovalAction'; requestId: string; action: 'preview' | 'apply' | 'cancel' }
	| { type: 'editReviewAction'; requestId: string; action: 'preview' | 'undo' | 'keep' }
	| { type: 'checkpointAction'; checkpointId: string; action: 'restore' | 'redo'; redoToken?: string }
	| { type: 'uiAction'; action: string; payload?: any; clientTs?: number };

type WebviewOutboundMessage =
	| { type: 'init'; extensionName: string }
	| { type: 'chatReset' }
	| { type: 'chatAppend'; role: 'user' | 'assistant' | 'tool'; text: string }
	| { type: 'chatCheckpoint'; checkpointId: string }
	| { type: 'checkpointRedoOffer'; checkpointId: string; redoToken: string }
	| { type: 'checkpointRedoClear' }
	| { type: 'chatAssistantStart'; initialText?: string }
	| { type: 'chatAssistantDelta'; delta: string }
	| { type: 'chatAssistantEnd' }
	| {
				type: 'chatToolInvocationBegin';
				invocationId: string;
				toolName: string;
				inputPreview?: string;
			}
	| {
				type: 'chatToolInvocationEnd';
				invocationId: string;
				toolName: string;
				ok: boolean;
				outputPreview?: string;
				outputFull?: string;
				durationMs?: number;
			}
	| {
				type: 'chatTodoList';
				todoList: Array<{ id: number; title: string; description: string; status: string }>;
				note?: string;
			}
	| { type: 'chatSetStatus'; status: 'idle' | 'thinking' | 'running-tools' | 'error'; detail?: string }
	| { type: 'workspaceContext'; workspaceFolders: string[] }
	| {
				type: 'editApprovalRequest';
				requestId: string;
				summary: string;
				files: Array<{ relativePath: string; editCount: number }>;
				diffStats?: { filesChanged: number; additions: number; deletions: number };
				canPreview: boolean;
	  }
	| { type: 'editApprovalClear'; requestId: string }
	| {
				type: 'editReviewRequest';
				requestId: string;
				summary: string;
				files: Array<{ relativePath: string; editCount: number }>;
				diffStats?: { filesChanged: number; additions: number; deletions: number };
				canPreview: boolean;
	  }
	| { type: 'editReviewClear'; requestId: string };

function countLinesForDiffStat(value: string): number {
	if (!value) return 0;
	const matches = value.match(/\r\n|\r|\n/g);
	const newlines = matches ? matches.length : 0;
	const endsWithNewline = /\r\n|\r|\n$/.test(value);
	return endsWithNewline ? newlines : newlines + 1;
}

function computeDiffStats(
	previews: Array<{ original: string; updated: string }>
): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const p of previews) {
		const parts = diffLines(String(p.original ?? ''), String(p.updated ?? ''));
		for (const part of parts) {
			const value = String((part as any).value ?? '');
			if ((part as any).added) additions += countLinesForDiffStat(value);
			else if ((part as any).removed) deletions += countLinesForDiffStat(value);
		}
	}
	return { additions, deletions };
}

type LmModelInfo = {
	id: string;
	name: string;
	vendor: string;
	family: string;
	version: string;
	maxInputTokens: number;
	/** Optional right-aligned label for model pickers (e.g. multiplier or provider). */
	rightText?: string;
};

function formatMultiplier(multiplier: number): string {
	if (!Number.isFinite(multiplier)) return '';
	// Match Copilot UI: show raw multiplier number + 'x' (e.g. 0x, 0.33x, 1x, 3x)
	return `${multiplier}x`;
}

function formatDiscountPercent(frac: number): string {
	if (!Number.isFinite(frac)) return '';
	const pct = frac * 100;
	// Avoid trailing zeros for common values (10, 12.5, 33.33)
	return String(Number(pct.toFixed(2)));
}

function computeDiscountRange(discountedCosts?: Record<string, number>): { low: number; high: number } | undefined {
	if (!discountedCosts) return undefined;
	const values = Object.values(discountedCosts).filter((v) => typeof v === 'number' && Number.isFinite(v));
	if (!values.length) return undefined;
	let low = values[0];
	let high = values[0];
	for (const v of values) {
		if (v < low) low = v;
		if (v > high) high = v;
	}
	if (!Number.isFinite(low) || !Number.isFinite(high)) return undefined;
	return { low, high };
}

function formatDiscountLabel(range?: { low: number; high: number }): string | undefined {
	if (!range) return undefined;
	const low = range.low;
	const high = range.high;
	if (!Number.isFinite(low) || !Number.isFinite(high)) return undefined;
	// Copilot UI shows discount only (not multiplier) for Auto.
	if (low <= 0 && high <= 0) return undefined;
	if (Math.abs(low - high) < 1e-9) return `${formatDiscountPercent(low)}% discount`;
	return `${formatDiscountPercent(low)}%–${formatDiscountPercent(high)}% discount`;
}

function inferVscodeLmRightText(model: vscode.LanguageModelChat): string | undefined {
	// Best-effort parity with Copilot Chat: the LM API may expose a `multiplier` field (string like "3x")
	// on the model info; its exact shape differs across VS Code versions.
	const anyModel = model as any;
	const raw =
		anyModel?.multiplier ??
		anyModel?.details?.multiplier ??
		anyModel?.info?.multiplier ??
		anyModel?.chatInfo?.multiplier ??
		anyModel?.metadata?.multiplier;
	if (typeof raw === 'string') {
		const s = raw.trim();
		return s || undefined;
	}
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		return formatMultiplier(raw);
	}

	// Some hosts expose multiplier only via detail/tooltip strings.
	const detail = typeof anyModel?.detail === 'string' ? String(anyModel.detail) : '';
	const tooltip = typeof anyModel?.tooltip === 'string' ? String(anyModel.tooltip) : '';
	const hay = `${detail}\n${tooltip}`;
	const m = hay.match(/counted\s+at\s+([0-9]+(?:\.[0-9]+)?)x/i);
	if (m?.[1]) {
		const n = Number.parseFloat(m[1]);
		if (Number.isFinite(n)) return formatMultiplier(n);
	}
	return undefined;
}

function inferDiscountLabelFromText(text: string): string | undefined {
	const t = String(text || '').trim();
	if (!t) return undefined;
	// Try to capture patterns like "10% discount" or "10%–20% discount".
	const m = t.match(/([0-9]+(?:\.[0-9]+)?)%\s*(?:[–\-~]\s*([0-9]+(?:\.[0-9]+)?)%)?\s*discount/i);
	if (m?.[1]) {
		const a = m[1];
		const b = m[2];
		return b ? `${a}%–${b}% discount` : `${a}% discount`;
	}
	return undefined;
}

function inferVscodeLmAutoRightText(model: vscode.LanguageModelChat): string | undefined {
	const anyModel = model as any;
	const detail = typeof anyModel?.detail === 'string' ? String(anyModel.detail) : '';
	const tooltip = typeof anyModel?.tooltip === 'string' ? String(anyModel.tooltip) : '';
	return inferDiscountLabelFromText(`${detail}\n${tooltip}`) ?? inferVscodeLmRightText(model);
}

function isHostVisibleVscodeLmModel(model: vscode.LanguageModelChat): boolean {
	const m = model as any;
	// VS Code's LM API doesn't currently expose a stable "eye toggled" field.
	// Some builds/providers attach non-enumerable flags; treat any explicit false/hidden as not visible.
	try {
		if (m?.isHidden === true || m?.hidden === true) return false;
		if (m?.isUserVisible === false || m?.userVisible === false) return false;
		if (m?.isVisible === false || m?.visible === false) return false;
		if (m?.isUserSelectable === false || m?.userSelectable === false) return false;
		if (m?.isSelectable === false || m?.selectable === false) return false;
		const visibility = typeof m?.visibility === 'string' ? String(m.visibility).toLowerCase() : '';
		if (visibility === 'hidden' || visibility === 'internal') return false;
	} catch {
		// ignore
	}
	return true;
}

type VscodeCachedChatModelEntry = {
	identifier?: string;
	metadata?: {
		id?: string;
		vendor?: string;
		isUserSelectable?: boolean;
	};
};

let sqlJsInitPromise: Promise<any> | undefined;
async function getSqlJs(extensionPath: string): Promise<any> {
	if (!sqlJsInitPromise) {
		const mod: any = await import('sql.js');
		const initSqlJs: any = mod?.default ?? mod;
		sqlJsInitPromise = initSqlJs({
			locateFile: (file: string) => path.join(extensionPath, 'node_modules', 'sql.js', 'dist', file)
		});
	}
	return sqlJsInitPromise;
}

let cachedVscodeChatVisibleIds:
	| { atMs: number; ids: Set<string>; source: 'vscdb.cachedLanguageModels' | 'none' }
	| undefined;

async function tryReadVscodeChatVisibleModelIdsFromStateDb(args: {
	context: vscode.ExtensionContext;
}): Promise<{ ids: Set<string>; source: 'vscdb.cachedLanguageModels' } | undefined> {
	try {
		const now = Date.now();
		if (cachedVscodeChatVisibleIds && now - cachedVscodeChatVisibleIds.atMs < 5_000) {
			return cachedVscodeChatVisibleIds.source === 'none'
				? undefined
				: { ids: cachedVscodeChatVisibleIds.ids, source: 'vscdb.cachedLanguageModels' };
		}

		const globalStorageDir = path.dirname(args.context.globalStorageUri.fsPath);
		const stateDbPath = path.join(globalStorageDir, 'state.vscdb');
		const dbBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(stateDbPath));

		const SQL = await getSqlJs(args.context.extensionPath);
		const db = new SQL.Database(dbBytes);
		try {
			const res = db.exec("SELECT value FROM ItemTable WHERE key='chat.cachedLanguageModels' LIMIT 1");
			const val = res?.[0]?.values?.[0]?.[0];
			if (val == null) {
				cachedVscodeChatVisibleIds = { atMs: now, ids: new Set(), source: 'none' };
				return undefined;
			}
			const text =
				val instanceof Uint8Array
					? new TextDecoder('utf-8').decode(val)
					: typeof val === 'string'
						? val
						: String(val);
			const entries = JSON.parse(text) as VscodeCachedChatModelEntry[];
			const ids = new Set<string>();
			for (const e of entries) {
				const id = e?.metadata?.id != null ? String(e.metadata.id) : '';
				if (!id) continue;
				if (e?.metadata?.isUserSelectable === true) ids.add(id);
			}
			cachedVscodeChatVisibleIds = { atMs: now, ids, source: 'vscdb.cachedLanguageModels' };
			return { ids, source: 'vscdb.cachedLanguageModels' };
		} finally {
			try {
				db.close();
			} catch {
				// ignore
			}
		}
	} catch {
		cachedVscodeChatVisibleIds = { atMs: Date.now(), ids: new Set(), source: 'none' };
		return undefined;
	}
}

function normalizeVendorLabel(vendor: string | undefined): string | undefined {
	const s = (vendor ? String(vendor).trim() : '') || '';
	if (!s) return undefined;
	const lower = s.toLowerCase();
	if (lower === 'openrouter') return 'openrouter';
	return s;
}

function inferModelsDirectProviderLabel(args: { provider?: string; modelTag?: string; modelExtra?: any }): string | undefined {
	const direct = (args.provider ? String(args.provider).trim() : '') || '';
	if (direct) return direct;
	try {
		const extra = args.modelExtra;
		if (extra && typeof extra === 'object') {
			const provider = (extra as any).provider ?? (extra as any).vendor ?? (extra as any).source;
			const s = provider ? String(provider).trim() : '';
			if (s) return s;
		}
	} catch {
		// ignore
	}
	const tag = (args.modelTag ? String(args.modelTag).trim() : '') || '';
	return tag || undefined;
}

type ModelsCacheEntry = { atMs: number; ttlMs: number; models: LmModelInfo[] };
const SETTINGS_MODELS_CACHE_TTL_MS = 60_000;
const settingsModelsCache = new Map<string, ModelsCacheEntry>();

function makeSettingsModelsCacheKey(provider: 'vscode-lm' | 'copilot-direct' | 'models-direct'): string {
	const cfg = vscode.workspace.getConfiguration('tripilot');
	if (provider === 'models-direct') {
		const baseUrl = String(cfg.get<string>('modelsDirect.baseUrl', '') ?? '').trim();
		const tagDefault = String(cfg.get<string>('modelsDirect.modelTagDefault', '') ?? '').trim();
		return `models-direct:${baseUrl}|tagDefault=${tagDefault}`;
	}
	if (provider === 'copilot-direct') {
		const authMode = String(cfg.get<string>('copilotDirect.authMode', 'minimal') ?? 'minimal');
		return `copilot-direct:authMode=${authMode}`;
	}
	return 'vscode-lm';
}

function tryGetSettingsModelsFromCache(key: string): LmModelInfo[] | undefined {
	const hit = settingsModelsCache.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.atMs > hit.ttlMs) {
		settingsModelsCache.delete(key);
		return undefined;
	}
	return hit.models;
}

function setSettingsModelsCache(key: string, models: LmModelInfo[]): void {
	settingsModelsCache.set(key, { atMs: Date.now(), ttlMs: SETTINGS_MODELS_CACHE_TTL_MS, models });
	// Prevent unbounded growth (should be tiny).
	if (settingsModelsCache.size > 10) {
		const firstKey = settingsModelsCache.keys().next().value as string | undefined;
		if (firstKey) settingsModelsCache.delete(firstKey);
	}
}

function clearSettingsModelsCache(): void {
	settingsModelsCache.clear();
}

type WebviewOutboundMessageExtended =
	| WebviewOutboundMessage
	| { type: 'host'; host: 'sidebar' | 'editor' }
	| { type: 'contextChips'; items: Array<string | ContextChip> }
	| { type: 'toolChips'; items: string[] }
	| {
				type: 'hashSuggestions';
				items: Array<{ kind: 'file' | 'tool'; label: string; detail?: string; insertText: string }>;
		  }
	| {
				type: 'lmModels';
				models: LmModelInfo[];
				selectedModelId?: string;
				provider?: 'vscode-lm' | 'copilot-direct' | 'models-direct';
				runtimeCount?: number;
				hostVisibleCount?: number;
				hostVisibleSource?: 'vscdb.cachedLanguageModels' | 'heuristic' | 'none';
				whitelistSize?: number;
				openrouterCount?: number;
				filteredCount?: number;
		}
	| { type: 'agentProfile'; id: string; label: string; allowedOptionalTools: string[]; enabledOptionalTools: string[] }
	| { type: 'agents'; agents: Array<{ id: string; label: string; description?: string }> }
	| {
				type: 'sessions';
				isHistoryEnabled: boolean;
				sessions: Array<{
					sessionId: string;
					title?: string;
					preview?: string;
					relativeTime?: string;
					isActive?: boolean;
				}>;
		  }
	| {
				type: 'subagentTree';
				nodes: Array<{
					id: string;
					parentId: string | null;
					label: string;
					type: 'main' | 'subagent';
					status: 'idle' | 'working' | 'done' | 'error';
					sessionId?: string;
					traceId?: string;
					eventId?: string;
					eventSeq?: number;
				}>;
		  }
	| {
				type: 'replayState';
				active: boolean;
				playing: boolean;
				cursor: number;
				sessionId?: string;
				traceId?: string;
				locked: boolean;
				totalRecords?: number;
				cadenceMs?: number;
		  }
	| {
				type: 'sceneState';
				machineState: 'idle' | 'working' | 'waiting' | 'failed';
				reason?: string;
				transition?: string;
				latestEventSeq?: number;
				recoveryAt?: number;
				updatedAt: number;
				workstations: Array<{
					id: string;
					mappingKey: string;
					label: string;
					state: 'idle' | 'working' | 'waiting' | 'failed';
					recovered?: boolean;
					nodeId?: string;
					eventId?: string;
					eventSeq?: number;
					sessionId?: string;
					traceId?: string;
					kind: 'subagent' | 'approval';
				}>;
		  };

type WorkspaceCustomAgentInfo = {
	/** Stable id used by Tripilot (namespaced). */
	id: string;
	/** Display name (frontmatter.name or file base name). */
	name: string;
	description?: string;
	tools?: string[];
	model?: string;
	/** Workspace-relative path to the agent file. */
	relativePath: string;
	/** Whether this agent is hidden from the agents dropdown. */
	hidden: boolean;
	/** True when discovered from legacy .github/chatmodes/*.chatmode.md */
	isLegacy?: boolean;
	/** Markdown body (instructions). */
	body: string;
};

type ChatHostKind = 'sidebar' | 'editor';

type ChatTranscriptItem =
	| { role: 'user' | 'assistant' | 'tool'; text: string }
	| { role: 'checkpoint'; checkpointId: string };

type ContextAttachment =
	| {
			id: string;
			kind: 'selection';
			label: string;
			text: string;
			languageId?: string;
			source?: { uri: string; range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number } };
	  }
	| {
			id: string;
			kind: 'file';
			label: string;
			uri: string;
			text: string;
			languageId?: string;
			truncated?: boolean;
	  };

type ContextChip = { id: string; kind: ContextAttachment['kind']; label: string; badge?: string; title?: string };

type ChatHostState = {
	kind: ChatHostKind;
	webview?: vscode.Webview;
	conversation: vscode.LanguageModelChatMessage[];
	// Copilot Direct mode uses OpenAI-like message objects.
	copilotConversation?: OpenAIChatMessage[];
	// Stable per-host interaction id (best-effort parity with Copilot headers).
	copilotInteractionId?: string;
	// Auto mode uses a short-lived session token + a selected model.
	copilotAutoSession?: {
		sessionToken: string;
		expiresAtMs: number;
		selectedModel: string;
		discountRange?: { low: number; high: number };
	};
	transcript: ChatTranscriptItem[];
	contextAttachments?: ContextAttachment[];
	lastToolReferences?: string[];
	status?: 'idle' | 'thinking' | 'running-tools' | 'error';
	statusDetail?: string;
	isBusy?: boolean;
	inProgressAssistantText?: string;
	abortController?: AbortController;
	lmCancelSource?: vscode.CancellationTokenSource;
	historyStore?: JsonlChatHistoryStore;
	historySessionId?: string;
	currentSessionTitle?: string;
	replayOnReady?: { kind: 'session'; sessionId: string } | { kind: 'transcript'; transcript: ChatTranscriptItem[] };
	replayState?: {
		active: boolean;
		playing: boolean;
		cursor: number;
		sessionId?: string;
		traceId?: string;
		locked: boolean;
		totalRecords?: number;
		cadenceMs?: number;
	};
	replayCadenceTimer?: NodeJS.Timeout;
	sceneState?: {
		machineState: 'idle' | 'working' | 'waiting' | 'failed';
		reason?: string;
		transition?: string;
		latestEventSeq?: number;
		recoveryAt?: number;
		updatedAt: number;
		workstations: Array<{
			id: string;
			mappingKey: string;
			label: string;
			state: 'idle' | 'working' | 'waiting' | 'failed';
			recovered?: boolean;
			nodeId?: string;
			eventId?: string;
			eventSeq?: number;
			sessionId?: string;
			traceId?: string;
			kind: 'subagent' | 'approval';
		}>;
	};
};


function languageToBadge(languageId: string | undefined, fileName: string): string | undefined {
	const lid = String(languageId ?? '').toLowerCase();
	if (lid === 'typescript') return 'TS';
	if (lid === 'typescriptreact') return 'TSX';
	if (lid === 'javascript') return 'JS';
	if (lid === 'javascriptreact') return 'JSX';
	if (lid === 'json' || lid === 'jsonc') return 'JSON';
	if (lid === 'markdown') return 'MD';
	if (lid === 'yaml') return 'YAML';
	if (lid === 'python') return 'PY';
	if (lid === 'csharp') return 'CS';
	if (lid === 'cpp') return 'CPP';
	if (lid === 'c') return 'C';
	if (lid === 'go') return 'GO';
	if (lid === 'ruby') return 'RB';
	if (lid === 'java') return 'JAVA';
	if (lid === 'html') return 'HTML';
	if (lid === 'css') return 'CSS';
	if (lid === 'scss') return 'SCSS';
	if (lid === 'less') return 'LESS';
	if (lid === 'vue') return 'VUE';
	const ext = path.extname(fileName || '').replace(/^\./, '').toUpperCase();
	if (!ext) return undefined;
	if (['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG', 'BMP', 'ICO'].includes(ext)) return 'IMG';
	return ext.length <= 6 ? ext : ext.slice(0, 6);
}

function attachmentsToChips(items: ContextAttachment[] | undefined): ContextChip[] {
	const out: ContextChip[] = [];
	for (const a of items ?? []) {
		if (a.kind === 'file') {
			try {
				const uri = vscode.Uri.parse(a.uri);
				const fileName = path.basename(uri.fsPath || uri.path || '');
				const badge = languageToBadge(a.languageId, fileName);
				const title = safeWorkspaceRelativePath(uri) || uri.fsPath || a.label;
				out.push({ id: a.id, kind: a.kind, label: fileName || a.label, badge, title });
				continue;
			} catch {
				// fall through
			}
		}
		out.push({ id: a.id, kind: a.kind, label: a.label, title: a.label });
	}
	return out;
}

function safeWorkspaceRelativePath(uri: vscode.Uri): string | undefined {
	try {
		const rel = vscode.workspace.asRelativePath(uri, false);
		const s = String(rel ?? '').trim();
		return s || undefined;
	} catch {
		return undefined;
	}
}

type ToolPolicy = {
	agentProfileId: string;
	askStudySandboxDir: string; // workspace-relative
};

type ToolReferences = {
	toolReferences: Set<string>;
	serverReferences: Set<string>;
};

type ChatHistoryEventInput = {
	[K in ChatHistoryEvent['kind']]: Omit<Extract<ChatHistoryEvent, { kind: K }>, 'ts' | 'sessionId'>;
}[ChatHistoryEvent['kind']];

type ToolRuntime = {
	abortSignal: AbortSignal;
	requestEditsApproval?: (args: {
		previews: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }>;
		summary: { editCount: number; fileCount: number };
		canPreview: boolean;
	}) => Promise<'apply' | 'cancel'>;
	postEditsReview?: (args: {
		requestId: string;
		previews: Array<{
			relativePath: string;
			uri: vscode.Uri;
			original: string;
			updated: string;
			editCount: number;
			kind: 'add' | 'update' | 'delete';
		}>;
		summary: { editCount: number; fileCount: number };
		canPreview: boolean;
	}) => void;
	runSubagent?: (args: { prompt: string; description: string }) => Promise<string>;
	mcpManager?: McpClientManager;
	commandTools?: Map<string, CommandToolConfig>;
	policy?: ToolPolicy;
};

// Tools menu currently exposes only a subset; treat them as optional toggles.
const OPTIONAL_TOOL_NAMES = new Set([
	// agent
	'runSubagent',
	// edit
	'createDirectory',
	'createFile',
	'editFiles',
	'editNotebook',
	'newJupyterNotebook',
	// execute
	'createAndRunTask',
	'runInTerminal',
	'getTerminalOutput',
	'runTask',
	'runTests',
	'testFailure',
	'runNotebookCell',
	// read
	'readFile',
	'problems',
	'terminalLastCommand',
	'terminalSelection',
	'getNotebookSummary',
	'readNotebookCellOutput',
	'getTaskOutput',
	// search
	'fileSearch',
	'textSearch',
	'listDirectory',
	'searchResults',
	'codebase',
	'usages',
	'changes',
	// todo
	'manage_todo_list',
	// vscode
	'extensions',
	'installExtension',
	'openSimpleBrowser',
	'runCommand',
	'newWorkspace',
	'getProjectSetupInfo',
	'vscodeAPI',
	// web
	'fetch',
	'githubRepo'
]);

// Copilot-like tool sets (referencable via #edit / #search).
// These are NOT tools themselves; they expand into multiple tool names.
const TOOL_SETS: Record<string, { description: string; tools: string[] }> = {
	edit: {
		description: 'Tool set for creating/modifying files (Copilot-like #edit).',
		tools: ['createDirectory', 'createFile', 'editFiles', 'editNotebook', 'newJupyterNotebook']
	},
	search: {
		description: 'Tool set for reading/searching workspace context (Copilot-like #search).',
		tools: ['readFile', 'listDirectory', 'fileSearch', 'textSearch', 'searchResults', 'codebase', 'usages', 'changes', 'problems']
	}
};
const TOOL_SET_NAMES = new Set(Object.keys(TOOL_SETS));

// ask&study is a read-only mode: only allow learning/inspection tools.
// Keep this list intentionally small; we can expand later.
// New policy: ask&study uses a sandbox directory for write/apply/exec.
// Command tools + MCP remain limited to a hardcoded "learning" allowlist.
const ASK_STUDY_ALLOWED_COMMAND_TOOL_NAMES = new Set<string>([
	// e.g. 'explainSelection'
]);

const ASK_STUDY_ALLOWED_MCP_SERVER_IDS = new Set<string>([
	// e.g. 'docs'
]);

const ASK_STUDY_ALLOWED_VSCODE_COMMAND_IDS = new Set<string>([
	// keep empty by default; vscode_executeCommand is powerful
]);

// Conversation is stored as vscode.lm messages (LanguageModelChatMessage).

let settingsPerfChannel: vscode.OutputChannel | undefined;
let settingsPerfRing: string[] = [];
const SETTINGS_PERF_RING_MAX_LINES = 4000;

function isSettingsPerfEnabled(): boolean {
	try {
		return !!vscode.workspace.getConfiguration('tripilot').get<boolean>('debug.settingsPerf', false);
	} catch {
		return false;
	}
}

function settingsPerfLog(msg: string): void {
	if (!isSettingsPerfEnabled()) return;
	try {
		settingsPerfRing.push(msg);
		if (settingsPerfRing.length > SETTINGS_PERF_RING_MAX_LINES) {
			settingsPerfRing.splice(0, settingsPerfRing.length - SETTINGS_PERF_RING_MAX_LINES);
		}
		settingsPerfChannel?.appendLine(msg);
	} catch {
		// ignore
	}
}

export function activate(context: vscode.ExtensionContext) {
	const debugChannel = vscode.window.createOutputChannel('Tripilot Debug');
	context.subscriptions.push(debugChannel);
	const copilotDirectChannel = vscode.window.createOutputChannel('Tripilot Copilot Direct');
	context.subscriptions.push(copilotDirectChannel);
	const mcpChannel = vscode.window.createOutputChannel('Tripilot MCP');
	context.subscriptions.push(mcpChannel);
	settingsPerfChannel = vscode.window.createOutputChannel('Tripilot Settings Perf');
	context.subscriptions.push(settingsPerfChannel);
	const mcpManager = new McpClientManager(mcpChannel);
	context.subscriptions.push(mcpManager);
	const extensionVersion = String((context as any)?.extension?.packageJSON?.version ?? '0.0.0');
	const editorVersionHeader = `vscode/${vscode.version}`;
	const provider = new TripilotChatViewProvider(context, mcpManager, extensionVersion, editorVersionHeader);
	TripilotChatViewProvider.setActiveInstance(provider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(TripilotChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	// Background prefetch: try to warm copilot-direct token and model list to speed first Settings open.
	void (async () => {
		try {
			const cfg = vscode.workspace.getConfiguration('tripilot');
			const chatProvider = String(cfg.get('chatProvider', 'vscode-lm')) as 'vscode-lm' | 'copilot-direct' | 'models-direct';
			if (chatProvider !== 'copilot-direct') return;
			const authMode = String(cfg.get('copilotDirect.authMode', 'minimal')) as any;
			const scopes = getGitHubScopes(authMode === 'permissive' ? 'permissive' : 'minimal');
			let hasSession = false;
			try {
				if (vscode.authentication && typeof vscode.authentication.getSession === 'function') {
					const s = await vscode.authentication.getSession('github', scopes, { createIfNone: false });
					hasSession = !!s;
				}
			} catch {
				// ignore
			}
			let devicePeek = false;
			try {
				const peek = await peekCopilotDirectDeviceFlowSession(context.secrets, authMode);
				devicePeek = !!peek;
			} catch {
				// ignore
			}
			if (!hasSession && !devicePeek) return;
			// We have either a VS Code GitHub session or a cached device-flow session: warm token + models.
			if (isSettingsPerfEnabled()) settingsPerfLog('[settings] backgroundPrefetch start');
			try {
				const tokenManager = new CopilotTokenManager(extensionVersion, () => (authMode === 'permissive' ? 'permissive' : 'minimal'), context.secrets);
				const client = new CopilotDirectClient(extensionVersion, editorVersionHeader);
				const token = await tokenManager.getCopilotToken();
				if (!token) return;
				const models = await client.listModels(token);
				const mapped: LmModelInfo[] = models.map((m) => ({
					id: m.id,
					name: m.displayName ?? m.id,
					vendor: 'copilot',
					family: 'copilot',
					version: 'n/a',
					maxInputTokens: m.maxInputTokens ?? 0
				}));
				const result = [
					{ id: 'auto', name: 'Auto', vendor: 'tripilot', family: 'auto', version: 'auto', maxInputTokens: 0 },
					...mapped
				];
				setSettingsModelsCache(makeSettingsModelsCacheKey('copilot-direct'), result);
				try {
					tokenManager.dispose();
				} catch {
					// ignore
				}
				if (isSettingsPerfEnabled()) settingsPerfLog('[settings] backgroundPrefetch done');
			} catch (e) {
				if (isSettingsPerfEnabled()) settingsPerfLog(`[settings] backgroundPrefetch err ${e instanceof Error ? e.message : String(e)}`);
			}
		} catch (e) {
			// swallow any error; non-critical
		}
	})();

	context.subscriptions.push(
		mcpManager.onDidChange(() => {
			TripilotSettingsPanel.refreshIfOpen();
			void provider.refreshToolsAndPost();
		})
	);

	// Refresh model list when providers change (API availability varies by VS Code version).
	const lmAny = vscode.lm as any;
	if (typeof lmAny?.onDidChangeChatModels === 'function') {
		context.subscriptions.push(lmAny.onDidChangeChatModels(() => provider.refreshModelsAndPost()));
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('tripilot.visibleModelIds')) {
				provider.refreshModelsAndPost();
			}
			if (
				e.affectsConfiguration('tripilot.chatProvider') ||
				e.affectsConfiguration('tripilot.copilotDirect.authMode') ||
				e.affectsConfiguration('tripilot.modelsDirect.baseUrl') ||
				e.affectsConfiguration('tripilot.modelsDirect.defaultModel') ||
				e.affectsConfiguration('tripilot.modelsDirect.modelTagDefault') ||
				e.affectsConfiguration('tripilot.modelsDirect.modelTags') ||
				e.affectsConfiguration('tripilot.modelsDirect.modelExtras')
			) {
				clearSettingsModelsCache();
			}
			if (e.affectsConfiguration('tripilot.mcpServers')) {
				void mcpManager.refresh(readMcpServersFromConfig());
			}
		})
	);

	// Connect enabled MCP servers on activation.
	void mcpManager.refresh(readMcpServersFromConfig());

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.debug.dumpLmModels', async () => {
			debugChannel.show(true);
			debugChannel.appendLine(`[dumpLmModels] ${new Date().toISOString()}`);

			const lmAnyLocal = (vscode as any).lm;
			if (!lmAnyLocal || typeof lmAnyLocal.selectChatModels !== 'function') {
				debugChannel.appendLine('vscode.lm.selectChatModels 不可用（当前 VS Code 可能不支持 LM API）。');
				return;
			}

			const models = await vscode.lm.selectChatModels();
			debugChannel.appendLine(`models: ${models.length}`);

			for (const m of models) {
				const anyM = m as any;
				const keys = Object.keys(anyM).sort();
				debugChannel.appendLine('---');
				debugChannel.appendLine(`id: ${m.id}`);
				debugChannel.appendLine(`name: ${m.name}`);
				debugChannel.appendLine(`vendor: ${m.vendor}`);
				debugChannel.appendLine(`family: ${m.family}`);
				debugChannel.appendLine(`version: ${m.version}`);
				debugChannel.appendLine(`maxInputTokens: ${m.maxInputTokens}`);
				debugChannel.appendLine(`typeof sendRequest: ${typeof anyM.sendRequest}`);
				debugChannel.appendLine(`runtime keys: ${keys.join(', ')}`);

				for (const field of [
					'isUserSelectable',
					'showInModelPicker',
					'visible',
					'detail',
					'tooltip',
					'maxOutputTokens',
					'capabilities'
				]) {
					if (Object.prototype.hasOwnProperty.call(anyM, field)) {
						debugChannel.appendLine(`${field}: ${safeToString(anyM[field])}`);
					}
				}
			}

			debugChannel.appendLine('---');
			debugChannel.appendLine('提示：如果这里没有 isUserSelectable/visible 等字段，说明扩展侧公开 API 很可能无法获取“模型 picker 可见性”。');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.debug.diagnoseCopilotDirect', async () => {
			copilotDirectChannel.show(true);
			copilotDirectChannel.appendLine(`[diagnoseCopilotDirect] ${new Date().toISOString()}`);

			const config = vscode.workspace.getConfiguration('tripilot');
			const chatProvider = String(config.get('chatProvider', 'vscode-lm'));
			const authMode = String(config.get('copilotDirect.authMode', 'minimal')) as any;
			const scopes = getGitHubScopes(authMode === 'permissive' ? 'permissive' : 'minimal');
			copilotDirectChannel.appendLine(`vscode: ${vscode.version}`);
			copilotDirectChannel.appendLine(`extensionVersion: ${extensionVersion}`);
			copilotDirectChannel.appendLine(`tripilot.chatProvider: ${chatProvider}`);
			copilotDirectChannel.appendLine(`tripilot.copilotDirect.authMode: ${authMode}`);
			copilotDirectChannel.appendLine(`githubScopes: ${scopes.join(' ')}`);

			const redact = (t: string | undefined) => {
				const s = String(t || '');
				if (!s) return '';
				if (s.length <= 12) return `${s.slice(0, 2)}…${s.slice(-2)}`;
				return `${s.slice(0, 6)}…${s.slice(-4)}`;
			};
			const truncate = (s: string, max = 2000) => (s.length > max ? `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)` : s);

			// 1) GitHub session
			copilotDirectChannel.appendLine('---');
			copilotDirectChannel.appendLine('GitHub session:');
			let ghAccessToken = '';
			let ghAccount = '';
			let ghSource = '';

			// Best-effort: detect whether a VS Code GitHub session already exists.
			try {
				if (vscode.authentication && typeof vscode.authentication.getSession === 'function') {
					const existing = await vscode.authentication.getSession('github', scopes, { createIfNone: false });
					if (existing) {
						copilotDirectChannel.appendLine(`existing(vscode-auth): yes (${existing.account.label})`);
					} else {
						copilotDirectChannel.appendLine('existing(vscode-auth): no');
					}
				} else {
					copilotDirectChannel.appendLine('existing(vscode-auth): unavailable (authentication API missing)');
				}
			} catch (e) {
				copilotDirectChannel.appendLine(`existing(vscode-auth): error: ${e instanceof Error ? e.message : String(e)}`);
			}

			try {
				const sess = await getGitHubSession(authMode === 'permissive' ? 'permissive' : 'minimal', {
					clearSessionPreference: false,
					secretStorage: context.secrets
				});
				ghAccessToken = sess.accessToken;
				ghAccount = sess.accountLabel || '';
				ghSource = sess.source || '';
				copilotDirectChannel.appendLine(`createdOrFetched: yes${ghAccount ? ` (${ghAccount})` : ''}${ghSource ? ` [${ghSource}]` : ''}`);
			} catch (e) {
				copilotDirectChannel.appendLine(`createdOrFetched: error: ${e instanceof Error ? e.message : String(e)}`);
			}

			if (!ghAccessToken) {
				copilotDirectChannel.appendLine('STOP: no GitHub session token available.');
				copilotDirectChannel.appendLine('Tip: 若是 VSCodium/无 GitHub Provider，请配置 tripilot.copilotDirect.deviceFlow.clientId 后重试。');
				return;
			}
			copilotDirectChannel.appendLine(`ghAccessToken: ${redact(ghAccessToken)}`);

			// 2) Copilot token endpoint
			copilotDirectChannel.appendLine('---');
			copilotDirectChannel.appendLine('Copilot token endpoint:');
			const tokenUrl = 'https://api.github.com/copilot_internal/v2/token';
			const editorVersionHeader = `vscode/${vscode.version}`;
			const pluginVersionHeader = `tripilot-chat/${extensionVersion}`;
			let copilotToken: string | undefined;
			let proxyBase: string | undefined;
			let apiBase: string | undefined;
			try {
				const res = await fetch(tokenUrl, {
					method: 'GET',
					headers: {
						'Authorization': `token ${ghAccessToken}`,
						'Accept': 'application/json',
						'User-Agent': pluginVersionHeader,
						'X-GitHub-Api-Version': '2022-11-28',
						'Editor-Version': editorVersionHeader,
						'Editor-Plugin-Version': pluginVersionHeader
					}
				});
				const text = await res.text().catch(() => '');
				copilotDirectChannel.appendLine(`status: ${res.status} ${res.statusText}`);
				copilotDirectChannel.appendLine(`x-github-request-id: ${res.headers.get('x-github-request-id') || ''}`);
				if (!res.ok) {
					copilotDirectChannel.appendLine('body:');
					copilotDirectChannel.appendLine(truncate(text || '(empty)'));
				} else {
					let env: any;
					try {
						env = text ? JSON.parse(text) : undefined;
					} catch {
						env = undefined;
					}
					copilotToken = env?.token ? String(env.token) : undefined;
					proxyBase = env?.endpoints?.proxy ? String(env.endpoints.proxy) : undefined;
					apiBase = env?.endpoints?.api ? String(env.endpoints.api) : undefined;
					copilotDirectChannel.appendLine(`copilotToken: ${redact(copilotToken)}`);
					copilotDirectChannel.appendLine(`expires_at: ${typeof env?.expires_at === 'number' ? env.expires_at : ''}`);
					copilotDirectChannel.appendLine(`api: ${apiBase || ''}`);
					copilotDirectChannel.appendLine(`proxy: ${proxyBase || ''}`);
				}
			} catch (e) {
				copilotDirectChannel.appendLine(`fetch error: ${e instanceof Error ? e.message : String(e)}`);
			}

			if (!copilotToken) {
				copilotDirectChannel.appendLine('STOP: Copilot token missing (likely no Copilot entitlement or token endpoint blocked).');
				return;
			}

			// 3) /models endpoints (raw)
			const probeModels = async (label: string, baseUrl: string | undefined) => {
				const base = String(baseUrl || '').replace(/\/+$/g, '');
				if (!base) return;
				copilotDirectChannel.appendLine('---');
				copilotDirectChannel.appendLine(`Copilot /models (${label}):`);
				const modelsUrl = `${base}/models`;
				try {
					const res = await fetch(modelsUrl, {
						headers: {
							'Authorization': `Bearer ${copilotToken}`,
							'Accept': 'application/json',
							'User-Agent': `tripilot-chat/${extensionVersion}`,
							'Editor-Version': editorVersionHeader,
							'Editor-Plugin-Version': pluginVersionHeader
						}
					});
					const text = await res.text().catch(() => '');
					copilotDirectChannel.appendLine(`url: ${modelsUrl}`);
					copilotDirectChannel.appendLine(`status: ${res.status} ${res.statusText}`);
					copilotDirectChannel.appendLine(`content-type: ${res.headers.get('content-type') || ''}`);
					if (!res.ok) {
						copilotDirectChannel.appendLine('body:');
						copilotDirectChannel.appendLine(truncate(text || '(empty)'));
						return;
					}
					let json: any;
					try {
						json = text ? JSON.parse(text) : undefined;
					} catch {
						json = undefined;
					}
					const arr =
						(Array.isArray(json?.data) ? json.data : undefined) ??
						(Array.isArray(json?.models) ? json.models : undefined) ??
						(Array.isArray(json?.items) ? json.items : undefined) ??
						(Array.isArray(json?.data?.models) ? json.data.models : undefined) ??
						(Array.isArray(json) ? json : []);
					copilotDirectChannel.appendLine(`parsedModels: ${Array.isArray(arr) ? arr.length : 0}`);
					if (Array.isArray(arr) && arr.length) {
						const ids = arr
							.map((m: any) => {
								const v = m?.id ?? m?.model ?? m?.name ?? m?.slug ?? m?.deployment ?? '';
								return String(v || '').trim();
							})
							.filter(Boolean)
							.slice(0, 20);
						copilotDirectChannel.appendLine(`firstIds: ${ids.join(', ')}`);

						// Print multiplier hints for the first few models to debug UI labels.
						for (const mm of arr.slice(0, 8)) {
							const id = String(mm?.id ?? mm?.model ?? mm?.name ?? '').trim();
							const mult =
								mm?.billing?.multiplier ??
								mm?.multiplier ??
								mm?.request_multiplier ??
								mm?.premium_multiplier ??
								mm?.cost_multiplier;
							const billing = mm?.billing ? safeOneLine(JSON.stringify(mm.billing), 200) : '';
							copilotDirectChannel.appendLine(`model: ${id || '(no id)'} | multiplierField=${safeToString(mult)} | billing=${billing}`);
						}
					}
					if (!Array.isArray(arr) || arr.length === 0) {
						copilotDirectChannel.appendLine('rawBody (truncated):');
						copilotDirectChannel.appendLine(truncate(text || '(empty)'));
					}
				} catch (e) {
					copilotDirectChannel.appendLine(`fetch error: ${e instanceof Error ? e.message : String(e)}`);
				}
			};

			// Probe API first (richer model catalog), then proxy (streaming host).
			await probeModels('api', apiBase);
			await probeModels('proxy', proxyBase || 'https://copilot-proxy.githubusercontent.com');

			copilotDirectChannel.appendLine('---');
			copilotDirectChannel.appendLine('Done. If status is 401/403/402, it is usually entitlement or wrong account; if fetch failed, it is network/proxy/DNS.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.copilotDirect.signOut', async () => {
			const confirm = await vscode.window.showWarningMessage(
				'将清除 Tripilot 的 copilot-direct device-flow 登录信息（仅影响 Tripilot，不会退出 VS Code 全局 GitHub 账号）。\n下次使用 copilot-direct 将需要重新登录。',
				{ modal: true },
				'Sign out',
				'取消'
			);
			if (confirm !== 'Sign out') return;

		const deleted = await clearCopilotDirectDeviceFlowSessions(context.secrets);

		try {
			provider.resetCopilotDirectCaches();
		} catch {
			// ignore
		}
		TripilotSettingsPanel.resetCopilotDirectCachesIfOpen();
		clearSettingsModelsCache();

		try {
			await provider.refreshModelsAndPost();
		} catch {
			// ignore
		}

		void vscode.window.showInformationMessage(
			deleted > 0
				? `已清除 Tripilot copilot-direct 登录信息（${deleted} 条）。`
				: '未发现已缓存的 copilot-direct device-flow 登录信息。'
		);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.debug.searchCommands', async () => {
			debugChannel.show(true);
			debugChannel.appendLine(`[searchCommands] ${new Date().toISOString()}`);

			const all = await vscode.commands.getCommands(true);
			const hits = all
				.filter((c) => /language.*model|languageModel|languageModels|modelPicker|picker.*model|chat.*model/i.test(c))
				.sort();

			debugChannel.appendLine(`commands matched: ${hits.length}`);
			for (const c of hits.slice(0, 200)) {
				debugChannel.appendLine(c);
			}
			if (hits.length > 200) {
				debugChannel.appendLine(`... (truncated, showing first 200)`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.debug.copySettingsPerfLog', async () => {
			const defaultLines = 200;
			const raw = await vscode.window.showInputBox({
				title: 'Copy Tripilot Settings Perf Log',
				prompt: '复制最近多少行到剪贴板？',
				value: String(defaultLines),
				validateInput: (v) => {
					const n = Number.parseInt(String(v || ''), 10);
					if (!Number.isFinite(n) || n <= 0) return '请输入一个正整数';
					if (n > 20000) return '行数过大（建议 <= 20000）';
					return undefined;
				}
			});
			if (raw === undefined) return;
			const n = Math.max(1, Number.parseInt(raw, 10) || defaultLines);
			const tail = settingsPerfRing.slice(-n);
			if (tail.length === 0) {
				void vscode.window.showWarningMessage(
					'没有可复制的 Settings Perf 日志。请先启用 tripilot.debug.settingsPerf=true 并复现一次打开 Settings。'
				);
				return;
			}
			await vscode.env.clipboard.writeText(tail.join('\n'));
			try {
				settingsPerfChannel?.show(true);
			} catch {
				// ignore
			}
			void vscode.window.showInformationMessage(`已复制 Settings Perf 最近 ${tail.length} 行到剪贴板。`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.debug.showChatLogView', async () => {
			await provider.showChatLogView();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.chat.open', async () => {
			await provider.openChatView();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.chat.toggle', async () => {
			await provider.toggleChatFocus();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.chat.openInEditor', async () => {
			await provider.openChatInEditorArea();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.chat.openInNewWindow', async () => {
			await provider.openChatInNewWindow();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.chat.resetViewDefaults', async () => {
			await provider.resetViewDefaults();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.quickChat.toggle', async () => {
			await provider.openQuickChat();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.copyModelIdsToClipboard', async () => {
			const lmAnyLocal = (vscode as any).lm;
			if (!lmAnyLocal || typeof lmAnyLocal.selectChatModels !== 'function') {
				vscode.window.showWarningMessage('当前 VS Code 环境不支持 Language Model API（vscode.lm）。');
				return;
			}

			const models = await vscode.lm.selectChatModels();
			const ids = ['auto', ...models.map((m) => m.id)];
			// Ensure uniqueness while keeping order.
			const seen = new Set<string>();
			const uniqueIds = ids.filter((id) => {
				if (seen.has(id)) return false;
				seen.add(id);
				return true;
			});

			const text = JSON.stringify(uniqueIds, null, 2);
			await vscode.env.clipboard.writeText(text);
			vscode.window.showInformationMessage(`已复制 ${uniqueIds.length} 个模型 ID 到剪贴板（包含 auto）。`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.openSettings', async () => {
			TripilotSettingsPanel.show(context, mcpManager);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.exportChatHistory', async () => {
			await provider.exportChatHistoryInteractive();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.chat.newSession', async () => {
			await provider.startNewChatSessionInteractive();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tripilot.chat.selectSession', async () => {
			await provider.selectAndLoadChatSessionInteractive();
		})
	);

	// ── TriLC auto-start (desktop daemon) ──
	void (async () => {
		try {
			const cfg = vscode.workspace.getConfiguration('tripilot');
			const autoStart = cfg.get<boolean>('triLC.autoStart', true);
			if (!autoStart) return;

			const port = cfg.get<number>('triLC.port', 8711);
			const trilcCmd = process.env.TRILC_BIN || 'trilc';

			const child = spawn(trilcCmd, ['start', '--port', String(port)], {
				detached: true,
				stdio: 'ignore',
				shell: process.platform === 'win32'
			});
			triLCPid = child.pid ?? undefined;
			child.unref();

			debugChannel.appendLine(`[TriLC] auto-started on port ${port} (PID ${triLCPid ?? '?'})`);
		} catch (e) {
			debugChannel.appendLine(`[TriLC] auto-start failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	})();
}

function safeToString(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	// Errors stringify to "{}" by default; preserve message/stack.
	try {
		if (value instanceof Error) {
			const msg = String(value.message ?? '').trim();
			const stack = String((value as any).stack ?? '').trim();
			return stack || msg || value.name || 'Error';
		}
		const anyVal: any = value as any;
		if (anyVal && typeof anyVal === 'object' && typeof anyVal.message === 'string') {
			const msg = String(anyVal.message ?? '').trim();
			const name = typeof anyVal.name === 'string' ? String(anyVal.name).trim() : '';
			return [name, msg].filter(Boolean).join(': ') || msg;
		}
	} catch {
		// ignore
	}
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}

function serializeUnknownError(err: unknown): { message: string; name?: string; stack?: string; typeof?: string; keys?: string[] } {
	try {
		if (err instanceof Error) {
			return {
				name: err.name,
				message: String(err.message ?? '') || err.name || 'Error',
				stack: typeof (err as any).stack === 'string' ? String((err as any).stack) : undefined,
				typeof: 'object'
			};
		}
		const t = typeof err;
		if (err && t === 'object') {
			const anyErr: any = err as any;
			const keys = Object.keys(anyErr);
			const name = typeof anyErr.name === 'string' ? String(anyErr.name) : undefined;
			const message = typeof anyErr.message === 'string' ? String(anyErr.message) : safeToString(err);
			const stack = typeof anyErr.stack === 'string' ? String(anyErr.stack) : undefined;
			return { name, message: message || safeToString(err), stack, typeof: t, keys: keys.length ? keys : undefined };
		}
		return { message: safeToString(err), typeof: t };
	} catch {
		return { message: 'Unknown error', typeof: typeof err };
	}
}

function ensureFrontmatterHasVersion(markdown: string, version: string): string {
	const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
	const normalized = markdown.replace(/\r\n/g, '\n');
	const fm = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!fm) {
		const created = `---\nversion: ${version}\n---\n\n${normalized}`;
		return eol === '\n' ? created : created.replace(/\n/g, eol);
	}

	const front = fm[1] ?? '';
	if (/(^|\n)version\s*:/i.test(front)) return markdown;

	const rest = normalized.slice(fm[0].length);
	const nextFront = `${front.replace(/\n+$/g, '')}\nversion: ${version}`;
	const updated = `---\n${nextFront}\n---\n${rest}`;
	return eol === '\n' ? updated : updated.replace(/\n/g, eol);
}

function getHiddenCustomAgentIdsFromConfig(): Set<string> {
	const raw = vscode.workspace.getConfiguration('tripilot').get<string[]>('hiddenCustomAgents', []) ?? [];
	return new Set(raw.map((s) => String(s).trim()).filter(Boolean));
}

async function setHiddenCustomAgentIdsToConfig(ids: string[]): Promise<void> {
	await vscode.workspace.getConfiguration('tripilot').update(
		'hiddenCustomAgents',
		(ids ?? []).map(String).map((s) => s.trim()).filter(Boolean),
		vscode.ConfigurationTarget.Global
	);
}

function stripYamlScalar(value: string): string {
	const v = String(value ?? '').trim();
	if (!v) return '';
	// Remove wrapping quotes.
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

function parseInlineList(raw: string): string[] {
	let text = String(raw ?? '').trim();
	if (!text) return [];
	// Remove surrounding brackets if present.
	if (text.startsWith('[') && text.endsWith(']')) {
		text = text.slice(1, -1);
	}
	return text
		.split(',')
		.map((s) => stripYamlScalar(s))
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseCustomAgentMarkdown(markdown: string): {
	frontmatter: { name?: string; description?: string; tools?: string[]; model?: string };
	body: string;
} {
	const normalized = String(markdown ?? '').replace(/\r\n/g, '\n');
	const fm = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!fm) {
		return { frontmatter: {}, body: normalized };
	}
	const frontText = fm[1] ?? '';
	const body = normalized.slice(fm[0].length);
	const front: any = {};
	const lines = frontText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line || !line.trim() || line.trim().startsWith('#')) continue;
		const m = line.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		const rest = String(m[2] ?? '');
		if (key === 'tools') {
			const trimmed = rest.trim();
			if (!trimmed) {
				const items: string[] = [];
				for (let j = i + 1; j < lines.length; j++) {
					const l = lines[j];
					const mm = l.match(/^\s*-\s+(.*)$/);
					if (!mm) break;
					items.push(stripYamlScalar(mm[1]));
					i = j;
				}
				front.tools = items.map((s) => s.trim()).filter(Boolean);
				continue;
			}
			front.tools = parseInlineList(trimmed);
			continue;
		}
		if (key === 'name') {
			front.name = stripYamlScalar(rest);
			continue;
		}
		if (key === 'description') {
			front.description = stripYamlScalar(rest);
			continue;
		}
		if (key === 'model') {
			front.model = stripYamlScalar(rest);
			continue;
		}
	}
	return { frontmatter: front, body };
}

function makeWorkspaceCustomAgentId(relativePath: string): string {
	const rel = String(relativePath ?? '').replace(/\\/g, '/');
	const noExt = rel
		.replace(/\.agent\.md$/i, '')
		.replace(/\.chatmode\.md$/i, '');
	return `custom:${noExt}`;
}

async function discoverWorkspaceCustomAgents(): Promise<WorkspaceCustomAgentInfo[]> {
	const perfEnabled = isSettingsPerfEnabled();
	const started = perfEnabled ? Date.now() : 0;
	// This scan can be relatively expensive (findFiles + readFile per agent).
	// Keep a short TTL cache to keep Settings opening snappy.
	const TTL_MS = 10_000;
	const TTL_NO_DIR_MS = 5 * 60_000;
	const folderKey = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
	if (
		workspaceCustomAgentsCache &&
		workspaceCustomAgentsCache.folderKey === folderKey &&
		Date.now() - workspaceCustomAgentsCache.atMs < workspaceCustomAgentsCache.ttlMs
	) {
		if (perfEnabled) {
			settingsPerfLog(
				`[settings] discoverWorkspaceCustomAgents cacheHit age=${Date.now() - workspaceCustomAgentsCache.atMs}ms items=${workspaceCustomAgentsCache.items.length}`
			);
		}
		return workspaceCustomAgentsCache.items;
	}
	if (perfEnabled) {
		settingsPerfLog(`[settings] discoverWorkspaceCustomAgents start folder=${folderKey || '(none)'}`);
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return [];

	// Fast path: if the standard directories do not exist, avoid expensive findFiles over the whole workspace.
	// Spec alignment: Custom Agents live under workspaceRoot/.github/agents (and legacy under .github/chatmodes).
	let hasAgentsDir = false;
	let hasChatmodesDir = false;
	try {
		const [a, b] = await Promise.allSettled([
			vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.github', 'agents')),
			vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.github', 'chatmodes'))
		]);
		hasAgentsDir = a.status === 'fulfilled';
		hasChatmodesDir = b.status === 'fulfilled';
	} catch {
		// ignore
	}
	if (!hasAgentsDir && !hasChatmodesDir) {
		workspaceCustomAgentsCache = { folderKey, atMs: Date.now(), ttlMs: TTL_NO_DIR_MS, items: [] };
		if (perfEnabled) {
			settingsPerfLog(`[settings] discoverWorkspaceCustomAgents skip (no .github/agents or .github/chatmodes)  ${Date.now() - started}ms`);
		}
		return [];
	}
	const hidden = getHiddenCustomAgentIdsFromConfig();

	const found: vscode.Uri[] = [];
	if (hasAgentsDir) {
		try {
			found.push(
				...(await vscode.workspace.findFiles(
					new vscode.RelativePattern(folder, '.github/agents/**/*.agent.md'),
					'**/node_modules/**',
					200
				))
			);
		} catch {
			// ignore
		}
	}
	if (hasChatmodesDir) {
		try {
			found.push(
				...(await vscode.workspace.findFiles(
					new vscode.RelativePattern(folder, '.github/chatmodes/**/*.chatmode.md'),
					'**/node_modules/**',
					200
				))
			);
		} catch {
			// ignore
		}
	}

	const uniqueByFsPath = new Map<string, vscode.Uri>();
	for (const u of found) uniqueByFsPath.set(u.fsPath, u);
	const unique = Array.from(uniqueByFsPath.values());

	const items: WorkspaceCustomAgentInfo[] = [];
	for (const uri of unique) {
		let raw = '';
		try {
			raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			continue;
		}
		const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		const { frontmatter, body } = parseCustomAgentMarkdown(raw);
		const baseName = path.posix.basename(relativePath).replace(/\.(agent|chatmode)\.md$/i, '');
		const name = String(frontmatter.name ?? '').trim() || baseName;
		const id = makeWorkspaceCustomAgentId(relativePath);
		items.push({
			id,
			name,
			description: frontmatter.description ? String(frontmatter.description) : undefined,
			tools: Array.isArray(frontmatter.tools) ? frontmatter.tools.map(String) : undefined,
			model: frontmatter.model ? String(frontmatter.model) : undefined,
			relativePath,
			hidden: hidden.has(id),
			isLegacy: /\.chatmode\.md$/i.test(relativePath),
			body: String(body ?? '')
		});
	}

	items.sort((a, b) => a.name.localeCompare(b.name));
	workspaceCustomAgentsCache = { folderKey, atMs: Date.now(), ttlMs: items.length ? TTL_MS : TTL_NO_DIR_MS, items };
	if (perfEnabled) {
		settingsPerfLog(
			`[settings] discoverWorkspaceCustomAgents done ${Date.now() - started}ms files=${unique.length} items=${items.length}`
		);
	}
	return items;
}

let workspaceCustomAgentsCache:
	| { folderKey: string; atMs: number; ttlMs: number; items: WorkspaceCustomAgentInfo[] }
	| undefined;

function invalidateWorkspaceCustomAgentsCache(): void {
	workspaceCustomAgentsCache = undefined;
}

let triLCPid: number | undefined;

export function deactivate() {
	// TriLC cleanup: attempt to stop the auto-started daemon
	if (triLCPid !== undefined) {
		try {
			const { execFile } = require('node:child_process');
			const trilcCmd = process.env.TRILC_BIN || 'trilc';
			execFile(trilcCmd, ['stop'], { timeout: 5000, windowsHide: true }, () => {});
		} catch {
			// best-effort
		}
	}
}

function readMcpServersFromConfig(): McpServerConfig[] {
	const raw = vscode.workspace.getConfiguration('tripilot').get<any[]>('mcpServers', []) ?? [];
	return raw
		.map((s) => ({
			id: String(s?.id ?? '').trim(),
			name: String(s?.name ?? '').trim(),
			enabled: Boolean(s?.enabled),
			transport: String(s?.transport ?? 'stdio') as any,
			command: s?.command ? String(s.command) : undefined,
			args: Array.isArray(s?.args) ? s.args.map(String) : undefined,
			cwd: s?.cwd ? String(s.cwd) : undefined,
			env: s?.env && typeof s.env === 'object' ? (s.env as any) : undefined,
			url: s?.url ? String(s.url) : undefined
		}))
		.filter((s) => s.id && s.name);
}

type AgentProfileConfig = {
	id: string;
	name: string;
	enabledBuiltinTools?: string[];
	enabledCommandTools?: string[];
	enabledMcpServers?: string[];
	editsEnableHealing?: boolean;
};

const DEFAULT_AGENT_PROFILES: AgentProfileConfig[] = [
	{
		id: 'ask-study',
		name: 'ask&study',
		// In ask&study we rely on sandbox enforcement rather than a small builtin whitelist.
		// Command tools + MCP remain restricted by allowlists at runtime.
		enabledCommandTools: [],
		enabledMcpServers: []
	},
	{ id: 'edit-test', name: 'edit&test' },
	{ id: 'agent-vm', name: 'agent&vm' },
	{
		id: 'agent-deploy',
		name: 'agent&deploy'
	}
];

function getDefaultAgentProfileId(): string {
	return 'agent-vm';
}

function readAgentProfilesFromConfig(): AgentProfileConfig[] {
	const raw = vscode.workspace.getConfiguration('tripilot').get<any[]>('agentProfiles', []) ?? [];
	return raw
		.map((p) => ({
			id: String(p?.id ?? '').trim(),
			name: String(p?.name ?? '').trim(),
			enabledBuiltinTools: Array.isArray(p?.enabledBuiltinTools) ? p.enabledBuiltinTools.map(String) : undefined,
			enabledCommandTools: Array.isArray(p?.enabledCommandTools) ? p.enabledCommandTools.map(String) : undefined,
			enabledMcpServers: Array.isArray(p?.enabledMcpServers) ? p.enabledMcpServers.map(String) : undefined,
			editsEnableHealing: p?.editsEnableHealing === undefined ? undefined : Boolean(p.editsEnableHealing)
		}))
		.filter((p) => p.id && p.name);
}

async function writeAgentProfilesToConfig(next: AgentProfileConfig[]) {
	await vscode.workspace
		.getConfiguration('tripilot')
		.update('agentProfiles', next, vscode.ConfigurationTarget.Global);
}

function getAgentProfilesMerged(): AgentProfileConfig[] {
	const custom = readAgentProfilesFromConfig();
	const byId = new Map<string, AgentProfileConfig>();
	for (const p of DEFAULT_AGENT_PROFILES) byId.set(p.id, { ...p });
	for (const p of custom) {
		const base = byId.get(p.id);
		byId.set(p.id, base ? { ...base, ...p } : { ...p });
	}
	return Array.from(byId.values());
}

function getAgentProfileMerged(id: string): AgentProfileConfig {
	const normalized = String(id || '').trim() || getDefaultAgentProfileId();
	return (
		getAgentProfilesMerged().find((p) => p.id === normalized) ??
		DEFAULT_AGENT_PROFILES.find((p) => p.id === 'agent-vm') ??
		DEFAULT_AGENT_PROFILES[0]
	);
}

async function upsertAgentProfile(profile: AgentProfileConfig): Promise<void> {
	const id = String(profile?.id ?? '').trim();
	const name = String(profile?.name ?? '').trim();
	if (!id || !name) return;
	const current = readAgentProfilesFromConfig();
	const next = current.filter((p) => p.id !== id);
	next.push({
		id,
		name,
		enabledBuiltinTools: profile.enabledBuiltinTools,
		enabledCommandTools: profile.enabledCommandTools,
		enabledMcpServers: profile.enabledMcpServers,
		editsEnableHealing: profile.editsEnableHealing
	});
	await writeAgentProfilesToConfig(next);
}

async function removeAgentProfile(profileId: string): Promise<void> {
	const id = String(profileId ?? '').trim();
	if (!id) return;
	// Protect built-in profiles.
	if (DEFAULT_AGENT_PROFILES.some((p) => p.id === id)) return;
	const current = readAgentProfilesFromConfig();
	await writeAgentProfilesToConfig(current.filter((p) => p.id !== id));
}


async function setAgentProfileOptionalTools(profileId: string, enabledOptionalTools: Set<string>): Promise<void> {
	const id = String(profileId ?? '').trim() || getDefaultAgentProfileId();
	const baseProfile = getAgentProfileMerged(id);
	// Important: do NOT pass a defaultValue here; it can mask extension-contributed defaults.
	const raw = vscode.workspace.getConfiguration('tripilot').get<any>('enabledBuiltinTools');
	const arr = Array.isArray(raw) ? raw : [];
	const normalized = arr.map((s) => String(s).trim()).filter(Boolean);
	const globalEnabled = new Set<string>(normalized.length ? normalized : Array.from(OPTIONAL_TOOL_NAMES));
	const currentEnabled = new Set(
		Array.isArray(baseProfile.enabledBuiltinTools) ? baseProfile.enabledBuiltinTools.map(String) : Array.from(globalEnabled)
	);

	// Guard against legacy UI/tool names: only apply changes for recognized optional tool ids.
	// If the caller passes a non-empty set but none of them are recognized, ignore to avoid wiping tool config.
	const recognized = new Set<string>();
	for (const n of enabledOptionalTools) {
		if (OPTIONAL_TOOL_NAMES.has(n)) recognized.add(n);
	}
	if (enabledOptionalTools.size > 0 && recognized.size === 0) {
		return;
	}
	for (const name of OPTIONAL_TOOL_NAMES) {
		if (recognized.has(name)) currentEnabled.add(name);
		else currentEnabled.delete(name);
	}
	await upsertAgentProfile({ ...baseProfile, id, enabledBuiltinTools: Array.from(currentEnabled) });
}

type SettingsInboundMessage =
	| { type: 'webviewReady' }
	| { type: 'refreshModels' }
	| { type: 'copilotDirectRefreshAuthStatus' }
	| { type: 'copilotDirectRelogin'; authMode: 'minimal' | 'permissive' }
	| { type: 'copilotDirectSignOut' }
	| { type: 'toggleModel'; id: string; enabled: boolean }
	| { type: 'refreshToolsAndMcp' }
	| { type: 'refreshCustomAgents' }
	| { type: 'setFollowChatProfile'; enabled: boolean }
	| { type: 'setSyncChatProfileFromSettings'; enabled: boolean }
	| { type: 'setEditsEnableHealing'; enabled: boolean }
	| { type: 'setAgentProfileEditsEnableHealing'; id: string; mode: 'inherit' | 'on' | 'off' }
	| { type: 'createWorkspaceCustomAgent'; fileBaseName: string }
	| { type: 'openWorkspaceCustomAgent'; id: string }
	| { type: 'deleteWorkspaceCustomAgent'; id: string }
	| { type: 'setWorkspaceCustomAgentHidden'; id: string; hidden: boolean }
	| { type: 'setActiveAgentProfile'; id: string }
	| { type: 'addAgentProfile'; profile: AgentProfileConfig }
	| { type: 'removeAgentProfile'; id: string }
	| { type: 'discoverCommands'; query: string }
	| { type: 'setBuiltinToolEnabled'; name: string; enabled: boolean }
	| { type: 'addCommandTool'; tool: CommandToolConfig }
	| { type: 'removeCommandTool'; name: string }
	| { type: 'setCommandToolEnabled'; name: string; enabled: boolean }
	| { type: 'upsertMcpServer'; server: McpServerConfig }
	| { type: 'removeMcpServer'; id: string }
	| { type: 'setMcpServerEnabled'; id: string; enabled: boolean };

type CopilotDirectAuthStatus = {
	authMode: 'minimal' | 'permissive';
	preferredSource?: 'vscode-auth' | 'device-flow';
	preferredAccountLabel?: string;
	tokenUrlOverrideEnabled: boolean;
	tokenUrlOverride?: string;
	vscodeAuthAvailable: boolean;
	vscodeAuthHasSession?: boolean;
	vscodeAuthAccountLabel?: string;
	vscodeAuthError?: string;
	deviceFlowEnabled: boolean;
	deviceFlowClientIdConfigured: boolean;
	deviceFlowHasCachedToken: boolean;
	deviceFlowAccountLabel?: string;
	deviceFlowUpdatedAtMs?: number;
	updatedAtMs: number;
};

type SettingsOutboundMessage =
	| {
				type: 'init';
				initialPage?: 'models' | 'tools' | 'customAgents';
				modelsStatus?: string;
				models: LmModelInfo[];
				visibleModelIds: string[];
				copilotDirectAuthStatus?: CopilotDirectAuthStatus;
				editsEnableHealing?: boolean;
				agentProfiles: AgentProfileConfig[];
				activeAgentProfileId: string;
				followChatProfile?: boolean;
				syncChatProfileFromSettings?: boolean;
				builtinTools: Array<{ name: string; enabled: boolean }>;
				builtinToolCategories?: Record<string, string>;
				commandTools: CommandToolConfig[];
				mcpServers: McpServerStatus[];
				customAgents: WorkspaceCustomAgentInfo[];
		  }
	| {
				type: 'update';
				modelsStatus?: string;
				models?: LmModelInfo[];
				visibleModelIds?: string[];
				copilotDirectAuthStatus?: CopilotDirectAuthStatus;
				editsEnableHealing?: boolean;
				agentProfiles?: AgentProfileConfig[];
				activeAgentProfileId?: string;
				followChatProfile?: boolean;
				syncChatProfileFromSettings?: boolean;
				builtinTools?: Array<{ name: string; enabled: boolean }>;
				builtinToolCategories?: Record<string, string>;
				commandTools?: CommandToolConfig[];
				mcpServers?: McpServerStatus[];
				customAgents?: WorkspaceCustomAgentInfo[];
		  }
	| { type: 'setPage'; page: 'models' | 'tools' | 'customAgents' }
	| { type: 'discoveredCommands'; commands: string[] };

type CommandToolConfig = { name: string; command: string; description?: string; enabled: boolean };

class TripilotSettingsPanel {
	public static readonly viewType = 'tripilot.settings';
	private static current?: TripilotSettingsPanel;
	private static currentManager?: McpClientManager;
	private initialPage: 'models' | 'tools' | 'customAgents' = 'models';
	private activeAgentProfileId: string = getDefaultAgentProfileId();
	private builtinToolCategoriesCache?: Record<string, string>;
	private readonly copilotTokenManager: CopilotTokenManager;
	private readonly copilotClient: CopilotDirectClient;
	private readonly modelsDirectClient: ModelsDirectClient;
	private readonly openedAtMs = Date.now();
	private perfSeq = 0;

	private static readonly FOLLOW_CHAT_PROFILE_KEY = 'tripilot.settings.followChatProfile';
	private static readonly SYNC_CHAT_PROFILE_FROM_SETTINGS_KEY = 'tripilot.settings.syncChatProfileFromSettings';

	private getEditsEnableHealing(): boolean {
		return !!vscode.workspace.getConfiguration('tripilot').get<boolean>('edits.enableHealing', false);
	}

	private perfPrefix(): string {
		return `+${Date.now() - this.openedAtMs}ms`;
	}

	private perfLog(msg: string): void {
		if (!isSettingsPerfEnabled()) return;
		settingsPerfLog(`[settings] ${msg} ${this.perfPrefix()}`);
	}

	private async timePromise<T>(label: string, promise: Promise<T>): Promise<T> {
		if (!isSettingsPerfEnabled()) return promise;
		const id = ++this.perfSeq;
		const start = Date.now();
		settingsPerfLog(`[settings#${id}] ${label} start +${start - this.openedAtMs}ms`);
		try {
			const result = await promise;
			settingsPerfLog(`[settings#${id}] ${label} ok ${Date.now() - start}ms`);
			return result;
		} catch (e) {
			settingsPerfLog(
				`[settings#${id}] ${label} err ${Date.now() - start}ms: ${e instanceof Error ? e.message : String(e)}`
			);
			throw e;
		}
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly mcpManager: McpClientManager,
		private readonly extensionVersion: string,
		initialPage?: 'models' | 'tools' | 'customAgents'
	) {
		this.initialPage = initialPage ?? 'models';
		settingsPerfLog(`[settings] open initialPage=${this.initialPage}`);
		if (isSettingsPerfEnabled()) {
			try {
				settingsPerfChannel?.show(true);
			} catch {
				// ignore
			}
		}
		this.copilotTokenManager = new CopilotTokenManager(this.extensionVersion, () => this.getCopilotAuthMode(), this.context.secrets);
		this.copilotClient = new CopilotDirectClient(this.extensionVersion, `vscode/${vscode.version}`);
		this.modelsDirectClient = new ModelsDirectClient(this.extensionVersion, `vscode/${vscode.version}`);

		this.panel.onDidDispose(() => {
			if (TripilotSettingsPanel.current === this) {
				TripilotSettingsPanel.current = undefined;
			}
			try {
				this.copilotTokenManager.dispose();
			} catch {
				// ignore
			}
		});

		this.panel.webview.onDidReceiveMessage(async (msg: SettingsInboundMessage) => {
			switch (msg.type) {
				case 'webviewReady':
					settingsPerfLog(`[settings] webviewReady +${Date.now() - this.openedAtMs}ms`);
					await this.refreshAndPost(true);
					return;
				case 'copilotDirectRefreshAuthStatus':
					this.post({ type: 'update', copilotDirectAuthStatus: await this.getCopilotDirectAuthStatus() });
					return;
				case 'copilotDirectRelogin': {
					const mode = msg.authMode === 'permissive' ? 'permissive' : 'minimal';
					const confirm = await vscode.window.showWarningMessage(
						`将清除 Tripilot 的 copilot-direct 登录缓存并重新登录（${mode}）。`,
						{ modal: true },
						'继续',
						'取消'
					);
					if (confirm !== '继续') return;

					await clearCopilotDirectDeviceFlowSessions(this.context.secrets, mode);
					this.resetCopilotDirectCaches();
					clearSettingsModelsCache();

					try {
						const sess = await getGitHubSession(mode, {
							clearSessionPreference: true,
							secretStorage: this.context.secrets
						});
						void vscode.window.showInformationMessage(
							`signed in${sess.accountLabel ? `: ${sess.accountLabel}` : ''}${sess.source ? ` (${sess.source})` : ''}`
						);
					} catch (e) {
						void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
					}

					await this.refreshAndPost(false);
					return;
				}
				case 'copilotDirectSignOut': {
					const confirm = await vscode.window.showWarningMessage(
						'将清除 Tripilot 的 copilot-direct device-flow 登录信息（仅影响 Tripilot，不会退出 VS Code 全局 GitHub 账号）。',
						{ modal: true },
						'Sign out',
						'取消'
					);
					if (confirm !== 'Sign out') return;
					await clearCopilotDirectDeviceFlowSessions(this.context.secrets);
					this.resetCopilotDirectCaches();
					clearSettingsModelsCache();
					await this.refreshAndPost(false);
					return;
				}
				case 'refreshModels':
					clearSettingsModelsCache();
					await this.refreshAndPost(false);
					return;
				case 'toggleModel':
					await this.toggleModel(msg.id, msg.enabled);
					return;
				case 'refreshToolsAndMcp':
					await this.mcpManager.refresh(this.getEffectiveMcpServersConfig(this.activeAgentProfileId));
					await this.refreshAndPost(false);
					return;
				case 'refreshCustomAgents':
					await this.refreshAndPost(false);
					return;
				case 'setFollowChatProfile': {
					const enabled = !!msg.enabled;
					await this.context.globalState.update(TripilotSettingsPanel.FOLLOW_CHAT_PROFILE_KEY, enabled);
					this.post({ type: 'update', followChatProfile: enabled });
					if (enabled) {
						const chatProfileId =
							String(this.context.globalState.get<string>('tripilot.selectedAgentProfileId') ?? '').trim() ||
							getDefaultAgentProfileId();
						await this.applyChatProfileIfFollowing(chatProfileId);
					}
					return;
				}
				case 'setSyncChatProfileFromSettings': {
					const enabled = !!msg.enabled;
					await this.context.globalState.update(TripilotSettingsPanel.SYNC_CHAT_PROFILE_FROM_SETTINGS_KEY, enabled);
					this.post({ type: 'update', syncChatProfileFromSettings: enabled });
					return;
				}
				case 'setEditsEnableHealing': {
					const enabled = !!msg.enabled;
					await vscode.workspace
						.getConfiguration('tripilot')
						.update('edits.enableHealing', enabled, vscode.ConfigurationTarget.Global);
					this.post({ type: 'update', editsEnableHealing: this.getEditsEnableHealing() });
					return;
				}
				case 'setAgentProfileEditsEnableHealing': {
					const id = String(msg.id ?? '').trim() || getDefaultAgentProfileId();
					const mode = msg.mode === 'on' ? 'on' : msg.mode === 'off' ? 'off' : 'inherit';
					const base = getAgentProfileMerged(id);
					const editsEnableHealing = mode === 'inherit' ? undefined : mode === 'on';
					await upsertAgentProfile({ ...base, id, editsEnableHealing });
					await this.refreshAndPost(false);
					return;
				}
				case 'createWorkspaceCustomAgent': {
					const base = String(msg.fileBaseName ?? '').trim();
					if (!base) return;
					const folder = vscode.workspace.workspaceFolders?.[0];
					if (!folder) return;
					const safeBase = base.replace(/[^A-Za-z0-9_.\-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
					if (!safeBase) return;
					const dir = vscode.Uri.joinPath(folder.uri, '.github', 'agents');
					await vscode.workspace.fs.createDirectory(dir);
					let fileUri = vscode.Uri.joinPath(dir, `${safeBase}.agent.md`);
					for (let i = 2; i < 50; i++) {
						try {
							await vscode.workspace.fs.stat(fileUri);
							fileUri = vscode.Uri.joinPath(dir, `${safeBase}-${i}.agent.md`);
						} catch {
							break;
						}
					}
					const template = `---\nname: ${safeBase}\ndescription: Describe what this agent does.\ntools: []\n---\n\n# Instructions\n\nDescribe the agent behavior and workflow here.\n`;
					await vscode.workspace.fs.writeFile(fileUri, Buffer.from(template, 'utf8'));
					invalidateWorkspaceCustomAgentsCache();
					try {
						const doc = await vscode.workspace.openTextDocument(fileUri);
						await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
					} catch {
						// ignore
					}
					await this.refreshAndPost(false);
					return;
				}
				case 'openWorkspaceCustomAgent': {
					const id = String(msg.id ?? '').trim();
					if (!id) return;
					const agents = await discoverWorkspaceCustomAgents();
					const picked = agents.find((a) => a.id === id);
					if (!picked) return;
					const folder = vscode.workspace.workspaceFolders?.[0];
					if (!folder) return;
					const uri = vscode.Uri.joinPath(folder.uri, ...picked.relativePath.split('/'));
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
					return;
				}
				case 'deleteWorkspaceCustomAgent': {
					const id = String(msg.id ?? '').trim();
					if (!id) return;
					const agents = await discoverWorkspaceCustomAgents();
					const picked = agents.find((a) => a.id === id);
					if (!picked) return;
					const ok = await vscode.window.showWarningMessage(
						`删除 Custom Agent 文件？\n${picked.relativePath}`,
						{ modal: true },
						'删除'
					);
					if (ok !== '删除') return;
					const folder = vscode.workspace.workspaceFolders?.[0];
					if (!folder) return;
					const uri = vscode.Uri.joinPath(folder.uri, ...picked.relativePath.split('/'));
					await vscode.workspace.fs.delete(uri);
					invalidateWorkspaceCustomAgentsCache();
					// Also ensure hidden flag is cleared.
					const hidden = getHiddenCustomAgentIdsFromConfig();
					hidden.delete(id);
					await setHiddenCustomAgentIdsToConfig(Array.from(hidden));
					await this.refreshAndPost(false);
					return;
				}
				case 'setWorkspaceCustomAgentHidden': {
					const id = String(msg.id ?? '').trim();
					if (!id) return;
					const hidden = getHiddenCustomAgentIdsFromConfig();
					if (msg.hidden) hidden.add(id);
					else hidden.delete(id);
					await setHiddenCustomAgentIdsToConfig(Array.from(hidden));
					invalidateWorkspaceCustomAgentsCache();
					await this.refreshAndPost(false);
					return;
				}
				case 'setActiveAgentProfile':
					this.activeAgentProfileId = String(msg.id ?? '').trim() || getDefaultAgentProfileId();
					await this.refreshAndPost(false);
					if (this.getSyncChatProfileFromSettings()) {
						TripilotChatViewProvider.trySyncChatProfileFromSettings(this.activeAgentProfileId);
					}
					return;
				case 'addAgentProfile':
					await upsertAgentProfile(msg.profile);
					this.post({ type: 'update', agentProfiles: getAgentProfilesMerged() });
					return;
				case 'removeAgentProfile':
					await removeAgentProfile(msg.id);
					this.post({ type: 'update', agentProfiles: getAgentProfilesMerged() });
					return;
				case 'discoverCommands': {
					const query = String(msg.query ?? '').trim().toLowerCase();
					const all = await vscode.commands.getCommands(true);
					const filtered = query
						? all.filter((id) => String(id).toLowerCase().includes(query))
						: all;
					// Keep results bounded for webview perf.
					this.post({ type: 'discoveredCommands', commands: filtered.slice(0, 200) });
					return;
				}
				case 'setBuiltinToolEnabled':
					await this.setBuiltinToolEnabled(msg.name, msg.enabled);
					return;
				case 'addCommandTool':
					await this.addCommandTool(msg.tool);
					return;
				case 'removeCommandTool':
					await this.removeCommandTool(msg.name);
					return;
				case 'setCommandToolEnabled':
					await this.setCommandToolEnabled(msg.name, msg.enabled);
					return;
				case 'upsertMcpServer':
					await this.upsertMcpServer(msg.server);
					return;
				case 'removeMcpServer':
					await this.removeMcpServer(msg.id);
					return;
				case 'setMcpServerEnabled':
					await this.setMcpServerEnabled(msg.id, msg.enabled);
					return;
			}
		});
	}

	private getFollowChatProfile(): boolean {
		try {
			const raw = this.context.globalState.get<boolean>(TripilotSettingsPanel.FOLLOW_CHAT_PROFILE_KEY);
			return raw === undefined ? true : !!raw;
		} catch {
			return true;
		}
	}

	private getSyncChatProfileFromSettings(): boolean {
		try {
			const raw = this.context.globalState.get<boolean>(TripilotSettingsPanel.SYNC_CHAT_PROFILE_FROM_SETTINGS_KEY);
			return raw === undefined ? false : !!raw;
		} catch {
			return false;
		}
	}

	private postToolsSnapshotUpdate(): void {
		const activeAgentProfileId = this.activeAgentProfileId;
		const builtinTools = this.getBuiltinToolsState(activeAgentProfileId);
		const commandTools = this.getCommandTools(activeAgentProfileId);
		const mcpConfigs = this.getEffectiveMcpServersConfig(activeAgentProfileId);
		const mcpServers = this.mcpManager.getStatuses(mcpConfigs);
		this.post({
			type: 'update',
			activeAgentProfileId,
			agentProfiles: getAgentProfilesMerged(),
			builtinTools,
			commandTools,
			mcpServers
		});
	}

	private async applyChatProfileIfFollowing(chatProfileId: string): Promise<void> {
		const id = String(chatProfileId ?? '').trim();
		if (!id) return;
		if (!this.getFollowChatProfile()) return;
		if (this.activeAgentProfileId === id) return;
		this.activeAgentProfileId = id;
		this.postToolsSnapshotUpdate();
	}

	public resetCopilotDirectCaches(): void {
		try {
			this.copilotTokenManager.reset();
		} catch {
			// ignore
		}
	}

	public static resetCopilotDirectCachesIfOpen(): void {
		try {
			TripilotSettingsPanel.current?.resetCopilotDirectCaches();
		} catch {
			// ignore
		}
	}

	public static show(
		context: vscode.ExtensionContext,
		mcpManager: McpClientManager,
		initialPage: 'models' | 'tools' | 'customAgents' = 'models',
		options?: { fromChat?: boolean; agentProfileId?: string }
	) {
		const perfEnabled = isSettingsPerfEnabled();
		const started = perfEnabled ? Date.now() : 0;
		if (perfEnabled) {
			settingsPerfLog(`[settings] show start initialPage=${initialPage}`);
		}
		if (TripilotSettingsPanel.current) {
			TripilotSettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
			TripilotSettingsPanel.current.initialPage = initialPage;
			if (options?.fromChat && options.agentProfileId) {
				void TripilotSettingsPanel.current.applyChatProfileIfFollowing(options.agentProfileId);
			}
			try {
				TripilotSettingsPanel.current.post({ type: 'setPage', page: initialPage });
			} catch {
				// ignore
			}
			if (perfEnabled) {
				settingsPerfLog(`[settings] show reuse existing ${Date.now() - started}ms`);
			}
			return;
		}

		let tCreate = 0;
		if (perfEnabled) tCreate = Date.now();
		const panel = vscode.window.createWebviewPanel(
			TripilotSettingsPanel.viewType,
			'Tripilot Settings',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [context.extensionUri]
			}
		);
		if (perfEnabled) {
			settingsPerfLog(`[settings] show createWebviewPanel ${Date.now() - tCreate}ms`);
		}

		const extensionVersion = String((context as any)?.extension?.packageJSON?.version ?? '0.0.0');
		const instance = new TripilotSettingsPanel(panel, context, mcpManager, extensionVersion, initialPage);
		if (options?.fromChat && options.agentProfileId) {
			void instance.applyChatProfileIfFollowing(options.agentProfileId);
		}
		TripilotSettingsPanel.current = instance;
		TripilotSettingsPanel.currentManager = mcpManager;
		let tHtml = 0;
		if (perfEnabled) tHtml = Date.now();
		panel.webview.html = instance.getHtml(panel.webview);
		if (perfEnabled) {
			settingsPerfLog(`[settings] show setHtml ${Date.now() - tHtml}ms total=${Date.now() - started}ms`);
		}
	}

	public static syncActiveAgentProfileFromChat(agentProfileId: string): void {
		try {
			void TripilotSettingsPanel.current?.applyChatProfileIfFollowing(agentProfileId);
		} catch {
			// ignore
		}
	}

	private getChatProvider(): 'vscode-lm' | 'copilot-direct' | 'models-direct' {
		const raw = String(vscode.workspace.getConfiguration('tripilot').get<string>('chatProvider', 'vscode-lm') ?? 'vscode-lm');
		if (raw === 'copilot-direct') return 'copilot-direct';
		if (raw === 'models-direct') return 'models-direct';
		return 'vscode-lm';
	}

	private getModelsDirectConfig(): {
		baseUrl: string;
		apiKey?: string;
		defaultModel?: string;
		modelTagDefault?: string;
		modelTags?: Record<string, string>;
		modelExtras?: Record<string, any>;
		extraFieldName?: string;
	} {
		const cfg = vscode.workspace.getConfiguration('tripilot');
		const baseUrl = String(cfg.get<string>('modelsDirect.baseUrl', '') ?? '').trim();
		const apiKey = String(cfg.get<string>('modelsDirect.apiKey', '') ?? '').trim();
		const defaultModel = String(cfg.get<string>('modelsDirect.defaultModel', '') ?? '').trim();
		const modelTagDefault = String(cfg.get<string>('modelsDirect.modelTagDefault', '') ?? '').trim();
		const extraFieldName = String(cfg.get<string>('modelsDirect.extraFieldName', 'tripilot') ?? 'tripilot').trim();
		const modelTagsRaw = cfg.get<any>('modelsDirect.modelTags', undefined);
		const modelExtrasRaw = cfg.get<any>('modelsDirect.modelExtras', undefined);
		const modelTags = modelTagsRaw && typeof modelTagsRaw === 'object' ? (modelTagsRaw as Record<string, string>) : undefined;
		const modelExtras = modelExtrasRaw && typeof modelExtrasRaw === 'object' ? (modelExtrasRaw as Record<string, any>) : undefined;
		return {
			baseUrl,
			apiKey: apiKey || undefined,
			defaultModel: defaultModel || undefined,
			modelTagDefault: modelTagDefault || undefined,
			modelTags,
			modelExtras,
			extraFieldName: extraFieldName || undefined
		};
	}

	private getCopilotAuthMode(): 'minimal' | 'permissive' {
		const raw = String(
			vscode.workspace.getConfiguration('tripilot').get<string>('copilotDirect.authMode', 'minimal') ?? 'minimal'
		);
		return raw === 'permissive' ? 'permissive' : 'minimal';
	}

	public static refreshIfOpen() {
		try {
			void TripilotSettingsPanel.current?.refreshAndPost(false);
		} catch {
			// ignore
		}
	}

	private post(msg: SettingsOutboundMessage) {
		if (isSettingsPerfEnabled()) {
			try {
				const keys = Object.keys(msg as any)
					.filter((k) => k !== 'type')
					.join(',');
				settingsPerfLog(`[settings] post type=${(msg as any).type}${keys ? ` keys=${keys}` : ''} ${this.perfPrefix()}`);
			} catch {
				// ignore
			}
		}
		this.panel.webview.postMessage(msg);
	}

	private getVisibleModelIds(): string[] {
		const ids = vscode.workspace.getConfiguration('tripilot').get<string[]>('visibleModelIds', []) ?? [];
		return ids.map((s) => String(s).trim()).filter(Boolean);
	}

	private async computeModelsStatus(models: LmModelInfo[]): Promise<string> {
		const provider = this.getChatProvider();
		const parts: string[] = [];
		if (provider) parts.push(provider);
		if (!Array.isArray(models) || !models.length) return parts.join(' · ');

		if (provider === 'vscode-lm') {
			const real = models.filter((m) => m && m.id !== 'auto');
			const runtimeCount = models.length;
			const openrouterCount = real.filter((m) => /openrouter/i.test(String(m.vendor || ''))).length;
			const vscdbVisible = await tryReadVscodeChatVisibleModelIdsFromStateDb({ context: this.context });
			const hostVisibleSource: 'vscdb.cachedLanguageModels' | 'heuristic' | 'none' = vscdbVisible?.ids?.size
				? 'vscdb.cachedLanguageModels'
				: 'heuristic';
			const hostVisibleRealCount = vscdbVisible?.ids?.size ? real.filter((m) => vscdbVisible.ids.has(m.id)).length : real.length;
			// Match chat menu behavior: Auto is always shown.
			const shownCount = 1 + hostVisibleRealCount;
			parts.push(`v=${hostVisibleSource}`);
			parts.push(`runtime=${runtimeCount}`);
			parts.push(`hostVisible=${shownCount}`);
			parts.push(`openrouter=${openrouterCount}`);
			parts.push(`shown=${shownCount}`);
			return parts.join(' · ');
		}

		// For remote catalogs, keep it simple.
		parts.push(`models=${models.length}`);
		return parts.join(' · ');
	}

	private async setVisibleModelIds(ids: string[]) {
		await vscode.workspace
			.getConfiguration('tripilot')
			.update('visibleModelIds', ids, vscode.ConfigurationTarget.Global);
	}

	private async toggleModel(id: string, enabled: boolean) {
		const normalizedId = String(id);
		const current = this.getVisibleModelIds();
		const set = new Set(current);
		if (enabled) set.add(normalizedId);
		else set.delete(normalizedId);

		const next = Array.from(set);
		if (next.length === 0) {
			// Keep at least one model enabled to avoid a broken picker.
			set.add('auto');
			await this.setVisibleModelIds(Array.from(set));
			vscode.window.showInformationMessage('至少需要启用一个模型；已自动启用 Auto。');
		} else {
			await this.setVisibleModelIds(next);
		}

		this.post({ type: 'update', visibleModelIds: this.getVisibleModelIds() });
	}

	private getAutoModelInfo(): LmModelInfo {
		return {
			id: 'auto',
			name: 'Auto',
			vendor: 'tripilot',
			family: 'auto',
			version: 'auto',
			maxInputTokens: 0
		};
	}

	private async refreshAndPost(first: boolean) {
		const refreshId = ++this.perfSeq;
		const refreshStart = Date.now();
		if (isSettingsPerfEnabled()) {
			settingsPerfLog(
				`[settings#${refreshId}] refreshAndPost first=${first} page=${this.initialPage} start +${refreshStart - this.openedAtMs}ms`
			);
		}

		const visibleModelIds = this.getVisibleModelIds();
		const modelsPromise = this.timePromise('getAllModelsForSettings', this.getAllModelsForSettings());
		const authStatusPromise = this.timePromise('getCopilotDirectAuthStatus', this.getCopilotDirectAuthStatus());
		const agentProfiles = getAgentProfilesMerged();
		const activeAgentProfileId = this.activeAgentProfileId;
		const followChatProfile = this.getFollowChatProfile();
		const syncChatProfileFromSettings = this.getSyncChatProfileFromSettings();
		const editsEnableHealing = this.getEditsEnableHealing();
		const builtinTools = this.getBuiltinToolsState(activeAgentProfileId);
		const commandTools = this.getCommandTools(activeAgentProfileId);
		const mcpConfigs = this.getEffectiveMcpServersConfig(activeAgentProfileId);
		const mcpServers = this.mcpManager.getStatuses(mcpConfigs);

		// Fast path: when opening Settings on the Models page, avoid blocking first paint
		// on expensive workspace scans (custom agents) and reference directory reads.
		const fastInit = first && this.initialPage === 'models';
		if (isSettingsPerfEnabled()) {
			settingsPerfLog(`[settings#${refreshId}] fastInit=${fastInit} ${this.perfPrefix()}`);
		}
		if (fastInit) {
			// Post quickly with Auto model, then update models when discovery completes.
			const copilotDirectAuthStatus = await authStatusPromise;
			const models = [this.getAutoModelInfo()];
			this.post({
				type: 'init',
				initialPage: this.initialPage,
				modelsStatus: `${this.getChatProvider()} · loading…`,
				models,
				visibleModelIds,
				copilotDirectAuthStatus,
				editsEnableHealing,
				agentProfiles,
				activeAgentProfileId,
				followChatProfile,
				syncChatProfileFromSettings,
				builtinTools,
				// Tools page will fill these in shortly.
				builtinToolCategories: {},
				commandTools,
				mcpServers,
				// Custom agents page will fill these in shortly.
				customAgents: []
			});
			if (isSettingsPerfEnabled()) {
				settingsPerfLog(`[settings#${refreshId}] init posted total=${Date.now() - refreshStart}ms ${this.perfPrefix()}`);
			}

			void (async () => {
				try {
					const full = await modelsPromise;
					const modelsStatus = await this.computeModelsStatus(full);
					this.post({ type: 'update', models: full, modelsStatus });
				} catch {
					// ignore
				}
			})();

			void (async () => {
				try {
					const bgStart = Date.now();
					this.perfLog(`backgroundUpdate start`);
					const [builtinToolCategories, customAgents] = await Promise.all([
						this.timePromise('getBuiltinToolCategories', this.getBuiltinToolCategories()),
						this.timePromise('discoverWorkspaceCustomAgents', discoverWorkspaceCustomAgents())
					]);
					this.post({ type: 'update', builtinToolCategories, customAgents });
					if (isSettingsPerfEnabled()) {
						settingsPerfLog(
							`[settings] backgroundUpdate posted ${Date.now() - bgStart}ms ${this.perfPrefix()}`
						);
					}
				} catch {
					// ignore
				}
			})();
			return;
		}

		const [models, copilotDirectAuthStatus, builtinToolCategories, customAgents] = await Promise.all([
			modelsPromise,
			authStatusPromise,
			this.timePromise('getBuiltinToolCategories', this.getBuiltinToolCategories()),
			this.timePromise('discoverWorkspaceCustomAgents', discoverWorkspaceCustomAgents())
		]);
		const modelsStatus = await this.computeModelsStatus(models);
		this.post(
			first
				? {
						type: 'init',
						initialPage: this.initialPage,
					modelsStatus,
						models,
						visibleModelIds,
						copilotDirectAuthStatus,
						editsEnableHealing,
						agentProfiles,
						activeAgentProfileId,
					followChatProfile,
						syncChatProfileFromSettings,
						builtinTools,
						builtinToolCategories,
						commandTools,
						mcpServers,
						customAgents
					}
				: {
						type: 'update',
						modelsStatus,
						models,
						visibleModelIds,
						copilotDirectAuthStatus,
						editsEnableHealing,
						agentProfiles,
						activeAgentProfileId,
					followChatProfile,
						syncChatProfileFromSettings,
						builtinTools,
						builtinToolCategories,
						commandTools,
						mcpServers,
						customAgents
				  }
		);
			if (isSettingsPerfEnabled()) {
				settingsPerfLog(`[settings#${refreshId}] done total=${Date.now() - refreshStart}ms ${this.perfPrefix()}`);
			}
	}

	private async getCopilotDirectAuthStatus(): Promise<CopilotDirectAuthStatus> {
		const started = Date.now();
		const authMode = this.getCopilotAuthMode();
		const scopes = getGitHubScopes(authMode);

		const cfg = vscode.workspace.getConfiguration('tripilot');
		const tokenUrlOverride = String(cfg.get<string>('copilotDirect.tokenUrl', '') ?? '').trim();
		const tokenUrlOverrideEnabled = !!tokenUrlOverride;
		const deviceFlowEnabled = !!cfg.get<boolean>('copilotDirect.deviceFlow.enabled', true);
		const deviceFlowClientId = String(cfg.get<string>('copilotDirect.deviceFlow.clientId', '') ?? '').trim();
		const deviceFlowClientIdConfigured = !!deviceFlowClientId;

		let vscodeAuthAvailable = !!vscode.authentication && typeof vscode.authentication.getSession === 'function';
		let vscodeAuthHasSession: boolean | undefined;
		let vscodeAuthAccountLabel: string | undefined;
		let vscodeAuthError: string | undefined;
		if (vscodeAuthAvailable) {
			try {
				const t = Date.now();
				const existing = await vscode.authentication.getSession('github', scopes, { createIfNone: false });
				vscodeAuthHasSession = !!existing;
				vscodeAuthAccountLabel = existing?.account?.label ? String(existing.account.label) : undefined;
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(
						`[settings] authStatus vscode.authentication.getSession ${Date.now() - t}ms hasSession=${!!existing} ${this.perfPrefix()}`
					);
				}
			} catch (e) {
				vscodeAuthError = e instanceof Error ? e.message : String(e);
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(`[settings] authStatus vscode.authentication.getSession err: ${vscodeAuthError} ${this.perfPrefix()}`);
				}
			}
		}

		let deviceFlowHasCachedToken = false;
		let deviceFlowAccountLabel: string | undefined;
		let deviceFlowUpdatedAtMs: number | undefined;
		try {
			const t = Date.now();
			const peek = await peekCopilotDirectDeviceFlowSession(this.context.secrets, authMode);
			if (peek) {
				deviceFlowHasCachedToken = true;
				deviceFlowAccountLabel = peek.accountLabel;
				deviceFlowUpdatedAtMs = peek.updatedAtMs;
			}
			if (isSettingsPerfEnabled()) {
				settingsPerfLog(
					`[settings] authStatus peekDeviceFlow ${Date.now() - t}ms cached=${deviceFlowHasCachedToken} ${this.perfPrefix()}`
				);
			}
		} catch {
			// ignore
		}

		const preferredSource: CopilotDirectAuthStatus['preferredSource'] = vscodeAuthHasSession
			? 'vscode-auth'
			: deviceFlowHasCachedToken
				? 'device-flow'
				: undefined;
		const preferredAccountLabel =
			preferredSource === 'vscode-auth'
				? vscodeAuthAccountLabel
				: preferredSource === 'device-flow'
					? deviceFlowAccountLabel
					: undefined;

		const result: CopilotDirectAuthStatus = {
			authMode,
			preferredSource,
			preferredAccountLabel,
			tokenUrlOverrideEnabled,
			tokenUrlOverride: tokenUrlOverride || undefined,
			vscodeAuthAvailable,
			vscodeAuthHasSession,
			vscodeAuthAccountLabel,
			vscodeAuthError,
			deviceFlowEnabled,
			deviceFlowClientIdConfigured,
			deviceFlowHasCachedToken,
			deviceFlowAccountLabel,
			deviceFlowUpdatedAtMs,
			updatedAtMs: Date.now()
		};
		if (isSettingsPerfEnabled()) {
			settingsPerfLog(`[settings] authStatus total ${Date.now() - started}ms ${this.perfPrefix()}`);
		}
		return result;
	}

	private async getBuiltinToolCategories(): Promise<Record<string, string>> {
		if (this.builtinToolCategoriesCache) {
			this.perfLog(`getBuiltinToolCategories cacheHit`);
			return this.builtinToolCategoriesCache;
		}
		const started = Date.now();

		// Deterministic mapping from reference directory structure:
		// reference/copilot/built-in-tools/{agent,edit,execute,read,search,vscode,web}/*.md
		// plus reference/copilot/built-in-tools/todo.md (maps to manage_todo_list)
		const base = vscode.Uri.joinPath(this.context.extensionUri, 'reference', 'copilot', 'built-in-tools');
		const categories = ['agent', 'edit', 'execute', 'read', 'search', 'vscode', 'web'] as const;
		const out: Record<string, string> = {};
		const allowed = new Set(getToolDefinitions().map((t) => t.function.name));

		const categoryPriority: Record<string, number> = {
			agent: 1,
			edit: 2,
			read: 3,
			search: 4,
			execute: 5,
			todo: 6,
			vscode: 7,
			web: 8
		};
		const shouldOverride = (existing: string | undefined, next: string) => {
			if (!existing) return true;
			return (categoryPriority[next] ?? 999) < (categoryPriority[existing] ?? 999);
		};

		const add = (toolName: string, category: string) => {
			if (!allowed.has(toolName)) return;
			if (shouldOverride(out[toolName], category)) out[toolName] = category;
		};

		for (const cat of categories) {
			let entries: [string, vscode.FileType][] = [];
			try {
				const t = Date.now();
				entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(base, cat));
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(
						`[settings] getBuiltinToolCategories readDirectory ${cat} ${Date.now() - t}ms entries=${entries.length} ${this.perfPrefix()}`
					);
				}
			} catch {
				continue;
			}
			for (const [name, type] of entries) {
				if (type !== vscode.FileType.File) continue;
				const lower = name.toLowerCase();
				if (!lower.endsWith('.md')) continue;
				if (lower === 'overview.md' || lower === 'readme.md') continue;
				const toolName = name.replace(/\.md$/i, '');
				add(toolName, cat);
			}
		}

		// todo.md is a category page, but it defines the todo tool.
		add('manage_todo_list', 'todo');

		this.builtinToolCategoriesCache = out;
		if (isSettingsPerfEnabled()) {
			settingsPerfLog(
				`[settings] getBuiltinToolCategories total ${Date.now() - started}ms mapped=${Object.keys(out).length} ${this.perfPrefix()}`
			);
		}
		return out;
	}

	private getBuiltinToolsState(profileId: string): Array<{ name: string; enabled: boolean }> {
		const profile = getAgentProfileMerged(profileId);
		// Important: do NOT pass a defaultValue here; it can mask extension-contributed defaults.
		const raw = vscode.workspace.getConfiguration('tripilot').get<any>('enabledBuiltinTools');
		const arr = Array.isArray(raw) ? raw : [];
		const normalized = arr.map((s) => String(s).trim()).filter(Boolean);
		const globalEnabled = new Set<string>(normalized.length ? normalized : Array.from(OPTIONAL_TOOL_NAMES));
		const enabled = new Set(
			Array.isArray(profile.enabledBuiltinTools) && profile.enabledBuiltinTools.length > 0
				? profile.enabledBuiltinTools.map(String)
				: Array.from(globalEnabled)
		);
		const namesAll = getToolDefinitions().map((t) => t.function.name);
		return namesAll.map((name) => ({ name, enabled: enabled.has(name) }));
	}

	private async setBuiltinToolEnabled(name: string, enabled: boolean) {
		const toolName = String(name);
		const profile = getAgentProfileMerged(this.activeAgentProfileId);
		// Start from the effective enabled set (including defaults) so toggling one tool doesn't accidentally disable others.
		const raw = vscode.workspace.getConfiguration('tripilot').get<any>('enabledBuiltinTools');
		const arr = Array.isArray(raw) ? raw : [];
		const normalized = arr.map((s) => String(s).trim()).filter(Boolean);
		const base = Array.isArray(profile.enabledBuiltinTools) && profile.enabledBuiltinTools.length > 0
			? profile.enabledBuiltinTools
			: (normalized.length ? normalized : Array.from(OPTIONAL_TOOL_NAMES));
		const set = new Set(base.map(String));
		if (enabled) set.add(toolName);
		else set.delete(toolName);
		await upsertAgentProfile({ ...profile, enabledBuiltinTools: Array.from(set) });
		this.post({ type: 'update', builtinTools: this.getBuiltinToolsState(this.activeAgentProfileId) });
	}

	private getCommandToolDefsRaw(): CommandToolConfig[] {
		const raw = vscode.workspace.getConfiguration('tripilot').get<any[]>('commandTools', []) ?? [];
		return raw
			.map((t) => ({
				name: String(t?.name ?? '').trim(),
				command: String(t?.command ?? '').trim(),
				description: t?.description ? String(t.description) : undefined,
				enabled: Boolean(t?.enabled)
			}))
			.filter((t) => t.name && t.command);
	}

	private getCommandTools(profileId: string): CommandToolConfig[] {
		const defs = this.getCommandToolDefsRaw();
		const profile = getAgentProfileMerged(profileId);
		const enabledSet = profile.enabledCommandTools
			? new Set(profile.enabledCommandTools.map((s) => String(s).trim()).filter(Boolean))
			: new Set(defs.filter((d) => d.enabled).map((d) => d.name));
		return defs.map((d) => ({ ...d, enabled: enabledSet.has(d.name) }));
	}

	private async setCommandTools(next: CommandToolConfig[]) {
		await vscode.workspace
			.getConfiguration('tripilot')
			.update('commandTools', next, vscode.ConfigurationTarget.Global);
	}

	private async addCommandTool(tool: CommandToolConfig) {
		const nextTool: CommandToolConfig = {
			name: String(tool?.name ?? '').trim(),
			command: String(tool?.command ?? '').trim(),
			description: tool?.description ? String(tool.description) : undefined,
			enabled: Boolean(tool?.enabled)
		};
		if (!nextTool.name || !nextTool.command) return;
		const current = this.getCommandToolDefsRaw();
		const filtered = current.filter((t) => t.name !== nextTool.name);
		filtered.push(nextTool);
		await this.setCommandTools(filtered);
		// Enable for current active profile.
		const profile = getAgentProfileMerged(this.activeAgentProfileId);
		if (profile.id === 'ask-study' && !ASK_STUDY_ALLOWED_COMMAND_TOOL_NAMES.has(nextTool.name)) {
			this.post({
				type: 'update',
				commandTools: this.getCommandTools(this.activeAgentProfileId),
				agentProfiles: getAgentProfilesMerged()
			});
			return;
		}
		const set = new Set(profile.enabledCommandTools ?? []);
		set.add(nextTool.name);
		await upsertAgentProfile({ ...profile, enabledCommandTools: Array.from(set) });
		this.post({ type: 'update', commandTools: this.getCommandTools(this.activeAgentProfileId), agentProfiles: getAgentProfilesMerged() });
	}

	private async removeCommandTool(name: string) {
		const toolName = String(name);
		const current = this.getCommandToolDefsRaw().filter((t) => t.name !== toolName);
		await this.setCommandTools(current);
		// Remove from all profile enable lists.
		const profiles = readAgentProfilesFromConfig().map((p) => ({
			...p,
			enabledCommandTools: Array.isArray(p.enabledCommandTools)
				? p.enabledCommandTools.filter((n) => String(n) !== toolName)
				: undefined
		}));
		await writeAgentProfilesToConfig(profiles);
		this.post({ type: 'update', commandTools: this.getCommandTools(this.activeAgentProfileId), agentProfiles: getAgentProfilesMerged() });
	}

	private async setCommandToolEnabled(name: string, enabled: boolean) {
		const toolName = String(name);
		const profile = getAgentProfileMerged(this.activeAgentProfileId);
		if (profile.id === 'ask-study' && enabled && !ASK_STUDY_ALLOWED_COMMAND_TOOL_NAMES.has(toolName)) return;
		const set = new Set(profile.enabledCommandTools ?? []);
		if (enabled) set.add(toolName);
		else set.delete(toolName);
		await upsertAgentProfile({ ...profile, enabledCommandTools: Array.from(set) });
		this.post({ type: 'update', commandTools: this.getCommandTools(this.activeAgentProfileId), agentProfiles: getAgentProfilesMerged() });
	}

	private getEffectiveMcpServersConfig(profileId: string): McpServerConfig[] {
		const configs = this.getMcpServersConfig();
		const profile = getAgentProfileMerged(profileId);
		const enabledSet = profile.enabledMcpServers
			? new Set(profile.enabledMcpServers.map((s) => String(s).trim()).filter(Boolean))
			: new Set(configs.filter((s) => s.enabled).map((s) => s.id));
		return configs.map((s) => ({ ...s, enabled: enabledSet.has(s.id) }));
	}

	private getMcpServersConfig(): McpServerConfig[] {
		const raw = vscode.workspace.getConfiguration('tripilot').get<any[]>('mcpServers', []) ?? [];
		return raw
			.map((s) => ({
				id: String(s?.id ?? '').trim(),
				name: String(s?.name ?? '').trim(),
				enabled: Boolean(s?.enabled),
				transport: String(s?.transport ?? 'stdio') as any,
				command: s?.command ? String(s.command) : undefined,
				args: Array.isArray(s?.args) ? s.args.map(String) : undefined,
				cwd: s?.cwd ? String(s.cwd) : undefined,
				env: s?.env && typeof s.env === 'object' ? (s.env as any) : undefined,
				url: s?.url ? String(s.url) : undefined
			}))
			.filter((s) => s.id && s.name);
	}

	private async setMcpServers(next: McpServerConfig[]) {
		await vscode.workspace
			.getConfiguration('tripilot')
			.update('mcpServers', next, vscode.ConfigurationTarget.Global);
	}

	private async upsertMcpServer(server: McpServerConfig) {
		const nextServer: McpServerConfig = {
			id: String(server?.id ?? '').trim(),
			name: String(server?.name ?? '').trim(),
			enabled: Boolean(server?.enabled),
			transport: (String(server?.transport ?? 'stdio') as any) ?? 'stdio',
			command: server?.command ? String(server.command) : undefined,
			args: Array.isArray(server?.args) ? server.args.map(String) : undefined,
			cwd: server?.cwd ? String(server.cwd) : undefined,
			env: server?.env && typeof server.env === 'object' ? (server.env as any) : undefined,
			url: server?.url ? String(server.url) : undefined
		};
		if (!nextServer.id || !nextServer.name) return;
		const current = vscode.workspace.getConfiguration('tripilot').get<any[]>('mcpServers', []) ?? [];
		const filtered = current.filter((s) => String(s?.id ?? '') !== nextServer.id);
		filtered.push(nextServer);
		await this.setMcpServers(filtered as any);
		// Enable for current active profile.
		const profile = getAgentProfileMerged(this.activeAgentProfileId);
		if (profile.id === 'ask-study' && !ASK_STUDY_ALLOWED_MCP_SERVER_IDS.has(nextServer.id)) {
			const cfgs = this.getEffectiveMcpServersConfig(this.activeAgentProfileId);
			await this.mcpManager.refresh(cfgs);
			this.post({ type: 'update', mcpServers: this.mcpManager.getStatuses(cfgs), agentProfiles: getAgentProfilesMerged() });
			return;
		}
		const set = new Set(profile.enabledMcpServers ?? []);
		set.add(nextServer.id);
		await upsertAgentProfile({ ...profile, enabledMcpServers: Array.from(set) });
		const cfgs = this.getEffectiveMcpServersConfig(this.activeAgentProfileId);
		await this.mcpManager.refresh(cfgs);
		this.post({ type: 'update', mcpServers: this.mcpManager.getStatuses(cfgs), agentProfiles: getAgentProfilesMerged() });
	}

	private async removeMcpServer(id: string) {
		const serverId = String(id);
		const current = vscode.workspace.getConfiguration('tripilot').get<any[]>('mcpServers', []) ?? [];
		const next = current.filter((s) => String(s?.id ?? '') !== serverId);
		await this.setMcpServers(next as any);
		// Remove from all profile enable lists.
		const profiles = readAgentProfilesFromConfig().map((p) => ({
			...p,
			enabledMcpServers: Array.isArray(p.enabledMcpServers)
				? p.enabledMcpServers.filter((sid) => String(sid) !== serverId)
				: undefined
		}));
		await writeAgentProfilesToConfig(profiles);
		const cfgs = this.getEffectiveMcpServersConfig(this.activeAgentProfileId);
		await this.mcpManager.refresh(cfgs);
		this.post({ type: 'update', mcpServers: this.mcpManager.getStatuses(cfgs), agentProfiles: getAgentProfilesMerged() });
	}

	private async setMcpServerEnabled(id: string, enabled: boolean) {
		const serverId = String(id);
		const profile = getAgentProfileMerged(this.activeAgentProfileId);
		if (profile.id === 'ask-study' && enabled && !ASK_STUDY_ALLOWED_MCP_SERVER_IDS.has(serverId)) return;
		const set = new Set(profile.enabledMcpServers ?? []);
		if (enabled) set.add(serverId);
		else set.delete(serverId);
		await upsertAgentProfile({ ...profile, enabledMcpServers: Array.from(set) });
		const cfgs = this.getEffectiveMcpServersConfig(this.activeAgentProfileId);
		await this.mcpManager.refresh(cfgs);
		this.post({ type: 'update', mcpServers: this.mcpManager.getStatuses(cfgs), agentProfiles: getAgentProfilesMerged() });
	}

	private async getAllModelsForSettings(): Promise<LmModelInfo[]> {
		const started = Date.now();
		const lmAny = (vscode as any).lm;
		const autoModel = this.getAutoModelInfo();
		const provider = this.getChatProvider();
		const cacheKey = makeSettingsModelsCacheKey(provider);
		const cached = tryGetSettingsModelsFromCache(cacheKey);
		if (cached && cached.length) {
			if (isSettingsPerfEnabled()) {
				settingsPerfLog(
					`[settings] getAllModelsForSettings cacheHit key=${cacheKey} count=${cached.length} ${this.perfPrefix()}`
				);
			}
			return cached;
		}

		if (provider === 'copilot-direct') {
			try {
				const tToken = Date.now();
				const copilotToken = await this.copilotTokenManager.getCopilotToken();
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(`[settings] getAllModelsForSettings copilotToken ${Date.now() - tToken}ms ${this.perfPrefix()}`);
				}
				const tList = Date.now();
				const models = await this.copilotClient.listModels(copilotToken);
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(
						`[settings] getAllModelsForSettings copilot.listModels ${Date.now() - tList}ms count=${models.length} ${this.perfPrefix()}`
					);
				}
				const mapped: LmModelInfo[] = models.map((m) => ({
					id: m.id,
					name: m.displayName ?? m.id,
					vendor: 'copilot',
					family: 'copilot',
					version: 'n/a',
					maxInputTokens: m.maxInputTokens ?? 0
				}));
				const result = [autoModel, ...mapped];
				setSettingsModelsCache(cacheKey, result);
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(`[settings] getAllModelsForSettings total ${Date.now() - started}ms ${this.perfPrefix()}`);
				}
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				void vscode.window.showWarningMessage(`无法加载 Copilot 模型：${message}`);
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(`[settings] getAllModelsForSettings copilot-direct err: ${message} ${this.perfPrefix()}`);
				}
				return [autoModel];
			}
		}

		if (provider === 'models-direct') {
			const cfg = this.getModelsDirectConfig();
			if (!cfg.baseUrl) return [autoModel];
			try {
				const tList = Date.now();
				const models = await this.modelsDirectClient.listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(
						`[settings] getAllModelsForSettings models-direct listModels ${Date.now() - tList}ms count=${models.length} ${this.perfPrefix()}`
					);
				}
				const mapped: LmModelInfo[] = models.map((m) => ({
					id: m.id,
					name: m.displayName ?? m.id,
					vendor: 'models-direct',
					family: String(m.modelTag || 'models-direct'),
					version: 'n/a',
					maxInputTokens: m.maxInputTokens ?? 0
				}));
				const result = [autoModel, ...mapped];
				setSettingsModelsCache(cacheKey, result);
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(`[settings] getAllModelsForSettings total ${Date.now() - started}ms ${this.perfPrefix()}`);
				}
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				void vscode.window.showWarningMessage(`无法加载 Models Direct 模型：${message}`);
				if (isSettingsPerfEnabled()) {
					settingsPerfLog(`[settings] getAllModelsForSettings models-direct err: ${message} ${this.perfPrefix()}`);
				}
				return [autoModel];
			}
		}

		if (!lmAny || typeof lmAny.selectChatModels !== 'function') {
			return [autoModel];
		}

		const tSelect = Date.now();
		const chats = await vscode.lm.selectChatModels();
		if (isSettingsPerfEnabled()) {
			settingsPerfLog(
				`[settings] getAllModelsForSettings vscode.lm.selectChatModels ${Date.now() - tSelect}ms count=${chats.length} ${this.perfPrefix()}`
			);
		}
		const real: LmModelInfo[] = chats
			.map((m) => ({
			id: m.id,
			name: m.name,
			vendor: m.vendor,
			family: m.family,
			version: m.version,
			maxInputTokens: m.maxInputTokens
		}))
			// Avoid duplicate Auto if the runtime also returns an `id === 'auto'` model.
			.filter((m) => m.id !== 'auto');

		const result = [autoModel, ...real];
		setSettingsModelsCache(cacheKey, result);
		if (isSettingsPerfEnabled()) {
			settingsPerfLog(`[settings] getAllModelsForSettings total ${Date.now() - started}ms ${this.perfPrefix()}`);
		}
		return result;
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'settings.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'settings.js'));
		const codiconUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
		);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} https:; font-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${codiconUri}" />
	<link rel="stylesheet" href="${styleUri}" />
	<title>Tripilot Settings</title>
</head>
<body>
	<div class="app">
		<aside class="sidebar">
			<div class="sidebarTitle">Tripilot Settings</div>
			<button class="navItem active" data-page="models">
				<span class="codicon codicon-symbol-property"></span>
				<span>Models</span>
			</button>
			<button class="navItem" data-page="customAgents">
				<span class="codicon codicon-person"></span>
				<span>Custom Agents</span>
			</button>
			<button class="navItem" data-page="tools">
				<span class="codicon codicon-tools"></span>
				<span>Tools & MCP</span>
			</button>
		</aside>
		<main class="main">
			<section class="page" data-page="models">
				<div class="header">
					<h1 class="h1">Models</h1>
				</div>
				<div class="section">
					<div class="sectionTitle">Provider Status</div>
					<div class="authBox">
						<div class="authHeaderRow">
							<div class="authKey">Status</div>
							<button id="copilotDirectAuthToggle" class="ghost small">Show</button>
						</div>
						<div id="copilotDirectAuthDetails" class="authDetails hidden">
							<div id="copilotDirectAuthText" class="authValue">Loading...</div>
							<div id="copilotDirectAuthHint" class="modelMeta authHint"></div>
							<div id="modelsStatus" class="modelMeta"></div>
						</div>
					</div>
					<div class="actionBox">
						<div class="actionHeader">Actions</div>
						<div class="actionButtons">
							<button id="copilotDirectAuthRefresh" class="ghost">Refresh</button>
							<button id="copilotDirectReloginMinimal" class="ghost">Clear + Re-login (minimal)</button>
							<button id="copilotDirectReloginPermissive" class="ghost">Clear + Re-login (permissive)</button>
							<button id="copilotDirectSignOut" class="ghost">Sign out</button>
						</div>
					</div>
				</div>
				<div class="searchRow">
					<input id="search" class="search" placeholder="Add or search model" />
					<button id="refresh" class="iconButton" title="Refresh">
						<span class="codicon codicon-refresh"></span>
					</button>
				</div>
				<div id="modelList" class="list"></div>
			</section>
			<section class="page hidden" data-page="customAgents">
				<div class="header">
					<h1 class="h1">Custom Agents</h1>
				</div>
				<div class="section">
					<div class="modelMeta">
						对齐 VS Code Copilot Chat 的 <b>Custom Agents</b>：在工作区的 <code>.github/agents</code> 目录下创建 <code>*.agent.md</code> 文件，并在 YAML frontmatter 中配置 <code>name</code>/<code>description</code>/<code>tools</code>/<code>model</code> 等字段。<br />
						Tripilot 会自动扫描 <code>.github/agents/**/*.agent.md</code>，也会兼容旧格式 <code>.github/chatmodes/**/*.chatmode.md</code>。
					</div>
					<div class="inlineForm">
						<input id="customAgentFileBase" class="text" placeholder="file base name (e.g. planner)" />
						<div></div>
						<div></div>
						<button id="customAgentCreate" class="primary">Create</button>
					</div>
					<button id="customAgentRefresh" class="iconButton" title="Refresh">
						<span class="codicon codicon-refresh"></span>
					</button>
					<div id="customAgentList" class="list"></div>
				</div>
			</section>
			<section class="page hidden" data-page="tools">
				<div class="header">
					<h1 class="h1">Tools & MCP</h1>
				</div>
				<div class="section">
					<div class="sectionTitle">Agent Profiles</div>
					<div class="modelMeta">
						profiles 是 Tripilot 扩展自定义的“模式配置”，保存在 VS Code Settings 的 <code>tripilot.agentProfiles</code>（用户级）。<br />
						常用字段：<code>enabledBuiltinTools</code> / <code>enabledCommandTools</code> / <code>enabledMcpServers</code>。<br />
						示例（写到 settings.json 里）：
						<pre><code>"tripilot.agentProfiles": [
  {
    "id": "my-agent",
    "name": "my agent",
    "enabledBuiltinTools": ["workspace_findInFiles", "editor_getSelection"],
    "enabledCommandTools": ["myTool"],
    "enabledMcpServers": ["docs"]
  }
]</code></pre>
					</div>
					<div class="profileRow">
						<select id="agentProfileSelect" class="select"></select>
						<button id="agentProfileRemove" class="ghost">Remove</button>
					</div>
					<div class="row" style="margin-top: 10px;">
						<div>
							<div class="modelName">跟随当前聊天 Profile</div>
							<div class="modelMeta">从 Chat 打开 Tools Settings / 切换 Profile 时，自动对齐到当前对话的 Profile。</div>
						</div>
						<label class="toggle" title="开启后，Settings 会自动切换到当前聊天 Profile">
							<input id="followChatProfile" type="checkbox" />
							<span class="slider"></span>
						</label>
					</div>
					<div class="row" style="margin-top: 8px;">
						<div>
							<div class="modelName">Settings 选择 Profile 同步到 Chat</div>
							<div class="modelMeta">可选：在 Settings 下拉切 Profile 时，同时切换当前聊天的 Profile（可能改变对话行为）。</div>
						</div>
						<label class="toggle" title="开启后，Settings 的 profile 下拉会同步影响当前聊天 profile">
							<input id="syncChatProfileFromSettings" type="checkbox" />
							<span class="slider"></span>
						</label>
					</div>
					<div class="row" style="margin-top: 8px;">
						<div>
							<div class="modelName">Edits Healing（保守兜底）</div>
							<div class="modelMeta">当 replace-string edits 找不到 oldString 时，允许用“最相似且唯一”的片段自动重试一次（避免 patch mismatch）。ask&study 模式始终启用。</div>
						</div>
						<label class="toggle" title="开启后，apply_patch.edits 会在 oldString 不匹配时进行一次保守重试">
							<input id="editsEnableHealing" type="checkbox" />
							<span class="slider"></span>
						</label>
					</div>
					<div class="row" style="margin-top: 8px;">
						<div>
							<div class="modelName">Edits Healing（当前 Profile）</div>
							<div class="modelMeta">可选：为当前 Profile 单独配置（优先级高于全局设置）。</div>
						</div>
						<div class="rowRight" style="gap: 8px;">
							<select id="profileEditsEnableHealingMode" class="select" title="inherit = 使用全局设置；on/off = 覆盖全局设置">
								<option value="inherit">inherit</option>
								<option value="on">on</option>
								<option value="off">off</option>
							</select>
						</div>
					</div>
					<div class="inlineForm profileAdd">
						<input id="agentProfileId" class="text" placeholder="id (e.g. my-agent)" />
						<input id="agentProfileName" class="text" placeholder="name (e.g. my agent)" />
						<div></div>
						<button id="agentProfileAdd" class="primary">Add</button>
					</div>
				</div>
				<div class="section">
					<div class="sectionTitle">Built-in Tools</div>
					<div id="builtinTools" class="list"></div>
				</div>
				<div class="section">
					<div class="sectionTitle">Extension Tools (Commands)</div>
					<div id="commandTools" class="list"></div>
					<div class="inlineForm">
						<input id="cmdToolName" class="text" placeholder="tool name (e.g. myTool)" />
						<input id="cmdToolCommand" class="text" placeholder="command id (e.g. workbench.action...)" />
						<input id="cmdToolDesc" class="text" placeholder="description (optional)" />
						<button id="cmdToolAdd" class="primary">Add</button>
					</div>
					<div class="discoverRow">
						<input id="cmdDiscoverQuery" class="search" placeholder="Search installed commands" />
						<button id="cmdDiscover" class="iconButton" title="Search">
							<span class="codicon codicon-search"></span>
						</button>
					</div>
					<div id="cmdDiscoverList" class="list"></div>
				</div>
				<div class="section">
					<div class="sectionTitle">Installed MCP Servers</div>
					<div id="mcpServers" class="list"></div>
					<div class="inlineForm">
						<input id="mcpId" class="text" placeholder="id (e.g. zapier)" />
						<input id="mcpName" class="text" placeholder="name" />
						<select id="mcpTransport" class="select">
							<option value="stdio">stdio</option>
							<option value="http">http</option>
							<option value="websocket">websocket</option>
							<option value="sse">sse</option>
						</select>
						<input id="mcpUrl" class="text" placeholder="url (http/ws)" />
						<input id="mcpCommand" class="text" placeholder="command (stdio)" />
						<input id="mcpArgs" class="text" placeholder="args (stdio, JSON array)" />
						<button id="mcpAdd" class="primary">Save</button>
					</div>
					<button id="mcpRefresh" class="iconButton" title="Refresh">
						<span class="codicon codicon-refresh"></span>
					</button>
				</div>
			</section>
		</main>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

class TripilotChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'tripilot.chatView';
	private static activeInstance?: TripilotChatViewProvider;

	public static setActiveInstance(instance: TripilotChatViewProvider): void {
		TripilotChatViewProvider.activeInstance = instance;
	}

	public static trySyncChatProfileFromSettings(agentProfileId: string): void {
		try {
			const id = String(agentProfileId ?? '').trim();
			if (!id) return;
			void TripilotChatViewProvider.activeInstance?.syncAgentProfileFromSettings(id);
		} catch {
			// ignore
		}
	}

	private view?: vscode.WebviewView;
	private editorPanel?: vscode.WebviewPanel;
	private readonly webviews = new Set<vscode.Webview>();
	private toggleWantsChat = true;
	private readonly hostStates: Record<ChatHostKind, ChatHostState>;
	private lastModels: vscode.LanguageModelChat[] = [];
	private lastCopilotModels: CopilotModelInfo[] = [];
	private lastCopilotAutoDiscount?: { label: string; expiresAtMs: number };
	private copilotAutoPrefetchInFlight?: Promise<void>;
	private lastModelsDirectModels: ModelsDirectModelInfo[] = [];
	private selectedModelId?: string;
	private selectedAgentProfileId: string;
	private enabledTools = new Set<string>();
	private readonly mcpManager: McpClientManager;
	private readonly extensionVersion: string;
	private readonly editorVersionHeader: string;
	private readonly copilotTokenManager: CopilotTokenManager;
	private readonly copilotClient: CopilotDirectClient;
	private readonly modelsDirectClient: ModelsDirectClient;
	private workspaceCustomAgentsLoaded = false;
	private workspaceCustomAgents: WorkspaceCustomAgentInfo[] = [];
	private workspaceCustomAgentById = new Map<string, WorkspaceCustomAgentInfo>();
	private sessionsRefreshTimer?: NodeJS.Timeout;
	private subagentTraceCache = new Map<string, { atMs: number; lines: string[] }>();
	private pendingEditApproval?: {
		requestId: string;
		originHost: ChatHostKind;
		resolve: (v: 'apply' | 'cancel') => void;
		previews: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }>;
		canPreview: boolean;
	};
	private pendingEditReviews = new Map<
		string,
		{
			originHost: ChatHostKind;
			previews: Array<{
				relativePath: string;
				uri: vscode.Uri;
				original: string;
				updated: string;
				editCount: number;
				kind: 'add' | 'update' | 'delete';
			}>;
			canPreview: boolean;
			createdAt: number;
		}
	>();
	private lastEditReviewRequestIdByHost: Record<ChatHostKind, string | undefined> = { sidebar: undefined, editor: undefined };
	private appliedEditSeq = 0;
	private appliedEditsTimelineByHost: Record<
		ChatHostKind,
		Array<{
			seq: number;
			requestId: string;
			previews: Array<{
				relativePath: string;
				uri: vscode.Uri;
				original: string;
				updated: string;
				editCount: number;
				kind: 'add' | 'update' | 'delete';
			}>;
			createdAt: number;
		}>
	> = { sidebar: [], editor: [] };
	private checkpointsById = new Map<
		string,
		{
			originHost: ChatHostKind;
			transcriptIndex: number;
			lastEditSeq: number;
			conversationSnapshot: vscode.LanguageModelChatMessage[];
			copilotConversationSnapshot?: OpenAIChatMessage[];
			createdAt: number;
		}
	>();
	private lastCheckpointRestoreByHost: Record<
		ChatHostKind,
		| {
			restoredToCheckpointId: string;
			checkpointLastEditSeq: number;
			redoToken: string;
			createdAt: number;
			transcriptBefore: ChatTranscriptItem[];
			conversationBefore: vscode.LanguageModelChatMessage[];
			copilotConversationBefore?: OpenAIChatMessage[];
			appliedTimelineBefore: Array<{
				seq: number;
				requestId: string;
				previews: Array<{
					relativePath: string;
					uri: vscode.Uri;
					original: string;
					updated: string;
					editCount: number;
					kind: 'add' | 'update' | 'delete';
				}>;
				createdAt: number;
			}>;
			removedCheckpoints: Array<{
				id: string;
				rec: {
					originHost: ChatHostKind;
					transcriptIndex: number;
					lastEditSeq: number;
					conversationSnapshot: vscode.LanguageModelChatMessage[];
					copilotConversationSnapshot?: OpenAIChatMessage[];
					createdAt: number;
				};
			}>;
		}
		| undefined
	> = { sidebar: undefined, editor: undefined };

	constructor(
		private readonly context: vscode.ExtensionContext,
		mcpManager: McpClientManager,
		extensionVersion: string,
		editorVersionHeader: string
	) {
		this.mcpManager = mcpManager;
		this.extensionVersion = String(extensionVersion || '0.0.0');
		this.editorVersionHeader = String(editorVersionHeader || `vscode/${vscode.version}`);
		this.copilotClient = new CopilotDirectClient(this.extensionVersion, this.editorVersionHeader);
		this.modelsDirectClient = new ModelsDirectClient(this.extensionVersion, this.editorVersionHeader);
		this.copilotTokenManager = new CopilotTokenManager(this.extensionVersion, () => this.getCopilotAuthMode(), this.context.secrets);
		this.selectedModelId = this.context.globalState.get<string>('tripilot.selectedModelId');
		this.selectedAgentProfileId =
			this.context.globalState.get<string>('tripilot.selectedAgentProfileId') ?? getDefaultAgentProfileId();
		this.enabledTools = new Set(Array.from(OPTIONAL_TOOL_NAMES));
		this.hostStates = {
			sidebar: { kind: 'sidebar', conversation: [], copilotConversation: [], transcript: [], contextAttachments: [] },
			editor: { kind: 'editor', conversation: [], copilotConversation: [], transcript: [], contextAttachments: [] }
		};
		// vscode.lm currently only supports User/Assistant roles; store our system instructions as a hidden User message.
		this.ensureSystemInstructionUpToDate(this.hostStates.sidebar);
		this.ensureSystemInstructionUpToDate(this.hostStates.editor);
		this.ensureCopilotSystemInstructionUpToDate(this.hostStates.sidebar);
		this.ensureCopilotSystemInstructionUpToDate(this.hostStates.editor);

		// Keep workspace custom agents in sync with the filesystem and settings.
		try {
			const w1 = vscode.workspace.createFileSystemWatcher('**/.github/agents/**/*.agent.md');
			const w2 = vscode.workspace.createFileSystemWatcher('**/.github/chatmodes/**/*.chatmode.md');
			this.context.subscriptions.push(w1, w2);
			const refresh = () => void this.refreshWorkspaceCustomAgentsAndPost();
			w1.onDidCreate(refresh);
			w1.onDidChange(refresh);
			w1.onDidDelete(refresh);
			w2.onDidCreate(refresh);
			w2.onDidChange(refresh);
			w2.onDidDelete(refresh);
			this.context.subscriptions.push(
				vscode.workspace.onDidChangeConfiguration((e) => {
					if (e.affectsConfiguration('tripilot.hiddenCustomAgents') || e.affectsConfiguration('tripilot.agentProfiles')) {
						refresh();
					}
				})
			);
		} catch {
			// ignore
		}

		// Ensure we don't leak timers on extension reload.
		this.context.subscriptions.push({
			dispose: () => {
				if (this.sessionsRefreshTimer) {
					clearTimeout(this.sessionsRefreshTimer);
					this.sessionsRefreshTimer = undefined;
				}
				for (const state of Object.values(this.hostStates)) {
					if (state.replayCadenceTimer) {
						clearInterval(state.replayCadenceTimer);
						state.replayCadenceTimer = undefined;
					}
				}
			}
		});
	}

	private scheduleSessionsRefresh(delayMs = 250): void {
		// Sessions list only exists in the sidebar webview.
		if (!this.hostStates.sidebar.webview) return;
		if (!this.isChatHistoryEnabled()) return;
		if (this.sessionsRefreshTimer) return;
		this.sessionsRefreshTimer = setTimeout(() => {
			this.sessionsRefreshTimer = undefined;
			void this.refreshSessionsAndPost();
		}, Math.max(0, delayMs));
	}

	public resetCopilotDirectCaches(): void {
		try {
			this.copilotTokenManager.reset();
		} catch {
			// ignore
		}
		this.lastCopilotModels = [];
		this.lastCopilotAutoDiscount = undefined;
		this.copilotAutoPrefetchInFlight = undefined;
	}

	private buildCopilotDirectLmModels(): { models: LmModelInfo[]; selectedModelId?: string } {
		const visibleModelIds = new Set(
			(vscode.workspace.getConfiguration('tripilot').get<string[]>('visibleModelIds', []) ?? [])
				.map((s) => String(s).trim())
				.filter(Boolean)
		);

		const autoModel: LmModelInfo = {
			id: 'auto',
			name: 'Auto',
			vendor: 'tripilot',
			family: 'auto',
			version: 'auto',
			maxInputTokens: 0
		};

		const allRealModels: LmModelInfo[] = this.lastCopilotModels
			.map((m) => {
				const mult = typeof m.multiplier === 'number' ? m.multiplier : undefined;
				return {
					id: m.id,
					name: m.displayName ?? m.id,
					vendor: 'copilot',
					family: 'copilot',
					version: 'n/a',
					maxInputTokens: m.maxInputTokens ?? 0,
					rightText: typeof mult === 'number' ? formatMultiplier(mult) : undefined
				} satisfies LmModelInfo;
			})
			.filter((m) => m.id !== 'auto');

		const filteredRealModels = visibleModelIds.size ? allRealModels.filter((m) => visibleModelIds.has(m.id)) : allRealModels;

		const models: LmModelInfo[] = [];
		// Default behavior (no whitelist): always include Auto at the top.
		// If a whitelist is configured, include Auto only when it is explicitly listed.
		if (!visibleModelIds.size || visibleModelIds.has('auto')) {
			const now = Date.now();
			const autoDiscount =
				this.lastCopilotAutoDiscount && this.lastCopilotAutoDiscount.expiresAtMs > now
					? this.lastCopilotAutoDiscount.label
					: undefined;
			models.push({ ...autoModel, rightText: autoDiscount });
		}
		models.push(...filteredRealModels);

		return { models, selectedModelId: this.selectedModelId };
	}

	private prefetchCopilotAutoDiscount(stateHint?: ChatHostState): void {
		// Non-blocking: fetch /models/session and then re-post model list to show Auto discount.
		const now = Date.now();
		if (this.lastCopilotAutoDiscount && this.lastCopilotAutoDiscount.expiresAtMs - 30_000 > now) return;
		if (this.copilotAutoPrefetchInFlight) return;
		const state = stateHint ?? this.hostStates.sidebar;
		this.copilotAutoPrefetchInFlight = (async () => {
			try {
				await this.ensureCopilotAutoSession(state);
				if (this.getChatProvider() === 'copilot-direct') {
					const whitelistSize = (
						vscode.workspace.getConfiguration('tripilot').get<string[]>('visibleModelIds', []) ?? []
					)
						.map((s) => String(s).trim())
						.filter(Boolean).length;
					const built = this.buildCopilotDirectLmModels();
					this.postAny({
						type: 'lmModels',
						models: built.models,
						selectedModelId: built.selectedModelId,
						provider: 'copilot-direct',
						runtimeCount: this.lastCopilotModels.length,
						whitelistSize,
						filteredCount: built.models.length
					});
				}
			} finally {
				this.copilotAutoPrefetchInFlight = undefined;
			}
		})();
	}

	private async ensureCopilotAutoSession(state: ChatHostState): Promise<
		| {
			sessionToken: string;
			expiresAtMs: number;
			selectedModel: string;
			discountRange?: { low: number; high: number };
		}
		| undefined
	> {
		const now = Date.now();
		const cached = state.copilotAutoSession;
		if (cached && cached.expiresAtMs - 30_000 > now) {
			return cached;
		}

		let session: CopilotAutoModelsSession | undefined;
		try {
			const token = await this.copilotTokenManager.getCopilotToken();
			session = await this.copilotClient.createAutoModelsSession({
				token,
				modelHint: 'auto',
				previousSessionToken: cached?.sessionToken
			});
		} catch {
			session = undefined;
		}
		if (!session) return undefined;

		const expiresAtMs = (session.expiresAt ? session.expiresAt * 1000 : now + 5 * 60_000);
		const discountRange = computeDiscountRange(session.discountedCosts);
		state.copilotAutoSession = {
			sessionToken: session.sessionToken,
			expiresAtMs,
			selectedModel: session.selectedModel,
			discountRange
		};

		const label = formatDiscountLabel(discountRange);
		if (label) {
			this.lastCopilotAutoDiscount = { label, expiresAtMs };
		} else {
			this.lastCopilotAutoDiscount = undefined;
		}

		return state.copilotAutoSession;
	}

	private async refreshWorkspaceCustomAgentsAndPost(): Promise<void> {
		this.workspaceCustomAgentsLoaded = true;
		try {
			this.workspaceCustomAgents = await discoverWorkspaceCustomAgents();
			this.workspaceCustomAgentById = new Map(this.workspaceCustomAgents.map((a) => [a.id, a]));
		} catch {
			this.workspaceCustomAgents = [];
			this.workspaceCustomAgentById = new Map();
		}
		this.postAgentsList();
		// Settings panel may also be open; refresh it best-effort.
		TripilotSettingsPanel.refreshIfOpen();
	}

	private postAgentsList(): void {
		const profiles = getAgentProfilesMerged();
		const items: Array<{ id: string; label: string; description?: string }> = profiles.map((p) => ({
			id: p.id,
			label: p.name
		}));
		const visibleCustom = this.workspaceCustomAgents.filter((a) => !a.hidden);
		if (visibleCustom.length) {
			items.push({ id: '---', label: '---' } as any);
			for (const a of visibleCustom) {
				items.push({ id: a.id, label: a.name, description: a.description });
			}
		}
		items.push({ id: '---', label: '---' } as any);
		items.push({ id: 'configureCustomAgents', label: '配置 Custom Agents…' });
		this.postAny({ type: 'agents', agents: items });
	}

	private getWorkspaceCustomAgent(profileId: string): WorkspaceCustomAgentInfo | undefined {
		return this.workspaceCustomAgentById.get(String(profileId ?? '').trim());
	}

	private mapCustomAgentToolsToOptionalBuiltinTools(toolSpecs: string[] | undefined): Set<string> {
		// If tools are not specified, behave like a general-purpose agent.
		if (!Array.isArray(toolSpecs) || toolSpecs.length === 0) {
			return new Set(Array.from(OPTIONAL_TOOL_NAMES));
		}
		const enabled = new Set<string>();
		for (const raw of toolSpecs) {
			const t = String(raw ?? '').trim();
			if (!t) continue;
			if (OPTIONAL_TOOL_NAMES.has(t)) {
				enabled.add(t);
				continue;
			}
			// Minimal compatibility with VS Code Copilot custom agent tool sets.
			// Copilot-style custom agents typically specify coarse tool *sets* like: edit/search/terminal/diagnostics.
			// Tripilot only exposes the Copilot tool surface (OPTIONAL_TOOL_NAMES), so map those sets to our tool sets.
			if (t === 'search') {
				for (const n of TOOL_SETS.search.tools) enabled.add(n);
				continue;
			}
			if (t === 'edit') {
				for (const n of TOOL_SETS.edit.tools) enabled.add(n);
				continue;
			}
			if (t === 'terminal') {
				enabled.add('runInTerminal');
				enabled.add('getTerminalOutput');
				continue;
			}
			if (t === 'diagnostics') {
				enabled.add('problems');
				continue;
			}
			// 'selection' isn't currently part of the exposed Copilot tool surface in Tripilot.
		}
		return enabled;
	}

	private getEffectiveAgentProfile(profileId: string): AgentProfileConfig {
		const agent = this.getWorkspaceCustomAgent(profileId);
		if (!agent) return getAgentProfileMerged(profileId);
		// Start from agent-vm defaults and override based on agent file.
		const base = getAgentProfileMerged('agent-vm');
		const enabledBuiltin = Array.from(this.mapCustomAgentToolsToOptionalBuiltinTools(agent.tools));
		// Command tools and MCP servers: only enable those explicitly referenced.
		const enabledCommandTools: string[] = [];
		const enabledMcpServers: string[] = [];
		if (Array.isArray(agent.tools)) {
			for (const raw of agent.tools) {
				const t = String(raw ?? '').trim();
				if (!t) continue;
				if (t.endsWith('/*')) {
					enabledMcpServers.push(t.slice(0, -2));
					continue;
				}
				// Treat as command tool name if it matches a configured one.
				enabledCommandTools.push(t);
			}
		}
		return {
			...base,
			id: agent.id,
			name: agent.name,
			enabledBuiltinTools: enabledBuiltin,
			enabledCommandTools: enabledCommandTools.length ? enabledCommandTools : [],
			enabledMcpServers: enabledMcpServers.length ? enabledMcpServers : []
		};
	}

	public async showChatLogView(host: ChatHostKind = 'sidebar'): Promise<void> {
		const state = this.hostStates[host];
		if (!this.isChatHistoryEnabled()) {
			const choice = await vscode.window.showInformationMessage(
				'需要启用 Tripilot 的本地聊天历史记录，才能查看 Chat Debug View。是否现在启用？',
				'启用',
				'取消'
			);
			if (choice !== '启用') return;
			await vscode.workspace
				.getConfiguration('tripilot')
				.update('chatHistory.enabled', true, vscode.ConfigurationTarget.Global);
		}
		if (!state.historySessionId) {
			vscode.window.showWarningMessage('当前没有活跃的聊天会话。请先发送一条消息，或从会话列表加载/新建会话。');
			return;
		}

		const fileUri = vscode.Uri.joinPath(this.getHistoryDirUri(), `${state.historySessionId}.jsonl`);
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
		} catch (err) {
			vscode.window.showErrorMessage(`打开 Chat Debug View 失败：${safeToString(err)}`);
		}
	}

	public async openChatView(): Promise<void> {
		// Only touches Tripilot's own view container.
		await this.tryExecute('workbench.view.extension.tripilot');
		await this.tryExecute('tripilot.chatView.focus');
	}

	public async toggleChatFocus(): Promise<void> {
		// Copilot-like: toggle focus between our view and the editor group.
		this.toggleWantsChat = !this.toggleWantsChat;
		if (this.toggleWantsChat) {
			await this.openChatView();
			return;
		}
		await this.tryExecute('workbench.action.focusActiveEditorGroup');
	}

	public async openChatInEditorArea(sourceHost: ChatHostKind = 'sidebar'): Promise<void> {
		if (this.editorPanel) {
			this.editorPanel.reveal(vscode.ViewColumn.Active, false);
			return;
		}
		const srcState = this.hostStates[sourceHost];
		const isFromSidebar = sourceHost === 'sidebar';

		const panel = vscode.window.createWebviewPanel(
			'tripilot.chatEditor',
			'Tripilot Chat',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] }
		);
		this.editorPanel = panel;
		this.webviews.add(panel.webview);
		panel.webview.html = this.getHtml(panel.webview, 'editor');

		// Copilot-like behavior:
		// 1) If moving during generation, do NOT interrupt. Migrate the running state object to editor.
		// 2) After move, sidebar should not keep the moved chat content (it may show other sessions or stay empty).
		if (isFromSidebar && srcState.isBusy) {
			const sidebarWebview = this.hostStates.sidebar.webview;
			const running = this.hostStates.sidebar;
			const freshSidebar: ChatHostState = {
				kind: 'sidebar',
				webview: sidebarWebview,
				conversation: [],
				copilotConversation: [],
				transcript: [],
				contextAttachments: []
			};
			this.ensureSystemInstructionUpToDate(freshSidebar);
			this.ensureCopilotSystemInstructionUpToDate(freshSidebar);

			// Migrate running host state to editor.
			running.kind = 'editor';
			running.webview = panel.webview;
			// Let the editor webview render current transcript on ready (without mutating the running state).
			running.replayOnReady = { kind: 'transcript', transcript: [...running.transcript] };
			// Best-effort: reflect current busy status in the editor immediately.
			if (running.status) {
				this.postToHost(running, { type: 'chatSetStatus', status: running.status, detail: running.statusDetail });
			}
			if (running.inProgressAssistantText) {
				this.postToHost(running, { type: 'chatAssistantStart', initialText: running.inProgressAssistantText });
			}
			this.hostStates.editor = running;
			this.hostStates.sidebar = freshSidebar;

			// Clear sidebar chat UI immediately; sessions list remains usable.
			this.postToHost(freshSidebar, { type: 'chatReset' });
			this.setAndPostStatus(freshSidebar, 'idle');
			await this.refreshSessionsAndPost();
		} else {
			const editorState = this.hostStates.editor;
			editorState.webview = panel.webview;
			// Align with Copilot Chat: editor chat is independent of the sidebar. We pin the current session/transcript.
			if (this.isChatHistoryEnabled() && srcState.historySessionId) {
				editorState.replayOnReady = { kind: 'session', sessionId: srcState.historySessionId };
			} else {
				editorState.replayOnReady = { kind: 'transcript', transcript: [...srcState.transcript] };
			}

			if (isFromSidebar) {
				srcState.conversation = [];
				srcState.transcript = [];
				srcState.contextAttachments = [];
				srcState.historySessionId = undefined;
				srcState.currentSessionTitle = undefined;
				srcState.historyStore = undefined;
				this.ensureSystemInstructionUpToDate(srcState);
				this.postToHost(srcState, { type: 'chatReset' });
				this.setAndPostStatus(srcState, 'idle');
				await this.context.globalState.update('tripilot.activeChatSessionId', undefined);
				await this.refreshSessionsAndPost();
			}
		}
		panel.onDidDispose(() => {
			this.webviews.delete(panel.webview);
			if (this.editorPanel === panel) this.editorPanel = undefined;
			if (this.hostStates.editor.webview === panel.webview) this.hostStates.editor.webview = undefined;
		});
		panel.webview.onDidReceiveMessage(async (msg: WebviewInboundMessage) => {
			await this.handleInboundMessage(panel.webview, msg);
		});
	}

	public async openChatInNewWindow(): Promise<void> {
		// VS Code stable API does not let extensions move a webview into an auxiliary window.
		// Keep this as an explicit, safe fallback.
		const picked = await vscode.window.showInformationMessage(
			'Tripilot：扩展 API 暂不支持像 Copilot Chat 一样把聊天移动到“新窗口”。\n\n可选：在当前窗口的编辑器区域打开（推荐）。',
			'在编辑器区域打开',
			'取消'
		);
		if (picked === '在编辑器区域打开') {
			await this.openChatInEditorArea();
		}
	}

	public async resetViewDefaults(): Promise<void> {
		// Keep minimal for now: reset only Tripilot-local UI state.
		await this.refreshSessionsAndPost();
		vscode.window.showInformationMessage('Tripilot：已恢复默认显示（仅影响 Tripilot）。');
	}

	public async openQuickChat(): Promise<void> {
		const text = await vscode.window.showInputBox({
			prompt: 'Tripilot Quick Chat',
			placeHolder: '输入你的问题（回车发送，Esc 取消）',
			ignoreFocusOut: true
		});
		if (!text || !text.trim()) return;
		await this.openChatView();
		await this.handleUserMessage(text, this.hostStates.sidebar);
	}

	private async tryExecute(commandId: string, ...args: any[]): Promise<boolean> {
		try {
			await vscode.commands.executeCommand(commandId as any, ...args);
			return true;
		} catch {
			return false;
		}
	}

	private isChatHistoryEnabled(): boolean {
		return Boolean(vscode.workspace.getConfiguration('tripilot').get<boolean>('chatHistory.enabled', false));
	}

	private isGranularExportEnabled(): boolean {
		return Boolean(
			vscode.workspace.getConfiguration('tripilot').get<boolean>('chatHistory.exportGranularEnabled', false)
		);
	}

	private getHistoryDirUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, 'chat-history');
	}

	private async listStoredHistorySessions(): Promise<
		Array<{
			sessionId: string;
			startedAt?: string;
			profileId?: string;
			modelId?: string;
			title?: string;
			lastPreview?: string;
			lastAt?: string;
		}>
	> {
		try {
			const dir = this.getHistoryDirUri();
			const entries = await vscode.workspace.fs.readDirectory(dir);
			const sessionIds = entries
				.filter(([name, type]) => type === vscode.FileType.File && String(name).endsWith('.jsonl'))
				.map(([name]) => String(name).replace(/\.jsonl$/i, ''))
				.filter(Boolean);

			const out: Array<{
				sessionId: string;
				startedAt?: string;
				profileId?: string;
				modelId?: string;
				title?: string;
				lastPreview?: string;
				lastAt?: string;
			}> = [];
			for (const sessionId of sessionIds) {
				try {
					const fileUri = vscode.Uri.joinPath(dir, `${sessionId}.jsonl`);
					const raw = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
					const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

					let startedAt: string | undefined;
					let profileId: string | undefined;
					let modelId: string | undefined;
					let title: string | undefined;
					let lastPreview: string | undefined;
					let lastAt: string | undefined;

					// First line: session_start (best-effort)
					try {
						const firstObj = JSON.parse(lines[0] ?? '');
						if (firstObj && firstObj.kind === 'session_start') {
							startedAt = firstObj.ts ? String(firstObj.ts) : undefined;
							profileId = firstObj.profileId ? String(firstObj.profileId) : undefined;
							modelId = firstObj.modelId ? String(firstObj.modelId) : undefined;
						}
					} catch {
						// ignore
					}

					// Title (Copilot-like): prefer AI-generated title based on prompt only.
					// Fallback: first user message.
					for (let i = Math.max(0, lines.length - 80); i < lines.length; i++) {
						try {
							const ev = JSON.parse(lines[i]);
							if (ev && ev.kind === 'session_title') {
								const t = String(ev.title ?? '').trim();
								if (t) {
									title = t;
									break;
								}
							}
						} catch {
							// ignore
						}
					}
					if (!title) {
						for (let i = 0; i < Math.min(lines.length, 120); i++) {
							try {
								const ev = JSON.parse(lines[i]);
								if (ev && ev.kind === 'user_message') {
									const t = String(ev.text ?? '').trim();
									if (t) {
										title = this.heuristicSessionTitleFromPrompt(t);
										break;
									}
								}
							} catch {
								// ignore
							}
						}
					}

					// Last preview: scan backward for last user/assistant/tool text
					for (let i = lines.length - 1; i >= 0 && lines.length - i <= 200; i--) {
						try {
							const ev = JSON.parse(lines[i]);
							const kind = String(ev?.kind ?? '');
							if (kind === 'user_message' || kind === 'assistant_message' || kind === 'tool_trace') {
								const t = String(ev?.text ?? '').trim();
								if (t) {
									lastPreview = t;
									lastAt = ev?.ts ? String(ev.ts) : undefined;
									break;
								}
							}
							if (kind === 'error') {
								const t = String(ev?.message ?? '').trim();
								if (t) {
									lastPreview = `Error: ${t}`;
									lastAt = ev?.ts ? String(ev.ts) : undefined;
									break;
								}
							}
						} catch {
							// ignore
						}
					}

					const clip = (s?: string, max = 72) => {
						const text = String(s ?? '').replace(/\s+/g, ' ').trim();
						if (!text) return '';
						return text.length > max ? `${text.slice(0, max)}…` : text;
					};

					out.push({
						sessionId,
						startedAt,
						profileId,
						modelId,
						title: clip(title, 64) || undefined,
						lastPreview: clip(lastPreview, 90) || undefined,
						lastAt
					});
				} catch {
					out.push({ sessionId });
				}
			}

			const toMs = (s?: string) => {
				const t = s ? Date.parse(s) : NaN;
				return Number.isFinite(t) ? t : 0;
			};
			// Sort by last activity time first, fallback to startedAt.
			out.sort((a, b) => (toMs(b.lastAt) || toMs(b.startedAt)) - (toMs(a.lastAt) || toMs(a.startedAt)));
			return out;
		} catch {
			return [];
		}
	}

	private formatRelativeTime(iso?: string): string {
		const ms = iso ? Date.parse(iso) : NaN;
		if (!Number.isFinite(ms)) return '';
		const deltaMs = Date.now() - ms;
		const sec = Math.floor(deltaMs / 1000);
		if (sec < 60) return '刚刚';
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min} 分钟前`;
		const hour = Math.floor(min / 60);
		if (hour < 24) return `${hour} 小时前`;
		const day = Math.floor(hour / 24);
		if (day < 30) return `${day} 天前`;
		const month = Math.floor(day / 30);
		if (month < 12) return `${month} 个月前`;
		const year = Math.floor(month / 12);
		return `${year} 年前`;
	}

	private async ensureHistorySessionStarted(state: ChatHostState): Promise<void> {
		if (!this.isChatHistoryEnabled()) return;
		if (state.historySessionId) return;
		try {
			const storageUri = this.getHistoryDirUri();
			state.historyStore = new JsonlChatHistoryStore(storageUri);
			const folder = vscode.workspace.workspaceFolders?.[0];
			state.historySessionId = await state.historyStore.startSession({
				profileId: this.selectedAgentProfileId,
				modelId: this.selectedModelId,
				workspaceFolder: folder
			});
			if (state.kind === 'sidebar' && state.historySessionId) {
				await this.context.globalState.update('tripilot.activeChatSessionId', state.historySessionId);
			}
		} catch {
			// Never block chat on logging.
			state.historyStore = undefined;
			state.historySessionId = undefined;
		}
	}

	private resetConversationForLoadedSession(state: ChatHostState): void {
		state.conversation = [];
		state.contextAttachments = [];
		this.ensureSystemInstructionUpToDate(state);
		this.postContextChips(state);
	}

	private heuristicSessionTitleFromPrompt(promptText: string): string {
		const raw = String(promptText ?? '').trim();
		if (!raw) return 'Chat';
		// Remove fenced code blocks for title generation.
		const withoutFences = raw.replace(/```[\s\S]*?```/g, ' ');
		const firstLine = withoutFences
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find((s) => s.length > 0);
		const line = (firstLine ?? withoutFences).replace(/\s+/g, ' ').trim();
		if (!line) return 'Chat';
		const max = 28; // Copilot-like: short, scannable title
		return line.length > max ? `${line.slice(0, max)}…` : line;
	}

	private sanitizeAiTitle(title: string): string {
		let t = String(title ?? '').trim();
		// Strip wrapping quotes/backticks.
		t = t.replace(/^(["'`“”‘’])+/g, '').replace(/(["'`“”‘’])+$/g, '').trim();
		// Remove trailing punctuation.
		t = t.replace(/[。.!！？…]+$/g, '').trim();
		// Collapse whitespace.
		t = t.replace(/\s+/g, ' ');
		if (!t) return 'Chat';
		const max = 36;
		return t.length > max ? `${t.slice(0, max)}…` : t;
	}

	private async maybeGenerateAndStoreSessionTitle(
		state: ChatHostState,
		promptText: string,
		model?: vscode.LanguageModelChat
	): Promise<void> {
		if (!this.isChatHistoryEnabled()) return;
		await this.ensureHistorySessionStarted(state);
		if (!state.historySessionId) return;
		if (state.currentSessionTitle) return;

		const prompt = String(promptText ?? '').trim();
		if (!prompt) return;

		const fallback = this.heuristicSessionTitleFromPrompt(prompt);
		let title = fallback;
		let source: 'ai' | 'heuristic' = 'heuristic';

		if (model) {
			try {
				const titlePrompt =
					'Generate a short chat title based ONLY on the user\'s message.\n' +
					'- Output ONLY the title text (no quotes, no markdown, no trailing punctuation).\n' +
					'- Keep it short and scannable (<= 8 words for English, <= 18 Chinese characters if Chinese).\n' +
					'- Use the same language as the user.\n\n' +
					`User message:\n${prompt}`;

				const cts = new vscode.CancellationTokenSource();
				const timeout = setTimeout(() => cts.cancel(), 1500);
				try {
					const resp = await model.sendRequest(
						[vscode.LanguageModelChatMessage.User(titlePrompt)],
						{ tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
						cts.token
					);
					let out = '';
					for await (const part of resp.stream) {
						if (part instanceof vscode.LanguageModelTextPart) out += part.value;
					}
					const cleaned = this.sanitizeAiTitle(out);
					if (cleaned && cleaned !== 'Chat') {
						title = cleaned;
						source = 'ai';
					}
				} finally {
					clearTimeout(timeout);
					cts.dispose();
				}
			} catch {
				// fallback
			}
		}

		state.currentSessionTitle = title;
		await this.appendHistory(state, {
			kind: 'session_title',
			title,
			source,
			profileId: this.selectedAgentProfileId,
			modelId: this.selectedModelId
		});
	}

	private async loadSessionIntoHost(sessionId: string, state: ChatHostState): Promise<void> {
		const sid = String(sessionId || '').trim();
		if (!sid) return;
		if (!this.isChatHistoryEnabled()) return;

		const dir = this.getHistoryDirUri();
		const fileUri = vscode.Uri.joinPath(dir, `${sid}.jsonl`);
		const raw = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
		const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

		state.historyStore = new JsonlChatHistoryStore(dir);
		await state.historyStore.resumeSession(sid);
		state.historySessionId = sid;
		state.currentSessionTitle = undefined;
		this.resetConversationForLoadedSession(state);
		if (state.kind === 'sidebar') {
			await this.context.globalState.update('tripilot.activeChatSessionId', sid);
		}

		this.postToHost(state, { type: 'chatReset' });
		state.transcript = [];

		for (const line of lines) {
			try {
				const ev = JSON.parse(line);
				if (!ev || typeof ev !== 'object') continue;
				const kind = String(ev.kind ?? '');
				if (kind === 'session_title') {
					const t = String(ev.title ?? '').trim();
					if (t) state.currentSessionTitle = t;
					continue;
				}
				if (kind === 'user_message') {
					const text = String(ev.text ?? '');
					this.postToHost(state, { type: 'chatAppend', role: 'user', text });
					state.transcript.push({ role: 'user', text });
					state.conversation.push(vscode.LanguageModelChatMessage.User(text));
				} else if (kind === 'assistant_message') {
					const text = String(ev.text ?? '');
					this.postToHost(state, { type: 'chatAppend', role: 'assistant', text });
					state.transcript.push({ role: 'assistant', text });
					state.conversation.push(vscode.LanguageModelChatMessage.Assistant(text));
					this.appendCheckpoint(state);
				} else if (kind === 'tool_trace') {
					const text = String(ev.text ?? '');
					this.postToHost(state, { type: 'chatAppend', role: 'tool', text });
					state.transcript.push({ role: 'tool', text });
				} else if (kind === 'approval_request') {
					const reqId = String(ev.requestId ?? '');
					const summary = ev.summary ? `${ev.summary.editCount ?? 0} edits / ${ev.summary.fileCount ?? 0} files` : '';
					const text = `Approval requested ${reqId}${summary ? ` (${summary})` : ''}`;
					this.postToHost(state, { type: 'chatAppend', role: 'tool', text });
					state.transcript.push({ role: 'tool', text });
				} else if (kind === 'approval_decision') {
					const text = `Approval decision ${String(ev.requestId ?? '')}: ${String(ev.decision ?? '')}`;
					this.postToHost(state, {
						type: 'chatAppend',
						role: 'tool',
						text
					});
					state.transcript.push({ role: 'tool', text });
				} else if (kind === 'error') {
					const text = `Error: ${String(ev.message ?? '')}`;
					this.postToHost(state, { type: 'chatAppend', role: 'assistant', text });
					state.transcript.push({ role: 'assistant', text });
					this.appendCheckpoint(state);
				}
			} catch {
				// ignore malformed line
			}
		}
	}

	public async startNewChatSessionInteractive(host: ChatHostKind = 'sidebar'): Promise<void> {
		const state = this.hostStates[host];
		if (!this.isChatHistoryEnabled()) {
			vscode.window.showWarningMessage('Tripilot: Chat History 未启用（tripilot.chatHistory.enabled=false）。');
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			vscode.window.showWarningMessage('Tripilot: 请先打开一个工作区文件夹再创建会话。');
			return;
		}

		try {
			state.historyStore = new JsonlChatHistoryStore(this.getHistoryDirUri());
			state.historySessionId = await state.historyStore.startSession({
				profileId: this.selectedAgentProfileId,
				modelId: this.selectedModelId,
				workspaceFolder: folder
			});
			state.currentSessionTitle = undefined;
			if (state.kind === 'sidebar') {
				await this.context.globalState.update('tripilot.activeChatSessionId', state.historySessionId);
			}
			this.resetConversationForLoadedSession(state);
			state.transcript = [];
			this.postToHost(state, { type: 'chatReset' });
		} catch (e: any) {
			vscode.window.showErrorMessage(`Tripilot: 创建会话失败：${String(e?.message ?? e)}`);
		}
	}

	public async selectAndLoadChatSessionInteractive(): Promise<void> {
		const state = this.hostStates.sidebar;
		if (!this.isChatHistoryEnabled()) {
			vscode.window.showWarningMessage('Tripilot: Chat History 未启用（tripilot.chatHistory.enabled=false）。');
			return;
		}

		const sessions = await this.listStoredHistorySessions();
		if (!sessions.length) {
			vscode.window.showInformationMessage('Tripilot: 没有找到已保存的会话。');
			return;
		}

		const active = state.historySessionId;
		const items = sessions
			.map((s) => {
				const title = s.title || '(无标题)';
				const rel = this.formatRelativeTime(s.lastAt || s.startedAt);
				const descParts = [rel, s.profileId, s.modelId].filter(Boolean);
				const label = s.sessionId === active ? `${title} (current)` : title;
				return {
					label,
					description: descParts.length ? descParts.join(' · ') : undefined,
					detail: s.lastPreview ? s.lastPreview : s.sessionId,
					picked: s.sessionId === active,
					_sessionId: s.sessionId
				};
			})
			// pin current session first
			.sort((a, b) => Number(Boolean(b.picked)) - Number(Boolean(a.picked)));
		const picked = await vscode.window.showQuickPick(items, {
			title: 'Tripilot: 选择会话',
			placeHolder: '选择要加载的聊天会话（标题取第一条用户消息）',
			matchOnDescription: true,
			matchOnDetail: true
		});
		if (!picked?._sessionId) return;
		try {
			await this.loadSessionIntoHost(picked._sessionId, state);
			vscode.window.showInformationMessage('Tripilot: 已加载会话。');
		} catch (e: any) {
			vscode.window.showErrorMessage(`Tripilot: 加载会话失败：${String(e?.message ?? e)}`);
		}
	}

	public async exportChatHistoryInteractive(): Promise<void> {
		const state = this.hostStates.sidebar;
		if (!this.isChatHistoryEnabled()) {
			vscode.window.showWarningMessage('Tripilot: Chat History 未启用（tripilot.chatHistory.enabled=false）。');
			return;
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			vscode.window.showWarningMessage('Tripilot: 请先打开一个工作区文件夹再导出聊天记录。');
			return;
		}

		const sessions = await this.listStoredHistorySessions();
		if (!sessions.length) {
			vscode.window.showInformationMessage('Tripilot: 没有找到可导出的会话。');
			return;
		}

		const active = state.historySessionId;
		const items = sessions
			.map((s) => {
				const title = s.title || '(无标题)';
				const rel = this.formatRelativeTime(s.lastAt || s.startedAt);
				const descParts = [rel, s.profileId, s.modelId].filter(Boolean);
				const label = s.sessionId === active ? `${title} (current)` : title;
				return { label, description: descParts.length ? descParts.join(' · ') : undefined, detail: s.lastPreview || s.sessionId, _sessionId: s.sessionId };
			})
			.sort((a, b) => Number(b._sessionId === active) - Number(a._sessionId === active));

		const picked = await vscode.window.showQuickPick(items, {
			title: 'Tripilot: 导出聊天记录',
			placeHolder: '选择要导出的会话',
			matchOnDescription: true,
			matchOnDetail: true
		});
		if (!picked?._sessionId) return;

		const sessionId = picked._sessionId;
		const exportsDir = vscode.Uri.joinPath(folder.uri, '.tripilot', 'exports');
		await vscode.workspace.fs.createDirectory(exportsDir);
		const srcUri = vscode.Uri.joinPath(this.getHistoryDirUri(), `${sessionId}.jsonl`);

		if (!this.isGranularExportEnabled()) {
			const destUri = vscode.Uri.joinPath(exportsDir, `tripilot-${sessionId}.jsonl`);
			const bytes = await vscode.workspace.fs.readFile(srcUri);
			await vscode.workspace.fs.writeFile(destUri, bytes);
			vscode.window.showInformationMessage(`Tripilot: 已导出聊天记录到 ${destUri.fsPath}`);
			return;
		}

		const mode = await vscode.window.showQuickPick(
			[
				{ label: '导出全部', detail: 'full' },
				{ label: '选择条目…', detail: 'select' }
			],
			{ title: 'Tripilot: 导出方式' }
		);
		if (!mode?.detail) return;
		if (mode.detail === 'full') {
			const destUri = vscode.Uri.joinPath(exportsDir, `tripilot-${sessionId}.jsonl`);
			const bytes = await vscode.workspace.fs.readFile(srcUri);
			await vscode.workspace.fs.writeFile(destUri, bytes);
			vscode.window.showInformationMessage(`Tripilot: 已导出聊天记录到 ${destUri.fsPath}`);
			return;
		}

		const bytes = await vscode.workspace.fs.readFile(srcUri);
		const raw = Buffer.from(bytes).toString('utf8');
		const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
		const parsed: Array<{ idx: number; line: string; kind: string; ts: string; preview: string }> = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			try {
				const ev = JSON.parse(line);
				const kind = String(ev?.kind ?? '');
				const ts = String(ev?.ts ?? '');
				const preview =
					(kind === 'user_message' || kind === 'assistant_message' || kind === 'tool_trace')
						? String(ev?.text ?? '')
						: kind === 'error'
							? String(ev?.message ?? '')
							: kind === 'approval_request'
								? `approval_request ${String(ev?.requestId ?? '')}`
								: kind === 'approval_decision'
									? `approval_decision ${String(ev?.requestId ?? '')} ${String(ev?.decision ?? '')}`
									: kind;
				parsed.push({ idx: i, line, kind, ts, preview });
			} catch {
				// skip
			}
		}

		const pickItems = parsed.map((p) => ({
			label: `${p.idx + 1}. ${p.kind}${p.ts ? ` · ${p.ts.replace('T', ' ').replace('Z', '')}` : ''}`,
			description: p.preview.length > 80 ? `${p.preview.slice(0, 80)}…` : p.preview,
			detail: String(p.idx)
		}));
		const pickedItems = await vscode.window.showQuickPick(pickItems, {
			title: 'Tripilot: 选择要导出的条目',
			canPickMany: true,
			placeHolder: '可多选（搜索过滤后勾选）'
		});
		if (!pickedItems?.length) return;

		const selectedIdx = new Set(pickedItems.map((p) => Number(p.detail)).filter((n) => Number.isFinite(n)));
		const selectedLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (selectedIdx.has(i)) selectedLines.push(lines[i]);
		}
		const destUri = vscode.Uri.joinPath(exportsDir, `tripilot-${sessionId}-partial.jsonl`);
		await vscode.workspace.fs.writeFile(destUri, Buffer.from(selectedLines.join('\n') + '\n', 'utf8'));
		vscode.window.showInformationMessage(`Tripilot: 已导出选中条目到 ${destUri.fsPath}`);
	}

	private async exportSingleSessionInteractive(sessionId: string, selectEntries: boolean): Promise<void> {
		if (!this.isChatHistoryEnabled()) {
			vscode.window.showWarningMessage('Tripilot: Chat History 未启用（tripilot.chatHistory.enabled=false）。');
			return;
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			vscode.window.showWarningMessage('Tripilot: 请先打开一个工作区文件夹再导出聊天记录。');
			return;
		}

		const exportsDir = vscode.Uri.joinPath(folder.uri, '.tripilot', 'exports');
		await vscode.workspace.fs.createDirectory(exportsDir);
		const srcUri = vscode.Uri.joinPath(this.getHistoryDirUri(), `${sessionId}.jsonl`);

		if (!selectEntries || !this.isGranularExportEnabled()) {
			const destUri = vscode.Uri.joinPath(exportsDir, `tripilot-${sessionId}.jsonl`);
			const bytes = await vscode.workspace.fs.readFile(srcUri);
			await vscode.workspace.fs.writeFile(destUri, bytes);
			vscode.window.showInformationMessage(`Tripilot: 已导出聊天记录到 ${destUri.fsPath}`);
			return;
		}

		const bytes = await vscode.workspace.fs.readFile(srcUri);
		const raw = Buffer.from(bytes).toString('utf8');
		const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
		const parsed: Array<{ idx: number; line: string; kind: string; ts: string; preview: string }> = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			try {
				const ev = JSON.parse(line);
				const kind = String(ev?.kind ?? '');
				const ts = String(ev?.ts ?? '');
				const preview =
					kind === 'user_message' || kind === 'assistant_message' || kind === 'tool_trace'
						? String(ev?.text ?? '')
						: kind === 'error'
							? String(ev?.message ?? '')
							: kind === 'approval_request'
								? `approval_request ${String(ev?.requestId ?? '')}`
								: kind === 'approval_decision'
									? `approval_decision ${String(ev?.requestId ?? '')} ${String(ev?.decision ?? '')}`
									: kind;
				parsed.push({ idx: i, line, kind, ts, preview });
			} catch {
				// skip
			}
		}

		const pickItems = parsed.map((p) => ({
			label: `${p.idx + 1}. ${p.kind}${p.ts ? ` · ${p.ts.replace('T', ' ').replace('Z', '')}` : ''}`,
			description: p.preview.length > 80 ? `${p.preview.slice(0, 80)}…` : p.preview,
			detail: String(p.idx)
		}));
		const pickedItems = await vscode.window.showQuickPick(pickItems, {
			title: 'Tripilot: 选择要导出的条目',
			canPickMany: true,
			placeHolder: '可多选（搜索过滤后勾选）'
		});
		if (!pickedItems?.length) return;

		const selectedIdx = new Set(pickedItems.map((p) => Number(p.detail)).filter((n) => Number.isFinite(n)));
		const selectedLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (selectedIdx.has(i)) selectedLines.push(lines[i]);
		}
		const destUri = vscode.Uri.joinPath(exportsDir, `tripilot-${sessionId}-partial.jsonl`);
		await vscode.workspace.fs.writeFile(destUri, Buffer.from(selectedLines.join('\n') + '\n', 'utf8'));
		vscode.window.showInformationMessage(`Tripilot: 已导出选中条目到 ${destUri.fsPath}`);
	}

	private async appendHistory(state: ChatHostState, event: ChatHistoryEventInput): Promise<void> {
		if (!this.isChatHistoryEnabled()) return;
		await this.ensureHistorySessionStarted(state);
		if (!state.historyStore || !state.historySessionId) return;
		try {
			await state.historyStore.append({
				...(event as any),
				ts: new Date().toISOString(),
				sessionId: state.historySessionId
			});
			// Copilot-like: keep session list previews/titles fresh without requiring manual refresh.
			this.scheduleSessionsRefresh();
		} catch {
			// ignore
		}
	}

	private getChatProvider(): 'vscode-lm' | 'copilot-direct' | 'models-direct' {
		const raw = String(vscode.workspace.getConfiguration('tripilot').get<string>('chatProvider', 'vscode-lm') ?? 'vscode-lm');
		if (raw === 'copilot-direct') return 'copilot-direct';
		if (raw === 'models-direct') return 'models-direct';
		return 'vscode-lm';
	}

	private getModelsDirectConfig(): {
		baseUrl: string;
		apiKey?: string;
		defaultModel?: string;
		modelTagDefault?: string;
		modelTags?: Record<string, string>;
		modelExtras?: Record<string, any>;
		extraFieldName?: string;
	} {
		const cfg = vscode.workspace.getConfiguration('tripilot');
		const baseUrl = String(cfg.get<string>('modelsDirect.baseUrl', '') ?? '').trim();
		const apiKey = String(cfg.get<string>('modelsDirect.apiKey', '') ?? '').trim();
		const defaultModel = String(cfg.get<string>('modelsDirect.defaultModel', '') ?? '').trim();
		const modelTagDefault = String(cfg.get<string>('modelsDirect.modelTagDefault', '') ?? '').trim();
		const extraFieldName = String(cfg.get<string>('modelsDirect.extraFieldName', 'tripilot') ?? 'tripilot').trim();
		const modelTagsRaw = cfg.get<any>('modelsDirect.modelTags', undefined);
		const modelExtrasRaw = cfg.get<any>('modelsDirect.modelExtras', undefined);
		const modelTags = modelTagsRaw && typeof modelTagsRaw === 'object' ? (modelTagsRaw as Record<string, string>) : undefined;
		const modelExtras = modelExtrasRaw && typeof modelExtrasRaw === 'object' ? (modelExtrasRaw as Record<string, any>) : undefined;
		return {
			baseUrl,
			apiKey: apiKey || undefined,
			defaultModel: defaultModel || undefined,
			modelTagDefault: modelTagDefault || undefined,
			modelTags,
			modelExtras,
			extraFieldName: extraFieldName || undefined
		};
	}

	private getCopilotAuthMode(): 'minimal' | 'permissive' {
		const raw = String(
			vscode.workspace.getConfiguration('tripilot').get<string>('copilotDirect.authMode', 'minimal') ?? 'minimal'
		);
		return raw === 'permissive' ? 'permissive' : 'minimal';
	}

	private ensureCopilotSystemInstructionUpToDate(state: ChatHostState): void {
		const instruction = this.buildSystemInstructionForProfile(this.selectedAgentProfileId);
		const msg: OpenAIChatMessage = { role: 'system', content: instruction };
		if (!state.copilotConversation) state.copilotConversation = [];
		if (!state.copilotConversation.length) {
			state.copilotConversation.push(msg);
		} else {
			state.copilotConversation[0] = msg;
		}
		state.copilotInteractionId ??= createUuid();
	}


	private ensureSystemInstructionUpToDate(state: ChatHostState): void {
		const instruction = this.buildSystemInstructionForProfile(this.selectedAgentProfileId);
		const msg = vscode.LanguageModelChatMessage.User(instruction);
		if (!state.conversation.length) {
			state.conversation.push(msg);
			return;
		}
		// Always keep the instruction message as the first conversation item.
		state.conversation[0] = msg;
	}

	private buildSystemInstructionForProfile(profileId: string): string {
		const custom = this.getWorkspaceCustomAgent(profileId);
		const base = [
			'(Tripilot System)',
			'You are Tripilot (小T), a learning assistant running inside TriMetaverse(三元宇宙).',
			'Always refer to yourself as 小T in all replies, regardless of the selected model or mode.',
			'You are tool-aware and may call enabled tools to search/read/edit/create/run as needed to accomplish the user\'s request.',
			'In agent-style workflows, autonomously decide when to call tools. The user does NOT need to type #toolName for you to use tools; #toolName is only a hint to force/guide tool choice.',
			'When the user asks to create or modify files, use createFile/editFiles (with approval) instead of asking the user to manually copy/paste or apply patches.',
			'If edits require approval (for example, sensitive file edits), the UI will show a confirmation card with buttons (Preview/Apply/Cancel). Wait for that UI decision; do NOT ask the user to type preview/apply/cancel as text.',
			'For normal edits, apply edits via tools and rely on the pending edits review (Keep/Undo) instead of adding extra confirmation steps in the chat text.',
			'Only ask clarifying questions when the missing information is truly required to proceed safely. Otherwise, proceed with sensible defaults, show a preview, and let the user approve or adjust.'
		];

		if (custom) {
			const body = String(custom.body ?? '').trim();
			// Keep it bounded to avoid exploding prompt size.
			const bounded = body.length > 8000 ? body.slice(0, 8000) + '\n\n(…truncated)' : body;
			return [
				...base,
				'',
				`(custom agent: ${custom.name})`,
				custom.description ? `Description: ${custom.description}` : undefined,
				'This agent is defined by a workspace .agent.md file. The agent instructions below are prepended to the user prompt.',
				custom.tools?.length ? `Tools (frontmatter.tools): ${custom.tools.join(', ')}` : 'Tools (frontmatter.tools): (default)',
				'',
				'(Custom Agent Instructions)',
				bounded
			]
				.filter((x) => typeof x === 'string' && x.length > 0)
				.join('\n');
		}

		if (profileId === 'ask-study') {
			return [
				...base,
				'',
				'(ask&study mode)',
				'Primary goal: teach and help the user learn. Prefer explanations, mental models, and step-by-step guidance.',
				'Start by confirming the user\'s goal and their background/knowledge level if not clear.',
				'Prefer reading/inspecting over editing. However, when the user explicitly asks to write/update files (for example: "把它写入文件"), do it via tools and the approval flow.',
				'In ask&study, do not require the user to type #createFile/#editFiles to trigger tool use. Decide and invoke the appropriate tool yourself when enabled.',
				'Avoid multi-turn questionnaires for simple write requests. If the target file/path is known and a reasonable default template is acceptable, propose it as a preview and let the user approve or tweak.',
				'All write/modify/execute actions must stay inside the ask&study sandbox directory. If an action would affect files outside the sandbox, refuse and propose a safe alternative inside the sandbox.',
				'Do not use powerful VS Code commands, command tools, or MCP tools unless explicitly allowed by tools/policy. If unavailable, explain and continue without them.',
				'When generating a course/learning plan, structure it as modules, prerequisites, exercises, and checkpoints.'
			].join('\n');
		}

		if (profileId === 'edit-test') {
			return [
				...base,
				'',
				'(edit&test mode)',
				'Primary goal: implement and test changes safely. Prefer small, verifiable steps and run relevant checks when possible.'
			].join('\n');
		}

		if (profileId === 'agent-vm') {
			return [
				...base,
				'',
				'(agent&vm mode)',
				'Primary goal: run and validate in isolated environments. Be explicit about commands and expected outputs.'
			].join('\n');
		}

		if (profileId === 'agent-deploy') {
			return [
				...base,
				'',
				'(agent&deploy mode)',
				'Primary goal: deployment planning and safe execution. Be cautious with destructive actions and credentials; require confirmation for risky steps.'
			].join('\n');
		}

		return base.join('\n');
	}

	public async refreshToolsAndPost() {
		// Placeholder: chat UI tool menu is still local; MCP/tool injection is handled in the tool loop.
		// We keep this hook so Settings changes can trigger a refresh later.
		return;
	}

	private getAskStudySandboxRelFromConfig(): string {
		const raw =
			vscode.workspace.getConfiguration('tripilot').get<string>('askStudySandboxDir', '.tripilot/ask-study') ??
			'.tripilot/ask-study';
		const normalized = path.posix
			.normalize(String(raw).replace(/\\/g, '/'))
			.replace(/^\/+/, '')
			.trim();
		if (!normalized) return '.tripilot/ask-study';
		// Prevent path traversal.
		if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
			throw new Error(`Invalid tripilot.askStudySandboxDir: ${raw}`);
		}
		return normalized;
	}

	private async ensureAskStudySandboxInitializedIfPossible(): Promise<void> {
		if (this.selectedAgentProfileId !== 'ask-study') return;
		// Only initialize when a real model is available.
		const model = this.getSelectedModel();
		if (!model) return;

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) return;
		const rel = this.getAskStudySandboxRelFromConfig();
		const dirUri = vscode.Uri.joinPath(folder.uri, rel);
		await vscode.workspace.fs.createDirectory(dirUri);

		await this.ensureAskStudyReadmeInitialized(dirUri);
		await this.ensureAskStudyRequirementsInitialized(dirUri);
	}

	private async ensureAskStudyReadmeInitialized(dirUri: vscode.Uri): Promise<void> {
		const readmeUri = vscode.Uri.joinPath(dirUri, 'README.md');
		try {
			await vscode.workspace.fs.stat(readmeUri);
			return; // don't overwrite user edits
		} catch {
			// continue
		}

		const readme = `# Tripilot · ask&study 沙盒\n\n欢迎来到 **ask&study**（学习模式）的专属沙盒目录。\n\n## 开始前请先读完\n\n1. 请阅读本文件，开始你的学习之旅。\n2. 你可以把想学习的内容/当前要解决的问题，直接在 Tripilot Chat 对话框和小T多轮沟通。\n   - 也请尽量介绍你的背景与现有知识结构（例如：你的角色/行业、会什么/不会什么、学过哪些课程或做过哪些项目、希望补齐哪些短板）。\n   - 这些信息会帮助小T更准确地制定课程体系与学习领域规划。\n   - 当问题逐渐清晰时，可以对小T说：\n     > “请帮我记录到需求”\n   - 小T会在本目录生成/更新一份需求 Markdown 文档（\`requirements.md\`），便于你审阅与迭代。\n3. 请尽量清楚地告诉小T：你**想实现或达到什么目标/目的**（例如：做出一个产品、拿到某个证书、掌握某项技能、完成一个项目等）。\n   - 目标越明确，小T越容易帮你规划学习领域边界、课程结构与优先级。\n4. 你也可以把一些学习资料放到本目录（例如：文本、笔记、链接清单、视频文件或视频链接）。\n   - 小T可以基于这些资料，帮你生成更体系化的课程大纲、学习路径与阶段练习。\n5. 当需求文档 **1.0.0** 版本确定后，小T会协助你做更全面的梳理：\n   - 从需求到解决方案的整体设计与拆解\n   - 聚焦当前最需要解决问题所需的知识体系\n   - 以及面向长期发展的知识图谱与学习计划\n6. 小T会帮你整理该领域的优质学习来源（专家、博主、视频/文字媒体等），并结合你平时的交流给出阅读建议与精力分配（后续版本逐步完善）。\n7. 小T会协助你制定学习计划并跟踪进度：\n   - 阶段性进步时升级你的学习徽章与能力图\n   - 长期中断或能力退步时进行提醒与调整（后续版本逐步完善）\n   - 你也可以选择是否向潜在雇主/合作伙伴/粉丝公开这些成果\n8. 当学习到一定阶段，你可以尝试把学到的东西做成产品：\n   - ask&study：学习并开始设计产品\n   - edit&test：实现与测试产品\n   - agent&vm：在隔离环境跑通产品\n   - agent&deploy：部署到公共资源并上线变现\n9. 这是一个人人都可以产出产品的时代。相信自己——**学以致用**是学习最大的奖赏。\n\n---\n\n> 提示：ask&study 模式下的写入、修改、运行等操作会被限制在本沙盒目录内，以避免影响你的工作区其它文件。\n`;

		await vscode.workspace.fs.writeFile(readmeUri, Buffer.from(readme, 'utf8'));
	}

	private async ensureAskStudyRequirementsInitialized(dirUri: vscode.Uri): Promise<void> {
		const reqUri = vscode.Uri.joinPath(dirUri, 'requirements.md');
		try {
			await vscode.workspace.fs.stat(reqUri);
			// If file exists, ensure it has frontmatter with version, but do not rewrite the body.
			const raw = Buffer.from(await vscode.workspace.fs.readFile(reqUri)).toString('utf8');
			const ensured = ensureFrontmatterHasVersion(raw, '1.0.0');
			if (ensured !== raw) {
				await vscode.workspace.fs.writeFile(reqUri, Buffer.from(ensured, 'utf8'));
			}
			return;
		} catch {
			// continue
		}

		const initial = `---\nversion: 1.0.0\n---\n\n# 需求（ask&study）\n\n在 Tripilot Chat 里对我说：\n> “请帮我记录到需求”\n\n我会把本次对话中逐步明确的内容，整理到这个文件里。\n`;
		await vscode.workspace.fs.writeFile(reqUri, Buffer.from(initial, 'utf8'));
	}

	private postAgentProfileAndLabel() {
		const profile = this.getEffectiveAgentProfile(this.selectedAgentProfileId);
		const enabledBuiltin = Array.isArray(profile.enabledBuiltinTools) && profile.enabledBuiltinTools.length > 0
			? new Set(profile.enabledBuiltinTools.map((s) => String(s).trim()).filter(Boolean))
			: this.getEnabledBuiltinToolNamesFromConfig();
		const allowedOptionalTools = Array.from(OPTIONAL_TOOL_NAMES);
		const enabledOptionalTools = Array.from(OPTIONAL_TOOL_NAMES).filter((t) => enabledBuiltin.has(t));
		this.postAny({
			type: 'agentProfile',
			id: this.selectedAgentProfileId,
			label: profile?.name ?? this.selectedAgentProfileId,
			allowedOptionalTools,
			enabledOptionalTools
		});
	}

	private getEnabledBuiltinToolNamesFromConfig(): Set<string> {
		// Important: do NOT pass a defaultValue here.
		// VS Code configuration already has extension-contributed defaults; passing a defaultValue
		// can mask those defaults and accidentally return an empty list, which disables all tools.
		const raw = vscode.workspace.getConfiguration('tripilot').get<any>('enabledBuiltinTools');
		const arr = Array.isArray(raw) ? raw : [];
		const normalized = arr.map((s) => String(s).trim()).filter(Boolean);
		// Defensive fallback: if configuration is missing/empty, use the curated Copilot-like surface.
		return new Set(normalized.length ? normalized : Array.from(OPTIONAL_TOOL_NAMES));
	}

	private getCommandToolConfigsFromConfig(): CommandToolConfig[] {
		const raw = vscode.workspace.getConfiguration('tripilot').get<any[]>('commandTools', []) ?? [];
		return raw
			.map((t) => ({
				name: String(t?.name ?? '').trim(),
				command: String(t?.command ?? '').trim(),
				description: t?.description ? String(t.description) : undefined,
				enabled: Boolean(t?.enabled)
			}))
			.filter((t) => t.name && t.command);
	}

	private getMcpServerConfigsFromConfig(): McpServerConfig[] {
		const raw = vscode.workspace.getConfiguration('tripilot').get<any[]>('mcpServers', []) ?? [];
		return raw
			.map((s) => ({
				id: String(s?.id ?? '').trim(),
				name: String(s?.name ?? '').trim(),
				enabled: Boolean(s?.enabled),
				transport: String(s?.transport ?? 'stdio') as any,
				command: s?.command ? String(s.command) : undefined,
				args: Array.isArray(s?.args) ? s.args.map(String) : undefined,
				cwd: s?.cwd ? String(s.cwd) : undefined,
				env: s?.env && typeof s.env === 'object' ? (s.env as any) : undefined,
				url: s?.url ? String(s.url) : undefined
			}))
			.filter((s) => s.id && s.name);
	}

	private parseToolDirectives(text: string): ToolReferences {
		const toolReferences = new Set<string>();
		const serverReferences = new Set<string>();
		const re = /(^|\s)([#@])([A-Za-z0-9_.\-\/]+)/g;
		for (const match of text.matchAll(re)) {
			const sigil = match[2];
			const value = match[3];
			if (!value) continue;
			// Do not treat prompt syntax markers as tool directives.
			// Example: "#tool:readFile" should NOT force tool "tool".
			try {
				const endIndex = (match.index ?? -1) + match[0].length;
				const nextChar = endIndex >= 0 && endIndex < text.length ? text[endIndex] : '';
				if (sigil === '#' && (value === 'file' || value === 'tool') && nextChar === ':') {
					continue;
				}
			} catch {
				// ignore
			}
			if (sigil === '#') {
				toolReferences.add(value);
				// Allow #server.tool to imply enabling that MCP server.
				const dot = value.indexOf('.');
				if (dot > 0) {
					serverReferences.add(value.slice(0, dot));
				}
			}
			else serverReferences.add(value);
		}
		return { toolReferences, serverReferences };
	}

	private computeEnabledMcpServerIds(
		profile: any,
		isAskStudy: boolean,
		mcpConfigs: McpServerConfig[],
		serverReferences: Set<string>
	): Set<string> {
		const mcpEnabledSetRaw: Set<string> = profile.enabledMcpServers
			? new Set<string>(profile.enabledMcpServers.map((s: any) => String(s).trim()).filter(Boolean))
			: new Set<string>(mcpConfigs.filter((s) => s.enabled).map((s) => s.id));
		const mcpEnabledSet: Set<string> = isAskStudy
			? new Set<string>(Array.from(mcpEnabledSetRaw).filter((id) => ASK_STUDY_ALLOWED_MCP_SERVER_IDS.has(id)))
			: mcpEnabledSetRaw;
		const enabledServerIds = new Set<string>(mcpEnabledSet);
		for (const id of serverReferences) enabledServerIds.add(id);
		return enabledServerIds;
	}

	private enableReferencedTools(enabledTools: Set<string>, toolDefinitions: any[], toolReferences: Set<string>): void {
		if (!toolReferences.size) return;
		const normalizeRef = (rawName: string): string => {
			const name = String(rawName ?? '').trim();
			if (!name) return '';
			// Back-compat for older prompts/docs that reference internal snake_case tool names.
			const map: Record<string, string> = {
				// read
				read_file: 'readFile',
				get_errors: 'problems',
				terminal_last_command: 'terminalLastCommand',
				terminal_selection: 'terminalSelection',
				copilot_getNotebookSummary: 'getNotebookSummary',
				read_notebook_cell_output: 'readNotebookCellOutput',
				get_task_output: 'getTaskOutput',
				// search
				file_search: 'fileSearch',
				grep_search: 'textSearch',
				list_dir: 'listDirectory',
				get_search_view_results: 'searchResults',
				semantic_search: 'codebase',
				list_code_usages: 'usages',
				get_changed_files: 'changes',
				// edit
				create_directory: 'createDirectory',
				create_file: 'createFile',
				apply_patch: 'editFiles',
				edit_files: 'editFiles',
				edit_notebook_file: 'editNotebook',
				create_new_jupyter_notebook: 'newJupyterNotebook',
				// execute
				run_in_terminal: 'runInTerminal',
				get_terminal_output: 'getTerminalOutput',
				create_and_run_task: 'createAndRunTask',
				run_task: 'runTask',
				run_tests: 'runTests',
				test_failure: 'testFailure',
				run_notebook_cell: 'runNotebookCell',
				// vscode
				install_extension: 'installExtension',
				open_simple_browser: 'openSimpleBrowser',
				run_vscode_command: 'runCommand',
				create_new_workspace: 'newWorkspace',
				get_project_setup_info: 'getProjectSetupInfo',
				get_vscode_api: 'vscodeAPI',
				// web
				fetch_webpage: 'fetch',
				github_repo: 'githubRepo'
			};
			return map[name] ?? name;
		};
		const definedNames = new Set<string>();
		for (const d of toolDefinitions ?? []) {
			try {
				const name = String(d?.function?.name ?? '').trim();
				if (name) definedNames.add(name);
			} catch {
				// ignore
			}
		}
		for (const ref of toolReferences) {
			const name = normalizeRef(ref);
			if (!name) continue;
			// Expand tool sets (e.g. #edit / #search) into underlying tool names.
			if (!definedNames.has(name) && TOOL_SET_NAMES.has(name)) {
				const set = TOOL_SETS[name];
				for (const t of set?.tools ?? []) {
					if (definedNames.has(t)) enabledTools.add(t);
				}
				continue;
			}
			if (definedNames.has(name)) enabledTools.add(name);
		}
	}

	private async buildToolsForRequest(profileId: string, serverReferences: Set<string>, toolReferences: Set<string>): Promise<{
		toolDefinitions: ReturnType<typeof getToolDefinitions>;
		enabledTools: Set<string>;
		commandTools: Map<string, CommandToolConfig>;
	}> {
		const profile = this.getEffectiveAgentProfile(profileId);
		const isAskStudy = profile.id === 'ask-study';
		const effectiveServerRefs = isAskStudy
			? new Set<string>(Array.from(serverReferences).filter((s) => ASK_STUDY_ALLOWED_MCP_SERVER_IDS.has(s)))
			: serverReferences;
		const effectiveToolRefs = isAskStudy ? new Set<string>(Array.from(toolReferences)) : toolReferences;
		const builtinDefs = getToolDefinitions();
		// Treat an empty enabledBuiltinTools array as "use defaults".
		// This prevents accidentally disabling all built-in tools (including write tools) for a profile.
		const builtinEnabled = Array.isArray(profile.enabledBuiltinTools) && profile.enabledBuiltinTools.length > 0
			? new Set(profile.enabledBuiltinTools.map((s) => String(s).trim()).filter(Boolean))
			: this.getEnabledBuiltinToolNamesFromConfig();

		const cmdConfigs = this.getCommandToolConfigsFromConfig();
		const cmdEnabledSetRaw = profile.enabledCommandTools
			? new Set(profile.enabledCommandTools.map((s) => String(s).trim()).filter(Boolean))
			: new Set(cmdConfigs.filter((t) => t.enabled).map((t) => t.name));
		const cmdEnabledSet = isAskStudy
			? new Set(Array.from(cmdEnabledSetRaw).filter((n) => ASK_STUDY_ALLOWED_COMMAND_TOOL_NAMES.has(n)))
			: cmdEnabledSetRaw;
		const cmdIncluded = cmdConfigs.filter(
			(t) =>
				cmdEnabledSet.has(t.name) ||
				(effectiveToolRefs.has(t.name) && (!isAskStudy || ASK_STUDY_ALLOWED_COMMAND_TOOL_NAMES.has(t.name)))
		);
		const cmdMap = new Map<string, CommandToolConfig>();
		for (const t of cmdConfigs) cmdMap.set(t.name, t);
		const cmdDefs: any[] = cmdIncluded.map((t) => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description
					? `Command tool: ${t.command}. ${t.description}`
					: `Command tool: ${t.command}.`,
				parameters: {
					type: 'object',
					properties: {
						args: { type: 'array', items: {}, description: 'Arguments array passed to VS Code command.' }
					}
				}
			}
		}));

		const mcpConfigs = this.getMcpServerConfigsFromConfig();
		const enabledServerIds = this.computeEnabledMcpServerIds(profile as any, isAskStudy, mcpConfigs, effectiveServerRefs);
		const effectiveMcpConfigs = mcpConfigs.map((s) => ({ ...s, enabled: enabledServerIds.has(s.id) }));
		await this.mcpManager.refresh(effectiveMcpConfigs);

		// Best-effort connect (bounded) so tools become callable quickly.
		const timeoutMs = 2500;
		for (const id of enabledServerIds) {
			await Promise.race([
				this.mcpManager.ensureConnected(id),
				new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
			]);
		}

		const mcpTools = this.mcpManager.getToolsForEnabledServers(enabledServerIds);
		const mcpDefs: any[] = mcpTools.map((t) => ({
			type: 'function',
			function: {
				name: t.lmToolName,
				description: t.description
					? `MCP(${t.serverName}/${t.serverId}): ${t.toolName}. ${t.description}`
					: `MCP(${t.serverName}/${t.serverId}): ${t.toolName}.`,
				parameters: t.inputSchema ?? { type: 'object', properties: {} }
			}
		}));

		// Optional alias definitions: allow #server.tool to reference an MCP tool without exposing internal lmToolName.
		// We keep aliases disabled by default (only enabled when user explicitly forces them via #...).
		const isSafe = (s: string) => /^[A-Za-z0-9_.\-\/]+$/.test(String(s));
		const mcpAliasDefs: any[] = [];
		for (const t of mcpTools) {
			if (!isSafe(t.serverId) || !isSafe(t.toolName)) continue;
			const aliasName = `${t.serverId}.${t.toolName}`;
			mcpAliasDefs.push({
				type: 'function',
				function: {
					name: aliasName,
					description: t.description
						? `MCP alias for ${t.serverName}/${t.serverId}: ${t.toolName}. ${t.description}`
						: `MCP alias for ${t.serverName}/${t.serverId}: ${t.toolName}.`,
					parameters: t.inputSchema ?? { type: 'object', properties: {} }
				}
			});
		}

		const toolDefinitions: any[] = [...builtinDefs, ...cmdDefs, ...mcpDefs, ...mcpAliasDefs];
		const enabledTools = new Set<string>();
		for (const t of builtinDefs) {
			if (builtinEnabled.has(t.function.name)) enabledTools.add(t.function.name);
		}
		for (const t of cmdIncluded) enabledTools.add(t.name);
		for (const t of mcpDefs) enabledTools.add(String(t.function.name));
		// Only enable explicitly referenced tools if they exist in toolDefinitions.
		this.enableReferencedTools(enabledTools, toolDefinitions, effectiveToolRefs);

		return { toolDefinitions: toolDefinitions as any, enabledTools, commandTools: cmdMap };
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		// Ensure the view header title is stable and not derived from extension display name.
		webviewView.title = 'Chat';
		this.hostStates.sidebar.webview = webviewView.webview;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri]
		};

		webviewView.webview.html = this.getHtml(webviewView.webview, 'sidebar');
		this.webviews.add(webviewView.webview);
		try {
			webviewView.onDidDispose(() => {
				this.webviews.delete(webviewView.webview);
				if (this.hostStates.sidebar.webview === webviewView.webview) this.hostStates.sidebar.webview = undefined;
			});
		} catch {
			// ignore
		}

		webviewView.webview.onDidReceiveMessage(async (msg: WebviewInboundMessage) => {
			await this.handleInboundMessage(webviewView.webview, msg);
		});
	}

	private async handleInboundMessage(webview: vscode.Webview, msg: WebviewInboundMessage): Promise<void> {
		const host: ChatHostKind = this.hostStates.editor.webview === webview ? 'editor' : 'sidebar';
		const state = this.hostStates[host];
		switch (msg.type) {
			case 'webviewReady':
				// Init is per-webview; global state (models/profile) is broadcast.
				void webview.postMessage({ type: 'init', extensionName: '' } satisfies WebviewOutboundMessage);
				void webview.postMessage({ type: 'host', host } satisfies WebviewOutboundMessageExtended);
				state.contextAttachments ??= [];
				void webview.postMessage({ type: 'contextChips', items: attachmentsToChips(state.contextAttachments) } as any);
				void webview.postMessage({ type: 'toolChips', items: Array.isArray(state.lastToolReferences) ? state.lastToolReferences : [] } as any);
				// Do not scan workspace custom agents on startup; it can be slow on some filesystems (e.g. OneDrive).
				// Settings > Custom Agents or filesystem watchers will refresh the list when needed.
				this.postAgentsList();
				this.postAgentProfileAndLabel();
				void this.refreshModelsAndPost(state);
				void this.ensureAskStudySandboxInitializedIfPossible();
				// If this host was opened via "move to editor", replay the pinned session/transcript.
				const didReplayOnReady = Boolean(state.replayOnReady);
				if (state.replayOnReady) {
					const replay = state.replayOnReady;
					state.replayOnReady = undefined;
					if (replay.kind === 'session') {
						await this.loadSessionIntoHost(replay.sessionId, state);
					} else {
						this.postToHost(state, { type: 'chatReset' });
						for (const item of replay.transcript) {
							if ((item as any).role === 'checkpoint') {
								this.postToHost(state, { type: 'chatCheckpoint', checkpointId: (item as any).checkpointId });
								continue;
							}
							const msgItem = item as Extract<ChatTranscriptItem, { role: 'user' | 'assistant' | 'tool' }>;
							this.postToHost(state, { type: 'chatAppend', role: msgItem.role, text: msgItem.text });
						}

						// If a run is in-flight, do not mutate conversation/transcript arrays (they are being used by the request).
						if (!state.isBusy) {
							state.transcript = [...replay.transcript];
							state.conversation = [];
							this.ensureSystemInstructionUpToDate(state);
							for (const item of state.transcript) {
								if (item.role === 'user') state.conversation.push(vscode.LanguageModelChatMessage.User(item.text));
								else if (item.role === 'assistant') state.conversation.push(vscode.LanguageModelChatMessage.Assistant(item.text));
							}
						}
					}
				}
				// If this is a fresh webview instance, re-render existing in-memory transcript (covers temp sessions).
				if (!didReplayOnReady && state.transcript.length > 0) {
					this.postToHost(state, { type: 'chatReset' });
					for (const item of state.transcript) {
						if ((item as any).role === 'checkpoint') {
							this.postToHost(state, { type: 'chatCheckpoint', checkpointId: (item as any).checkpointId });
							continue;
						}
						const msgItem = item as Extract<ChatTranscriptItem, { role: 'user' | 'assistant' | 'tool' }>;
						this.postToHost(state, { type: 'chatAppend', role: msgItem.role, text: msgItem.text });
					}
					if (state.inProgressAssistantText && state.isBusy) {
						this.postToHost(state, { type: 'chatAssistantStart' } as any);
						this.postToHost(state, { type: 'chatAssistantDelta', delta: state.inProgressAssistantText } as any);
					}
				}
				if (host === 'sidebar') {
					await this.maybeAutoLoadMostRecentSessionIntoSidebar(state);
					await this.refreshSessionsAndPost();
				}
				break;
			case 'requestWorkspaceContext': {
				const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
				void webview.postMessage({ type: 'workspaceContext', workspaceFolders: folders } satisfies WebviewOutboundMessage);
				break;
			}
			case 'cancel':
				state.abortController?.abort();
				state.abortController = undefined;
				state.lmCancelSource?.cancel();
				state.lmCancelSource?.dispose();
				state.lmCancelSource = undefined;
				state.isBusy = false;
				state.inProgressAssistantText = undefined;
				if (this.pendingEditApproval?.originHost === host) {
					this.resolvePendingEditApproval('cancel');
				}
				this.setAndPostStatus(state, 'idle');
				break;
			case 'chatUserMessage':
				await this.handleUserMessage(msg.text, state);
				break;
			case 'editApprovalAction':
				await this.handleEditApprovalAction(state, msg);
				break;
			case 'editReviewAction':
				await this.handleEditReviewAction(state, msg);
				break;
			case 'checkpointAction':
				await this.handleCheckpointAction(state, msg);
				break;
			case 'uiAction':
				if (isSettingsPerfEnabled()) {
					const anyMsg = msg as any;
					const clientTs = typeof anyMsg?.clientTs === 'number' ? anyMsg.clientTs : undefined;
					if (clientTs) {
						const delta = Date.now() - clientTs;
						settingsPerfLog(`[ui] uiAction recv action=${msg.action} host=${host} delta=${delta}ms`);
					} else {
						settingsPerfLog(`[ui] uiAction recv action=${msg.action} host=${host}`);
					}
				}
				await this.handleUiAction(state, msg.action, msg.payload);
				break;
	}
	}

	private async maybeAutoLoadMostRecentSessionIntoSidebar(state: ChatHostState): Promise<void> {
		if (state.kind !== 'sidebar') return;
		if (!this.isChatHistoryEnabled()) return;
		// Do not interfere with an in-flight run.
		if (state.isBusy) return;
		// If there is already something selected or displayed, keep it.
		if (state.historySessionId) return;
		if (state.transcript.length > 0) return;

		const archivedRaw = this.context.globalState.get<string[]>('tripilot.archivedSessionIds') ?? [];
		const archived = new Set(archivedRaw.map((s) => String(s).trim()).filter(Boolean));

		const tryLoad = async (sid: string): Promise<boolean> => {
			const id = String(sid ?? '').trim();
			if (!id) return false;
			if (archived.has(id)) return false;
			try {
				await this.loadSessionIntoHost(id, state);
				return true;
			} catch {
				return false;
			}
		};

		// Prefer last active session id (if present), otherwise pick most-recent unarchived session.
		const activeSid = String(this.context.globalState.get<string>('tripilot.activeChatSessionId') ?? '').trim();
		if (activeSid && (await tryLoad(activeSid))) return;

		const sessions = await this.listStoredHistorySessions();
		const mostRecent = sessions.find((s) => s?.sessionId && !archived.has(s.sessionId))?.sessionId;
		if (mostRecent) {
			await tryLoad(mostRecent);
		}
	}

	private postContextChips(state: ChatHostState): void {
		state.contextAttachments ??= [];
		this.postToHost(state, { type: 'contextChips', items: attachmentsToChips(state.contextAttachments) } as any);
	}

	private postToolChips(state: ChatHostState): void {
		const items = Array.isArray(state.lastToolReferences) ? state.lastToolReferences : [];
		this.postToHost(state, { type: 'toolChips', items } as any);
	}

	private addContextAttachment(state: ChatHostState, attachment: ContextAttachment): void {
		state.contextAttachments ??= [];
		if (state.contextAttachments.some((a) => a.id === attachment.id)) return;
		const MAX_ATTACHMENTS = 12;
		state.contextAttachments.push(attachment);
		if (state.contextAttachments.length > MAX_ATTACHMENTS) {
			state.contextAttachments = state.contextAttachments.slice(state.contextAttachments.length - MAX_ATTACHMENTS);
		}
		this.postContextChips(state);
	}

	private removeContextAttachment(state: ChatHostState, id: string): void {
		const raw = String(id ?? '').trim();
		if (!raw) return;
		state.contextAttachments ??= [];
		const before = state.contextAttachments.length;
		state.contextAttachments = state.contextAttachments.filter((a) => a.id !== raw);
		if (state.contextAttachments.length !== before) {
			this.postContextChips(state);
		}
	}

	private async addContextInteractive(state: ChatHostState): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const hasEditor = Boolean(editor && editor.document);
		const selectionText =
			editor && !editor.selection.isEmpty ? String(editor.document.getText(editor.selection) ?? '') : '';
		const hasSelection = Boolean(selectionText.trim());

		type PickKind = 'selection' | 'activeFile' | 'pickFiles';
		type PickItem = vscode.QuickPickItem & { tpKind: PickKind };

		const items: PickItem[] = [];
		if (hasSelection && editor) {
			const rel = safeWorkspaceRelativePath(editor.document.uri);
			items.push({
				tpKind: 'selection',
				label: '添加当前选区',
				detail: rel ? `${rel}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}` : undefined
			});
		}
		if (hasEditor && editor) {
			const rel = safeWorkspaceRelativePath(editor.document.uri);
			items.push({ tpKind: 'activeFile', label: '添加当前文件', detail: rel || editor.document.fileName });
		}
		items.push({ tpKind: 'pickFiles', label: '选择文件…', detail: '从工作区选择一个或多个文件' });

		const picked = await vscode.window.showQuickPick(items, {
			title: 'Tripilot: 添加上下文',
			canPickMany: true,
			ignoreFocusOut: true
		});
		if (!picked || picked.length === 0) return;

		const maxChars = 20000;
		let added = 0;

		for (const p of picked) {
			if (p.tpKind === 'selection' && editor && hasSelection) {
				const doc = editor.document;
				const r = editor.selection;
				let text = selectionText;
				if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
				const rel = safeWorkspaceRelativePath(doc.uri) || path.basename(doc.fileName);
				const label = `选区: ${rel}:${r.start.line + 1}-${r.end.line + 1}`;
				const id = `sel:${doc.uri.toString()}:${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
				this.addContextAttachment(state, {
					id,
					kind: 'selection',
					label,
					text,
					languageId: doc.languageId,
					source: {
						uri: doc.uri.toString(),
						range: {
							startLine: r.start.line,
							startCharacter: r.start.character,
							endLine: r.end.line,
							endCharacter: r.end.character
						}
					}
				});
			}

			if (p.tpKind === 'activeFile' && editor) {
				const doc = editor.document;
				let text = String(doc.getText() ?? '');
				let truncated = false;
				if (text.length > maxChars) {
					text = text.slice(0, maxChars) + '\n…(truncated)';
					truncated = true;
				}
				const rel = safeWorkspaceRelativePath(doc.uri) || path.basename(doc.fileName);
				const label = `文件: ${rel}`;
				const id = `file:${doc.uri.toString()}`;
				this.addContextAttachment(state, {
					id,
					kind: 'file',
					label,
					uri: doc.uri.toString(),
					text,
					languageId: doc.languageId,
					truncated
				});
				added++;
				continue;
			}

			if (p.tpKind === 'pickFiles') {
				const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
				const uris = await vscode.window.showOpenDialog({
					title: 'Tripilot: 选择要附加到聊天的文件',
					defaultUri,
					canSelectMany: true,
					canSelectFiles: true,
					canSelectFolders: false,
					openLabel: '添加'
				});
				if (!uris || uris.length === 0) continue;
				for (const uri of uris) {
					try {
						const doc = await vscode.workspace.openTextDocument(uri);
						let text = String(doc.getText() ?? '');
						let truncated = false;
						if (text.length > maxChars) {
							text = text.slice(0, maxChars) + '\n…(truncated)';
							truncated = true;
						}
						const rel = safeWorkspaceRelativePath(uri) || path.basename(uri.fsPath);
						const label = `文件: ${rel}`;
						const id = `file:${uri.toString()}`;
						this.addContextAttachment(state, {
							id,
							kind: 'file',
							label,
							uri: uri.toString(),
							text,
							languageId: doc.languageId,
							truncated
						});
						added++;
					} catch {
						// ignore unreadable/binary
					}
				}
			}
		}

		if (added > 0) {
			this.postToHost(state, { type: 'chatAppend', role: 'tool', text: `已添加上下文：${added} 项` });
		} else {
			this.postToHost(state, { type: 'chatAppend', role: 'tool', text: '未添加任何上下文（可能没有可用选区，或文件无法读取）。' });
		}
	}

	private parsePromptSyntax(text: string): { cleanText: string; fileRefs: string[]; toolRefs: string[] } {
		const raw = String(text ?? '');
		const fileRefs: string[] = [];
		const toolRefs: string[] = [];
		// Copilot-like prompt markers: #file:<path> and #tool:<toolName>
		// - filePath: any non-whitespace, not containing '#'
		// - toolName: [\w_\-\.\/]+
		// - ignore markers inside markdown links like [text](...)
		const tokenRe = /#file:(?<filePath>[^\s#]+)|#tool:(?<toolName>[\w_\-\.\/]+)/gi;
		const scrubRe = /(^|\s)(?:#file:[^\s#]+|#tool:[\w_\-\.\/]+)/gi;
		const linkRanges: Array<{ start: number; end: number }> = [];
		for (const linkMatch of raw.matchAll(/\[[^\]]*?\]\([^\)]*?\)/g)) {
			if (typeof linkMatch.index !== 'number') continue;
			linkRanges.push({ start: linkMatch.index, end: linkMatch.index + linkMatch[0].length });
		}
		const isInLink = (index: number) => linkRanges.some((r) => index >= r.start && index < r.end);
		for (const m of raw.matchAll(tokenRe)) {
			if (typeof m.index === 'number' && isInLink(m.index)) continue;
			const filePath = m.groups?.filePath;
			const toolName = m.groups?.toolName;
			if (filePath) fileRefs.push(String(filePath));
			else if (toolName) toolRefs.push(String(toolName));
		}
		const cleanText = raw.replace(scrubRe, '$1');
		return { cleanText, fileRefs, toolRefs };
	}

	private resolveFileRefToUri(ref: string): vscode.Uri | undefined {
		const raw = String(ref ?? '').trim();
		if (!raw) return undefined;
		// Allow file:// URIs.
		if (/^file:/i.test(raw)) {
			try {
				return vscode.Uri.parse(raw);
			} catch {
				return undefined;
			}
		}
		// Treat leading-slash paths as workspace-relative (Copilot-style).
		if (raw.startsWith('/')) {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) return undefined;
			const segments = raw.slice(1).split('/').filter(Boolean);
			if (!segments.length) return undefined;
			return vscode.Uri.joinPath(folder.uri, ...segments);
		}
		// Absolute filesystem paths.
		if (path.isAbsolute(raw)) {
			return vscode.Uri.file(raw);
		}
		// Workspace-relative.
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) return undefined;
		const normalized = raw.replace(/^\.\//, '').replace(/^\.\\/, '');
		const segments = normalized.split(/[\\/]+/).filter(Boolean);
		if (!segments.length) return undefined;
		return vscode.Uri.joinPath(folder.uri, ...segments);
	}

	private async attachFilesFromPromptRefs(state: ChatHostState, refs: string[]): Promise<void> {
		if (!Array.isArray(refs) || refs.length === 0) return;
		state.contextAttachments ??= [];
		const maxChars = 20000;
		for (const r of refs) {
			const uri = this.resolveFileRefToUri(r);
			if (!uri) continue;
			const id = `file:${uri.toString()}`;
			if (state.contextAttachments.some((a) => a.id === id)) continue;
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				let text = String(doc.getText() ?? '');
				let truncated = false;
				if (text.length > maxChars) {
					text = text.slice(0, maxChars) + '\n…(truncated)';
					truncated = true;
				}
				const rel = safeWorkspaceRelativePath(uri) || path.basename(uri.fsPath);
				const label = `文件: ${rel}`;
				this.addContextAttachment(state, {
					id,
					kind: 'file',
					label,
					uri: uri.toString(),
					text,
					languageId: doc.languageId,
					truncated
				});
			} catch {
				// ignore unreadable/binary
			}
		}
	}

	private buildUserTextWithContext(state: ChatHostState, userText: string): string {
		const raw = String(userText ?? '');
		const attachments = state.contextAttachments ?? [];
		if (!attachments.length) return raw;
		const parts: string[] = [];
		parts.push(raw.trimEnd());
		parts.push('');
		parts.push('---');
		parts.push('[Tripilot attached context]');
		for (const a of attachments) {
			const header = a.kind === 'file' ? `${a.label}${a.truncated ? ' (truncated)' : ''}` : a.label;
			parts.push('');
			parts.push(`### ${header}`);
			const lang = a.languageId ? String(a.languageId).trim() : '';
			parts.push('```' + (lang || ''));
			parts.push(String(a.text ?? ''));
			parts.push('```');
		}
		parts.push('---');
		return parts.join('\n');
	}

	private extractSubagentNodesFromToolLines(args: {
		toolLines: string[];
		parentId: string;
		sessionId?: string;
		traceId?: string;
	}): Array<{
		id: string;
		parentId: string | null;
		label: string;
		type: 'main' | 'subagent';
		status: 'idle' | 'working' | 'done' | 'error';
		sessionId?: string;
		traceId?: string;
		eventId?: string;
		eventSeq?: number;
	}> {
		const out: Array<{
			id: string;
			parentId: string | null;
			label: string;
			type: 'main' | 'subagent';
			status: 'idle' | 'working' | 'done' | 'error';
			sessionId?: string;
			traceId?: string;
			eventId?: string;
			eventSeq?: number;
		}> = [];

		let subIndex = 0;
		const stack: Array<{ id: string; index: number }> = [];
		const baseId = String(args.parentId || 'root').replace(/[^a-zA-Z0-9_.-]/g, '_');

		for (let i = 0; i < args.toolLines.length; i++) {
			const line = String(args.toolLines[i] ?? '').trim();
			const start = line.match(/^→\s+runSubagent\((.*)\)$/);
			if (start) {
				subIndex += 1;
				let desc = `SubAgent #${subIndex}`;
				const raw = String(start[1] ?? '').trim();
				try {
					const parsed = JSON.parse(raw);
					const d = String(parsed?.description ?? '').trim();
					if (d) desc = d;
				} catch {
					// ignore malformed previews
				}

				const parent = stack.length ? stack[stack.length - 1].id : args.parentId;
				const nodeId = `${baseId}.subagent.${subIndex}`;
				out.push({
					id: nodeId,
					parentId: parent,
					label: desc,
					type: 'subagent',
					status: 'working',
					sessionId: args.sessionId,
					traceId: args.traceId,
					eventId: `evt_subagent_start_${i + 1}`,
					eventSeq: i + 1
				});
				stack.push({ id: nodeId, index: out.length - 1 });
				continue;
			}

			if (/^←\s+runSubagent:\s*/.test(line)) {
				const current = stack.pop();
				if (!current) continue;
				const preview = line.replace(/^←\s+runSubagent:\s*/, '').trim();
				const nextStatus: 'done' | 'error' = /error|failed|exception/i.test(preview) ? 'error' : 'done';
				out[current.index] = {
					...out[current.index],
					status: nextStatus,
					eventId: `evt_subagent_end_${i + 1}`,
					eventSeq: i + 1
				};
			}
		}

		return out;
	}

	private async readSessionToolTraceLines(sessionId: string): Promise<string[]> {
		const sid = String(sessionId ?? '').trim();
		if (!sid) return [];

		const hit = this.subagentTraceCache.get(sid);
		if (hit && Date.now() - hit.atMs <= 5_000) return hit.lines;

		try {
			const fileUri = vscode.Uri.joinPath(this.getHistoryDirUri(), `${sid}.jsonl`);
			const raw = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
			const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
			const toolLines: string[] = [];
			for (const line of lines) {
				try {
					const ev = JSON.parse(line);
					if (String(ev?.kind ?? '') !== 'tool_trace') continue;
					const text = String(ev?.text ?? '').trim();
					if (text) toolLines.push(text);
				} catch {
					// ignore malformed lines
				}
			}
			this.subagentTraceCache.set(sid, { atMs: Date.now(), lines: toolLines });
			return toolLines;
		} catch {
			return [];
		}
	}

	private async postSubagentTree(state: ChatHostState): Promise<void> {
		const sessionId = String(state.historySessionId ?? '').trim() || undefined;
		const traceId = sessionId ? `trc_${sessionId}` : 'trc_live';

		const nodes: Array<{
			id: string;
			parentId: string | null;
			label: string;
			type: 'main' | 'subagent';
			status: 'idle' | 'working' | 'done' | 'error';
			sessionId?: string;
			traceId?: string;
			eventId?: string;
			eventSeq?: number;
		}> = [];

		nodes.push({
			id: 'agent.root',
			parentId: null,
			label: state.currentSessionTitle ? `Agent VM · ${state.currentSessionTitle}` : 'Agent VM',
			type: 'main',
			status: state.isBusy ? 'working' : 'idle',
			sessionId,
			traceId,
			eventId: 'evt_root'
		});

		const toolLines = (state.transcript ?? [])
			.filter((item) => (item as any)?.role === 'tool')
			.map((item) => String((item as any)?.text ?? '').trim())
			.filter(Boolean);
		nodes.push(...this.extractSubagentNodesFromToolLines({ toolLines, parentId: 'agent.root', sessionId, traceId }));

		if (state.kind === 'sidebar' && this.isChatHistoryEnabled()) {
			const sessions = await this.listStoredHistorySessions();
			const recent = sessions
				.filter((s) => String(s.sessionId ?? '').trim() && String(s.sessionId) !== String(sessionId ?? ''))
				.slice(0, 3);

			for (const sess of recent) {
				const sid = String(sess.sessionId ?? '').trim();
				if (!sid) continue;
				const rootId = `session.${sid}`;
				const title = String(sess.title ?? '').trim() || sid;
				nodes.push({
					id: rootId,
					parentId: null,
					label: `History · ${title}`,
					type: 'main',
					status: 'idle',
					sessionId: sid,
					traceId: `trc_${sid}`,
					eventId: `evt_session_${sid}`
				});
				const lines = await this.readSessionToolTraceLines(sid);
				nodes.push(
					...this.extractSubagentNodesFromToolLines({
						toolLines: lines,
						parentId: rootId,
						sessionId: sid,
						traceId: `trc_${sid}`
					})
				);
			}
		}

		this.postToHost(state, { type: 'subagentTree', nodes });
		this.postSceneState(state, nodes);
	}

	private postSceneState(
		state: ChatHostState,
		nodes: Array<{
			id: string;
			parentId: string | null;
			label: string;
			type: 'main' | 'subagent';
			status: 'idle' | 'working' | 'done' | 'error';
			sessionId?: string;
			traceId?: string;
			eventId?: string;
			eventSeq?: number;
		}>
	): void {
		const normalizeKeyPart = (value: string | undefined): string => {
			return String(value ?? '')
				.toLowerCase()
				.trim()
				.replace(/\s+/g, '-')
				.replace(/[^a-z0-9._-]/g, '_')
				.slice(0, 80);
		};

		const hasFailed = nodes.some((n) => n.type === 'subagent' && n.status === 'error');
		const hasWorking = nodes.some((n) => n.type === 'subagent' && n.status === 'working');
		const hasWaitingApproval =
			!!this.pendingEditApproval &&
			(this.pendingEditApproval.originHost === state.kind || this.pendingEditApproval.originHost === 'sidebar');
		const prevScene = state.sceneState;
		const prevStations = new Map((state.sceneState?.workstations ?? []).map((s) => [String(s.id), s]));

		let machineState: 'idle' | 'working' | 'waiting' | 'failed' = 'idle';
		let reason = 'no-active-signals';
		if (hasFailed) {
			machineState = 'failed';
			reason = 'subagent-error';
		} else if (hasWaitingApproval) {
			machineState = 'waiting';
			reason = 'approval-pending';
		} else if (state.isBusy || hasWorking) {
			machineState = 'working';
			reason = state.isBusy ? 'host-busy' : 'subagent-working';
		}

		const workstations: Array<{
			id: string;
			mappingKey: string;
			label: string;
			state: 'idle' | 'working' | 'waiting' | 'failed';
			recovered?: boolean;
			nodeId?: string;
			eventId?: string;
			eventSeq?: number;
			sessionId?: string;
			traceId?: string;
			kind: 'subagent' | 'approval';
		}> = [];
		let recoveredCount = 0;

		for (const n of nodes) {
			if (n.type !== 'subagent') continue;
			const mapped: 'idle' | 'working' | 'waiting' | 'failed' =
				n.status === 'error' ? 'failed' : n.status === 'working' ? 'working' : 'idle';
			const sid = String(n.sessionId ?? '').trim() || 'live';
			const tid = String(n.traceId ?? '').trim() || 'trace';
			const labelKey = normalizeKeyPart(String(n.label ?? n.id ?? 'station')) || normalizeKeyPart(String(n.id));
			const stationId = `ws.subagent.${sid}.${tid}.${labelKey}`;
			const prev = prevStations.get(stationId);
			const recovered = !!prev && prev.state === 'failed' && mapped !== 'failed';
			if (recovered) recoveredCount += 1;
			workstations.push({
				id: stationId,
				mappingKey: `${sid}|${tid}|${String(n.eventId ?? '')}|${String(n.eventSeq ?? '')}`,
				label: n.label,
				state: mapped,
				recovered,
				nodeId: n.id,
				eventId: n.eventId,
				eventSeq: n.eventSeq,
				sessionId: n.sessionId,
				traceId: n.traceId,
				kind: 'subagent'
			});
		}

		if (hasWaitingApproval && this.pendingEditApproval) {
			const approvalId = `approval.${this.pendingEditApproval.requestId}`;
			workstations.unshift({
				id: approvalId,
				mappingKey: approvalId,
				label: 'Approval Gate',
				state: 'waiting',
				eventId: this.pendingEditApproval.requestId,
				kind: 'approval'
			});
		}

		if (!hasFailed && recoveredCount > 0) {
			if (hasWaitingApproval) {
				reason = 'recovered-awaiting-approval';
			} else if (state.isBusy || hasWorking) {
				machineState = 'working';
				reason = 'recovered-and-running';
			} else {
				machineState = 'idle';
				reason = 'recovered-to-idle';
			}
		}

		const stateRank: Record<'failed' | 'waiting' | 'working' | 'idle', number> = {
			failed: 0,
			waiting: 1,
			working: 2,
			idle: 3
		};
		workstations.sort((a, b) => stateRank[a.state] - stateRank[b.state] || a.label.localeCompare(b.label));
		const latestEventSeq = (() => {
			let maxSeq: number | undefined;
			for (const ws of workstations) {
				const seq = ws.eventSeq;
				if (!Number.isFinite(Number(seq))) continue;
				const n = Math.max(0, Math.floor(Number(seq)));
				if (maxSeq == null || n > maxSeq) maxSeq = n;
			}
			return maxSeq;
		})();
		const transition = `${String(prevScene?.machineState ?? 'init')}->${machineState}`;
		const recoveryAt = recoveredCount > 0 ? Date.now() : prevScene?.recoveryAt;

		const next = {
			machineState,
			reason,
			transition,
			latestEventSeq,
			recoveryAt,
			updatedAt: Date.now(),
			workstations
		};
		state.sceneState = next;
		this.postToHost(state, { type: 'sceneState', ...next });
	}

	private postReplayState(state: ChatHostState): void {
		const rs = state.replayState ?? {
			active: false,
			playing: false,
			cursor: 0,
			locked: false,
			sessionId: undefined,
			traceId: undefined,
			totalRecords: 0,
			cadenceMs: 850
		};
		this.postToHost(state, {
			type: 'replayState',
			active: Boolean(rs.active),
			playing: Boolean(rs.playing),
			cursor: Number(rs.cursor ?? 0),
			sessionId: rs.sessionId,
			traceId: rs.traceId,
			locked: Boolean(rs.locked),
			totalRecords: Number.isFinite(Number(rs.totalRecords)) ? Math.max(0, Math.floor(Number(rs.totalRecords))) : 0,
			cadenceMs: Number.isFinite(Number(rs.cadenceMs)) ? Math.max(250, Math.floor(Number(rs.cadenceMs))) : 850
		});
	}

	private stopReplayCadence(state: ChatHostState): void {
		if (state.replayCadenceTimer) {
			clearInterval(state.replayCadenceTimer);
			state.replayCadenceTimer = undefined;
		}
	}

	private startReplayCadence(state: ChatHostState): void {
		this.stopReplayCadence(state);
		const rs = state.replayState;
		if (!rs?.active || !rs.playing || !rs.locked) return;
		const cadenceMs = Number.isFinite(Number(rs.cadenceMs)) ? Math.max(250, Math.floor(Number(rs.cadenceMs))) : 850;
		state.replayCadenceTimer = setInterval(() => {
			const cur = state.replayState;
			if (!cur?.active || !cur.playing || !cur.locked) {
				this.stopReplayCadence(state);
				return;
			}
			const total = Number.isFinite(Number(cur.totalRecords)) ? Math.max(0, Math.floor(Number(cur.totalRecords))) : 0;
			if (total <= 0) {
				cur.playing = false;
				this.stopReplayCadence(state);
				this.postReplayState(state);
				return;
			}
			const cursor = Number.isFinite(Number(cur.cursor)) ? Math.max(0, Math.floor(Number(cur.cursor))) : 0;
			if (cursor >= total - 1) {
				cur.cursor = total - 1;
				cur.playing = false;
				this.stopReplayCadence(state);
				this.postReplayState(state);
				return;
			}
			cur.cursor = cursor + 1;
			this.postReplayState(state);
		}, cadenceMs);
	}

	private async handleUiAction(state: ChatHostState, action: string, payload: any) {
		switch (action) {
			case 'addContext': {
				await this.addContextInteractive(state);
				return;
			}
			case 'attachFileRef': {
				const ref = String(payload?.ref ?? '').trim();
				if (!ref) return;
				await this.attachFilesFromPromptRefs(state, [ref]);
				return;
			}
			case 'addToolRef': {
				const name = String(payload?.name ?? '').trim();
				if (!name) return;
				const next = new Set((state.lastToolReferences ?? []).map((s) => String(s).trim()).filter(Boolean));
				next.add(name);
				state.lastToolReferences = Array.from(next).sort();
				this.postToolChips(state);
				return;
			}
			case 'removeToolRef': {
				const name = String(payload?.name ?? '').trim();
				if (!name) return;
				state.lastToolReferences = (state.lastToolReferences ?? []).map(String).map((s) => s.trim()).filter((s) => s && s !== name).sort();
				this.postToolChips(state);
				return;
			}
			case 'removeContext': {
				const id = String(payload?.id ?? '').trim();
				if (!id) return;
				this.removeContextAttachment(state, id);
				return;
			}
			case 'hashSuggest': {
				const rawPrefix = String(payload?.prefix ?? '').trim();
				let mode: 'any' | 'file' | 'toolCompat' = 'any';
				let prefix = rawPrefix;
				if (/^file:/i.test(rawPrefix)) {
					mode = 'file';
					prefix = rawPrefix.slice('file:'.length).trim();
				} else if (/^tool:/i.test(rawPrefix)) {
					mode = 'toolCompat';
					prefix = rawPrefix.slice('tool:'.length).trim();
				}
				const items: Array<{ kind: 'file' | 'tool'; label: string; detail?: string; insertText: string }> = [];

				const pushFile = (uri: vscode.Uri, labelSuffix?: string) => {
					const rel = safeWorkspaceRelativePath(uri) || uri.fsPath;
					if (!rel) return;
					const base = path.basename(uri.fsPath || uri.path || rel);
					const label = labelSuffix ? `${base}${labelSuffix}` : base;
					items.push({ kind: 'file', label, detail: rel, insertText: `#file:${rel}` });
				};

				if (mode !== 'toolCompat') {
					// Active file first.
					const active = vscode.window.activeTextEditor?.document?.uri;
					if (active && (active.scheme === 'file' || active.scheme === 'vscode-remote')) {
						pushFile(active, ' (Active file)');
					}

					// Then visible editors.
					for (const ed of vscode.window.visibleTextEditors ?? []) {
						const u = ed.document?.uri;
						if (!u || u.toString() === active?.toString()) continue;
						if (u.scheme !== 'file' && u.scheme !== 'vscode-remote') continue;
						pushFile(u);
						if (items.length >= 12) break;
					}
				}

				// If prefix is non-empty, do a lightweight workspace search.
				const folder = vscode.workspace.workspaceFolders?.[0];
				const shouldSearchWorkspace = mode === 'file' ? prefix.length >= 0 : prefix.length >= 2;
				if (mode !== 'toolCompat' && folder && prefix && shouldSearchWorkspace) {
					const safe = prefix.replace(/[^A-Za-z0-9_.\-\/]/g, '');
					const pat = safe.includes('/') ? `**/${safe}*` : `**/*${safe}*`;
					const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.turbo/**}';
					try {
						const uris = await vscode.workspace.findFiles(pat, exclude, 20);
						for (const uri of uris) {
							const rel = safeWorkspaceRelativePath(uri) || uri.fsPath;
							if (!rel) continue;
							if (items.some((it) => it.kind === 'file' && it.insertText === `#file:${rel}`)) continue;
							pushFile(uri);
							if (items.length >= 20) break;
						}
					} catch {
						// ignore
					}
				}

				if (mode !== 'file') {
					// Tool suggestions from built-in tool definitions.
					const toolPrefix = prefix.toLowerCase();
					// Tool set suggestions (Copilot-like).
					for (const setName of Object.keys(TOOL_SETS)) {
						if (!toolPrefix || setName.toLowerCase().startsWith(toolPrefix)) {
							items.push({
								kind: 'tool',
								label: setName,
								detail: `Tool set · ${TOOL_SETS[setName]?.description ?? ''}`.trim(),
								insertText: `#${setName}`
							});
						}
						if (items.length >= 40) break;
					}
					const toolNames = getToolDefinitions()
						.map((t) => String(t?.function?.name ?? '').trim())
						.filter(Boolean);
					for (const name of toolNames) {
						if (!toolPrefix || name.toLowerCase().startsWith(toolPrefix)) {
							items.push({
								kind: 'tool',
								label: name,
								insertText: mode === 'toolCompat' ? `#tool:${name}` : `#${name}`
							});
						}
						if (items.length >= 40) break;
					}
				}

				this.postToHost(state, { type: 'hashSuggestions', items });
				return;
			}
			case 'continueChat': {
				// Copilot-like: ask the model to continue the last assistant output.
				// We reuse the normal message pipeline so tools/streaming/history all stay consistent.
				await this.handleUserMessage('继续', state);
				return;
			}
			case 'newChatEditor':
			case 'moveToEditor': {
				await this.openChatInEditorArea(state.kind);
				return;
			}
			case 'newChatWindow':
			case 'moveToNewWindow': {
				await this.openChatInNewWindow();
				return;
			}
			case 'showChat': {
				await this.openChatView();
				return;
			}
			case 'showChatDebug': {
				await this.showChatLogView(state.kind);
				return;
			}
			case 'defaultView': {
				await this.resetViewDefaults();
				return;
			}
			case 'sessionsSearch':
			case 'sessionsFilter':
			case 'sessionsView':
				return;

			case 'requestSubagentTree': {
				await this.postSubagentTree(state);
				return;
			}

			case 'requestReplayState': {
				this.postReplayState(state);
				if (state.sceneState) {
					this.postToHost(state, { type: 'sceneState', ...state.sceneState });
				}
				return;
			}

			case 'replayControl': {
				const cmd = String(payload?.action ?? '').trim().toLowerCase();
				const sid = String(payload?.sessionId ?? '').trim() || undefined;
				const tid = String(payload?.traceId ?? '').trim() || undefined;
				const cur = Number.isFinite(Number(payload?.cursor)) ? Math.max(0, Math.floor(Number(payload?.cursor))) : 0;
				const total = Number.isFinite(Number(payload?.totalRecords)) ? Math.max(0, Math.floor(Number(payload?.totalRecords))) : undefined;
				const cadenceMs = Number.isFinite(Number(payload?.cadenceMs))
					? Math.max(250, Math.floor(Number(payload?.cadenceMs)))
					: undefined;
				const next = state.replayState ?? {
					active: false,
					playing: false,
					cursor: 0,
					locked: false,
					sessionId: undefined,
					traceId: undefined,
					totalRecords: 0,
					cadenceMs: 850
				};

				if (cmd === 'load') {
					next.active = true;
					next.playing = false;
					next.cursor = cur;
					next.locked = true;
					next.sessionId = sid;
					next.traceId = tid;
					next.totalRecords = total ?? 0;
					next.cadenceMs = cadenceMs ?? next.cadenceMs ?? 850;
					this.stopReplayCadence(state);
				} else if (cmd === 'play' || cmd === 'resume') {
					next.active = true;
					next.playing = true;
					next.locked = true;
					next.cursor = cur;
					next.sessionId = sid ?? next.sessionId;
					next.traceId = tid ?? next.traceId;
					next.totalRecords = total ?? next.totalRecords ?? 0;
					next.cadenceMs = cadenceMs ?? next.cadenceMs ?? 850;
					this.startReplayCadence(state);
				} else if (cmd === 'pause' || cmd === 'scrub') {
					next.active = true;
					next.playing = false;
					next.locked = true;
					next.cursor = cur;
					next.sessionId = sid ?? next.sessionId;
					next.traceId = tid ?? next.traceId;
					next.totalRecords = total ?? next.totalRecords ?? 0;
					next.cadenceMs = cadenceMs ?? next.cadenceMs ?? 850;
					this.stopReplayCadence(state);
				} else if (cmd === 'stop') {
					next.active = false;
					next.playing = false;
					next.cursor = 0;
					next.locked = false;
					next.sessionId = undefined;
					next.traceId = undefined;
					next.totalRecords = 0;
					this.stopReplayCadence(state);
				} else if (cmd === 'config') {
					next.cadenceMs = cadenceMs ?? next.cadenceMs ?? 850;
					next.totalRecords = total ?? next.totalRecords ?? 0;
					next.sessionId = sid ?? next.sessionId;
					next.traceId = tid ?? next.traceId;
					next.cursor = cur;
					if (next.active && next.playing) this.startReplayCadence(state);
				}

				state.replayState = next;
				this.postReplayState(state);
				if (!next.active) {
					await this.postSubagentTree(state);
				}
				return;
			}

			case 'jumpToSubagentEvent': {
				const nodeId = String(payload?.nodeId ?? '').trim() || '(unknown-node)';
				const eventId = String(payload?.eventId ?? '').trim() || '(unknown-event)';
				const traceId = String(payload?.traceId ?? '').trim() || '(unknown-trace)';
				const sessionId = String(payload?.sessionId ?? '').trim() || '(unknown-session)';
				const status = String(payload?.status ?? '').trim() || 'unknown';
				const source = String(payload?.source ?? '').trim() || 'subagent-tree-live';
				const silent = Boolean(payload?.silent);
				if (silent) return;
				this.postToHost(state, {
					type: 'chatAppend',
					role: 'tool',
					text: [
						'[Subagent Event Jump]',
						`nodeId: ${nodeId}`,
						`eventId: ${eventId}`,
						`traceId: ${traceId}`,
						`sessionId: ${sessionId}`,
						`status: ${status}`,
						`source: ${source}`
					].join('\n')
				});
				return;
			}

			case 'setTempSession': {
				const tempEnabled = Boolean(payload?.enabled);
				// temp session ON => do not record history.
				await vscode.workspace
					.getConfiguration('tripilot')
					.update('chatHistory.enabled', !tempEnabled, vscode.ConfigurationTarget.Global);
				// Avoid appending into an old session id after toggling (applies to both hosts).
				for (const s of Object.values(this.hostStates)) {
					s.historySessionId = undefined;
					s.currentSessionTitle = undefined;
					s.historyStore = undefined;
				}
				await this.refreshSessionsAndPost();
				return;
			}

			case 'requestSessions': {
				await this.refreshSessionsAndPost();
				return;
			}
			case 'newSession': {
				await this.startNewChatSessionInteractive(state.kind);
				if (state.kind === 'sidebar') await this.refreshSessionsAndPost();
				return;
			}
			case 'loadSession': {
				const sid = String(payload?.sessionId ?? '').trim();
				if (!sid) return;
				try {
					await this.loadSessionIntoHost(sid, state);
				} catch (e: any) {
					vscode.window.showErrorMessage(`Tripilot: 加载会话失败：${String(e?.message ?? e)}`);
				}
				if (state.kind === 'sidebar') await this.refreshSessionsAndPost();
				return;
			}
			case 'archiveSession': {
				if (state.kind !== 'sidebar') return;
				const sid = String(payload?.sessionId ?? '').trim();
				if (!sid) return;
				const raw = this.context.globalState.get<string[]>('tripilot.archivedSessionIds') ?? [];
				const set = new Set(raw.map((s) => String(s).trim()).filter(Boolean));
				set.add(sid);
				await this.context.globalState.update('tripilot.archivedSessionIds', Array.from(set));
				await this.refreshSessionsAndPost();
				return;
			}
			case 'archiveOrExportSession': {
				if (state.kind !== 'sidebar') return;
				const sid = String(payload?.sessionId ?? '').trim();
				if (!sid) return;
				if (!this.isChatHistoryEnabled()) {
					vscode.window.showWarningMessage('Tripilot: Chat History 未启用（tripilot.chatHistory.enabled=false）。');
					return;
				}

				const hasGranular = this.isGranularExportEnabled();
				const picked = await vscode.window.showQuickPick(
					[
						{ label: '归档此会话', detail: 'archive' },
						{ label: '导出此会话（全量）', detail: 'export_full' },
						...(hasGranular ? [{ label: '导出此会话（选择记录…）', detail: 'export_select' }] : [])
					],
					{ title: 'Tripilot: 会话操作' }
				);
				if (!picked?.detail) return;
				if (picked.detail === 'archive') {
					await this.handleUiAction(state, 'archiveSession', { sessionId: sid });
					return;
				}
				await this.exportSingleSessionInteractive(sid, picked.detail === 'export_select');
				return;
			}
			case 'deleteSession': {
				if (state.kind !== 'sidebar') return;
				const sid = String(payload?.sessionId ?? '').trim();
				if (!sid) return;
				if (!this.isChatHistoryEnabled()) return;

				const confirm = await vscode.window.showWarningMessage(
					`Tripilot: 确认删除会话 ${sid}？`,
					{ modal: true },
					'删除'
				);
				if (confirm !== '删除') return;

				try {
					const uri = vscode.Uri.joinPath(this.getHistoryDirUri(), `${sid}.jsonl`);
					await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
				} catch (e: any) {
					vscode.window.showErrorMessage(`Tripilot: 删除会话失败：${String(e?.message ?? e)}`);
					return;
				}

				// Also remove from archived set if present.
				const raw = this.context.globalState.get<string[]>('tripilot.archivedSessionIds') ?? [];
				const filtered = raw.map(String).map((s) => s.trim()).filter((s) => s && s !== sid);
				if (filtered.length !== raw.length) {
					await this.context.globalState.update('tripilot.archivedSessionIds', filtered);
				}

				// If deleting current session, reset UI for any host that was using it.
				for (const s of Object.values(this.hostStates)) {
					if (sid === s.historySessionId) {
						s.historySessionId = undefined;
						s.currentSessionTitle = undefined;
						s.historyStore = undefined;
						s.transcript = [];
						await this.context.globalState.update('tripilot.activeChatSessionId', undefined);
						this.resetConversationForLoadedSession(s);
						this.postToHost(s, { type: 'chatReset' });
					}
				}

				await this.refreshSessionsAndPost();
				return;
			}
			case 'openSettings': {
				TripilotSettingsPanel.show(this.context, this.mcpManager, 'models');
				return;
			}
			case 'openToolsSettings': {
				TripilotSettingsPanel.show(this.context, this.mcpManager, 'tools', {
					fromChat: true,
					agentProfileId: this.selectedAgentProfileId
				});
				return;
			}
			case 'setAgentProfile': {
				const id = String(payload?.id ?? payload?.value ?? '').trim();
				if (!id) return;
				this.selectedAgentProfileId = id;
				this.ensureSystemInstructionUpToDate(this.hostStates.sidebar);
				this.ensureSystemInstructionUpToDate(this.hostStates.editor);
				this.ensureCopilotSystemInstructionUpToDate(this.hostStates.sidebar);
				this.ensureCopilotSystemInstructionUpToDate(this.hostStates.editor);
				await this.context.globalState.update('tripilot.selectedAgentProfileId', id);
				this.postAgentProfileAndLabel();
				TripilotSettingsPanel.syncActiveAgentProfileFromChat(id);
				if (id === 'ask-study') {
					if (!this.lastModels.length) {
						await this.refreshModelsAndPost(state);
					}
					await this.ensureAskStudySandboxInitializedIfPossible();
				}
				return;
			}
			case 'configureCustomAgents': {
				TripilotSettingsPanel.show(this.context, this.mcpManager, 'customAgents');
				return;
			}
			case 'requestModels': {
				await this.refreshModelsAndPost(state);
				return;
			}
			case 'clearModelWhitelist': {
				await vscode.workspace
					.getConfiguration('tripilot')
					.update('visibleModelIds', [], vscode.ConfigurationTarget.Global);
				await this.refreshModelsAndPost(state);
				this.postToHost(state, { type: 'chatAppend', role: 'tool', text: '已清空模型白名单：现在显示全部可用模型。' });
				return;
			}
			case 'setModel': {
				const modelId = String(payload?.id ?? payload?.value ?? '');
				if (!modelId) return;
				this.selectedModelId = modelId;
				await this.context.globalState.update('tripilot.selectedModelId', modelId);
				await this.refreshModelsAndPost(state);
				this.postToHost(state, { type: 'chatAppend', role: 'tool', text: `已选择模型：${modelId}` });
				return;
			}
			case 'setEnabledTools': {
				const toolsRaw: string[] = Array.isArray(payload?.tools)
					? (payload.tools as unknown[])
							.map((value: unknown) => String(value ?? '').trim())
							.filter(Boolean)
					: [];
				const tools = toolsRaw.filter((s) => OPTIONAL_TOOL_NAMES.has(s));
				const unknown = toolsRaw.filter((s) => !OPTIONAL_TOOL_NAMES.has(s));
				// If the UI is outdated and sends unknown tool ids, don't wipe the profile's tool list.
				if (unknown.length && toolsRaw.length && tools.length === 0) {
					this.postToHost(state, {
						type: 'chatAppend',
						role: 'tool',
						text: `Tools 菜单发送了未知工具名（可能是旧版 UI）：${unknown.join(', ')}。已忽略本次更新，请更新/重载 Tripilot 后再试。`
					});
					return;
				}
				this.enabledTools = new Set(tools);
				if (this.getWorkspaceCustomAgent(this.selectedAgentProfileId)) {
					this.postToHost(state, {
						type: 'chatAppend',
						role: 'tool',
						text: 'Custom Agent 的 tools 由 .agent.md 文件控制；请在 Settings → Custom Agents 打开文件后编辑 frontmatter.tools。'
					});
					return;
				}
				await setAgentProfileOptionalTools(this.selectedAgentProfileId, this.enabledTools);
				this.postToHost(state, { type: 'chatAppend', role: 'tool', text: `已更新 Tools：${tools.join(', ') || '(none)'}` });
				return;
			}
			case 'manageModels': {
				try {
					// copilot-direct uses Copilot's /models and does not rely on VS Code's LM registry UI.
					if (this.getChatProvider() === 'copilot-direct') {
						this.postToHost(state, { type: 'chatAppend', role: 'tool', text: '打开 Tripilot Settings → Models…' });
						// Open Settings immediately; do any network checks in the background.
						TripilotSettingsPanel.show(this.context, this.mcpManager, 'models');
						void (async () => {
							try {
								const token = await this.copilotTokenManager.getCopilotToken();
								this.lastCopilotModels = await this.copilotClient.listModels(token);
								await this.refreshModelsAndPost(state);
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								this.postToHost(state, { type: 'chatAppend', role: 'tool', text: `加载 Copilot 模型失败：${message}` });
							}
						})();
						return;
					}

					// models-direct also relies on a remote /v1/models catalog.
					if (this.getChatProvider() === 'models-direct') {
						this.postToHost(state, { type: 'chatAppend', role: 'tool', text: '打开 Tripilot Settings → Models…（models-direct）' });
						TripilotSettingsPanel.show(this.context, this.mcpManager, 'models');
						void (async () => {
							try {
								const cfg = this.getModelsDirectConfig();
								if (!cfg.baseUrl) throw new Error('未配置 tripilot.modelsDirect.baseUrl');
								this.lastModelsDirectModels = await this.modelsDirectClient.listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
								await this.refreshModelsAndPost(state);
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								this.postToHost(state, { type: 'chatAppend', role: 'tool', text: `加载 Models Direct 模型失败：${message}` });
							}
						})();
						return;
					}

					// vscode-lm: Tripilot 自己的 Models 配置页就是“模型管理”。
					this.postToHost(state, { type: 'chatAppend', role: 'tool', text: '打开 Tripilot Settings → Models…' });
					TripilotSettingsPanel.show(this.context, this.mcpManager, 'models');
					return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					try {
						this.postToHost(state, { type: 'chatAppend', role: 'tool', text: `打开模型管理失败：${message}` });
					} catch {
						// ignore
					}
					// Always keep a safe UI fallback to avoid host restarts.
					TripilotSettingsPanel.show(this.context, this.mcpManager, 'models');
					return;
				}
			}
			default:
				this.postToHost(state, { type: 'chatAppend', role: 'tool', text: `UI action (stub): ${action}` });
				return;
		}

	}

	private postAny(message: WebviewOutboundMessageExtended) {
		for (const w of Array.from(this.webviews)) {
			try {
				void w.postMessage(message as any);
			} catch {
				this.webviews.delete(w);
			}
		}
	}

	public async syncAgentProfileFromSettings(agentProfileId: string): Promise<void> {
		const id = String(agentProfileId ?? '').trim();
		if (!id) return;
		if (this.selectedAgentProfileId === id) return;
		// Reuse the canonical path (updates prompts, persists globalState, triggers ask&study sandbox init, etc.).
		await this.handleUiAction(this.hostStates.sidebar, 'setAgentProfile', { id });
	}

	private setAndPostStatus(state: ChatHostState, status: 'idle' | 'thinking' | 'running-tools' | 'error', detail?: string) {
		state.status = status;
		state.statusDetail = detail;
		this.postToHost(state, { type: 'chatSetStatus', status, detail } satisfies WebviewOutboundMessage);
	}

	private postToHost(state: ChatHostState, message: WebviewOutboundMessageExtended): void {
		const w = state.webview;
		if (!w) return;
		try {
			void w.postMessage(message as any);
		} catch {
			// Drop broken webview reference.
			if (state.webview === w) state.webview = undefined;
			this.webviews.delete(w);
		}
	}

	public async refreshModelsAndPost(state?: ChatHostState) {
		try {
			if (this.getChatProvider() === 'copilot-direct') {
				const copilotToken = await this.copilotTokenManager.getCopilotToken();
				this.lastCopilotModels = await this.copilotClient.listModels(copilotToken);
				if (!this.lastCopilotModels.length) {
					const text =
						'Copilot /models 返回空列表，因此模型菜单只会显示 Auto。' +
						'\n如果你在调试“隔离 profile”窗口，请确认已在该窗口完成 GitHub 登录，并且账号具备 Copilot 权限。';
					if (state) {
						this.postToHost(state, { type: 'chatAppend', role: 'tool', text });
					} else {
						void vscode.window.showWarningMessage(text);
					}
				}

				// If Auto is visible and we don't yet have a discount label, prefetch /models/session in background.
				this.prefetchCopilotAutoDiscount(state);

				const built = this.buildCopilotDirectLmModels();
				const models = built.models;

				if (!this.selectedModelId) {
					this.selectedModelId = models[0]?.id;
					if (this.selectedModelId) {
						await this.context.globalState.update('tripilot.selectedModelId', this.selectedModelId);
					}
				}

				if (this.selectedModelId) {
					const visibleIdsNow = new Set(models.map((m) => m.id));
					if (!visibleIdsNow.has(this.selectedModelId)) {
						this.selectedModelId = models[0]?.id;
						if (this.selectedModelId) {
							await this.context.globalState.update('tripilot.selectedModelId', this.selectedModelId);
						}
					}
				}

				this.postAny({
					type: 'lmModels',
					models,
					selectedModelId: this.selectedModelId,
					provider: 'copilot-direct',
					runtimeCount: this.lastCopilotModels.length,
					filteredCount: models.length
				});
				return;
			}

			if (this.getChatProvider() === 'models-direct') {
				const cfg = this.getModelsDirectConfig();
				if (!cfg.baseUrl) {
					const models: LmModelInfo[] = [
						{ id: 'auto', name: 'Auto', vendor: 'tripilot', family: 'auto', version: 'auto', maxInputTokens: 0, rightText: '1x' }
					];
					this.postAny({
						type: 'lmModels',
						models,
						selectedModelId: this.selectedModelId,
						provider: 'models-direct',
						runtimeCount: 0,
						filteredCount: models.length
					});
					return;
				}

				try {
					this.lastModelsDirectModels = await this.modelsDirectClient.listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
				} catch (err) {
					this.lastModelsDirectModels = [];
					const message = err instanceof Error ? err.message : String(err);
					const text = `加载 Models Direct 模型失败：${message}`;
					if (state) this.postToHost(state, { type: 'chatAppend', role: 'tool', text });
					else void vscode.window.showWarningMessage(text);
				}

				const visibleModelIds = new Set(
					(vscode.workspace.getConfiguration('tripilot').get<string[]>('visibleModelIds', []) ?? [])
						.map((s) => String(s).trim())
						.filter(Boolean)
				);

				const autoModel: LmModelInfo = {
					id: 'auto',
					name: 'Auto',
					vendor: 'tripilot',
					family: 'auto',
					version: 'auto',
					maxInputTokens: 0
				};

				const allRealModels: LmModelInfo[] = this.lastModelsDirectModels
					.map((m) => {
						const providerLabel = inferModelsDirectProviderLabel({
							provider: m.provider,
							modelTag: m.modelTag,
							modelExtra: m.modelExtra
						});
						return {
							id: m.id,
							name: m.displayName ?? m.id,
							vendor: 'models-direct',
							family: String(m.modelTag || 'models-direct'),
							version: 'n/a',
							maxInputTokens: m.maxInputTokens ?? 0,
							rightText: providerLabel
						} satisfies LmModelInfo;
					})
					.filter((m) => m.id !== 'auto');

				const filteredRealModels = visibleModelIds.size
					? allRealModels.filter((m) => visibleModelIds.has(m.id))
					: allRealModels;

				const models: LmModelInfo[] = [];
				// Default behavior (no whitelist): always include Auto at the top.
				// If a whitelist is configured, include Auto only when it is explicitly listed.
				if (!visibleModelIds.size || visibleModelIds.has('auto')) {
					// models-direct: Auto is request-based billing (1x), server auto-selects.
					models.push({ ...autoModel, rightText: '1x' });
				}
				models.push(...filteredRealModels);

				const defaultModelId = cfg.defaultModel || this.lastModelsDirectModels[0]?.id;
				if (!this.selectedModelId) {
					this.selectedModelId = (!visibleModelIds.size || visibleModelIds.has('auto')) ? 'auto' : defaultModelId;
					if (this.selectedModelId) await this.context.globalState.update('tripilot.selectedModelId', this.selectedModelId);
				}
				if (this.selectedModelId) {
					const visibleIdsNow = new Set(models.map((m) => m.id));
					if (!visibleIdsNow.has(this.selectedModelId)) {
						this.selectedModelId = (!visibleModelIds.size || visibleModelIds.has('auto')) ? 'auto' : defaultModelId;
						if (this.selectedModelId) await this.context.globalState.update('tripilot.selectedModelId', this.selectedModelId);
					}
				}

				this.postAny({
					type: 'lmModels',
					models,
					selectedModelId: this.selectedModelId,
					provider: 'models-direct',
					runtimeCount: this.lastModelsDirectModels.length,
					whitelistSize: visibleModelIds.size,
					filteredCount: models.length
				});
				return;
			}

			const lmAny = (vscode as any).lm;
			if (!lmAny || typeof lmAny.selectChatModels !== 'function') {
				const text =
					'当前 VS Code 环境不支持 Language Model API（vscode.lm）。请使用支持该 API 的 VS Code 版本，或在对应发行版中启用/安装语言模型提供方。';
				if (state) {
					this.postToHost(state, { type: 'chatAppend', role: 'tool', text });
				} else {
					void vscode.window.showWarningMessage(text);
				}
				return;
			}

			this.lastModels = await vscode.lm.selectChatModels();
			const vscdbVisible = await tryReadVscodeChatVisibleModelIdsFromStateDb({ context: this.context });
			const hostVisibleSource: 'vscdb.cachedLanguageModels' | 'heuristic' | 'none' = vscdbVisible?.ids?.size
				? 'vscdb.cachedLanguageModels'
				: 'heuristic';
			const hostVisibleModels = vscdbVisible?.ids?.size
				? this.lastModels.filter((m) => vscdbVisible.ids.has(m.id))
				: this.lastModels.filter(isHostVisibleVscodeLmModel);

			const visibleModelIds = new Set(
				(vscode.workspace.getConfiguration('tripilot').get<string[]>('visibleModelIds', []) ?? [])
					.map((s) => String(s).trim())
					.filter(Boolean)
			);

			const runtimeAuto = hostVisibleModels.find((m) => m.id === 'auto') ?? this.lastModels.find((m) => m.id === 'auto');
			const autoModel: LmModelInfo = runtimeAuto
				?
					{
						id: 'auto',
						name: runtimeAuto.name || 'Auto',
						vendor: runtimeAuto.vendor || 'tripilot',
						family: runtimeAuto.family || 'auto',
						version: runtimeAuto.version || 'auto',
						maxInputTokens: runtimeAuto.maxInputTokens || 0,
						rightText: inferVscodeLmAutoRightText(runtimeAuto)
					}
				:
				{
					id: 'auto',
					name: 'Auto',
					vendor: 'tripilot',
					family: 'auto',
					version: 'auto',
					maxInputTokens: 0
				};

			const allRealModels: LmModelInfo[] = hostVisibleModels
				.map((m) => ({
				id: m.id,
				name: m.name,
				vendor: m.vendor,
				family: m.family,
				version: m.version,
				maxInputTokens: m.maxInputTokens,
				rightText:
					inferVscodeLmRightText(m) ??
					(!/copilot/i.test(String(m.vendor || '')) ? normalizeVendorLabel(m.vendor) : undefined)
			}))
				// Avoid duplicate Auto if the runtime also returns an `id === 'auto'` model.
				.filter((m) => m.id !== 'auto');

			const filteredRealModels = allRealModels;
			const openrouterCount = allRealModels.filter((m) => /openrouter/i.test(String(m.vendor || ''))).length;
			const hostVisibleCount = hostVisibleModels.length;

			const models: LmModelInfo[] = [];
			// In vscode-lm mode, we match VS Code's host-visible ("eye") models.
			// Tripilot's own whitelist is ignored for this provider.
			models.push(autoModel);
			models.push(...filteredRealModels);

			if (!this.selectedModelId) {
				this.selectedModelId = 'auto';
				if (this.selectedModelId) {
					await this.context.globalState.update('tripilot.selectedModelId', this.selectedModelId);
				}
			}

			// If the selected model is no longer visible, fall back to Auto (if available) or the first visible model.
			if (this.selectedModelId) {
				const visibleIdsNow = new Set(models.map((m) => m.id));
				if (!visibleIdsNow.has(this.selectedModelId)) {
					this.selectedModelId = 'auto';
					if (this.selectedModelId) {
						await this.context.globalState.update('tripilot.selectedModelId', this.selectedModelId);
					}
				}
			}

			this.postAny({
				type: 'lmModels',
				models,
				selectedModelId: this.selectedModelId,
				provider: 'vscode-lm',
				runtimeCount: this.lastModels.length,
				hostVisibleCount,
				hostVisibleSource,
				whitelistSize: 0,
				openrouterCount,
				filteredCount: models.length
			});
			await this.ensureAskStudySandboxInitializedIfPossible();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const text = `无法读取可用语言模型：${message}`;
			if (state) {
				this.postToHost(state, { type: 'chatAppend', role: 'tool', text });
			} else {
				void vscode.window.showWarningMessage(text);
			}
		}
	}

	private getSelectedModel(): vscode.LanguageModelChat | undefined {
		if (!this.lastModels.length) return undefined;
		if (this.selectedModelId && this.selectedModelId !== 'auto') {
			const exact = this.lastModels.find((m) => m.id === this.selectedModelId);
			if (exact && isHostVisibleVscodeLmModel(exact)) return exact;
		}
		return this.lastModels.find(isHostVisibleVscodeLmModel) ?? this.lastModels[0];
	}

	private getEnabledToolNames(): Set<string> {
		const out = new Set<string>();
		for (const t of getToolDefinitions()) {
			const name = t.function.name;
			if (!OPTIONAL_TOOL_NAMES.has(name) || this.enabledTools.has(name)) {
				out.add(name);
			}
		}
		return out;
	}

	private getSelectedCopilotModelId(): string | undefined {
		// In copilot-direct we allow selecting 'auto' and resolve it via /models/session at request time.
		if (this.selectedModelId) return this.selectedModelId;
		// Best-effort fallback if selection wasn't initialized.
		return this.lastCopilotModels[0]?.id ?? 'auto';
	}

	private getFallbackNonAutoCopilotModelId(): string | undefined {
		const prefer = ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-4o', 'gpt-4.1', 'gpt-4'];
		for (const id of prefer) {
			if (this.lastCopilotModels.some((m) => m.id === id)) return id;
		}
		return this.lastCopilotModels.find((m) => m.id && m.id !== 'auto')?.id;
	}

	private getSelectedModelsDirectModelId(): string | undefined {
		if (this.selectedModelId && this.selectedModelId !== 'auto') {
			return this.selectedModelId;
		}
		const cfg = this.getModelsDirectConfig();
		if (cfg.defaultModel && this.lastModelsDirectModels.some((m) => m.id === cfg.defaultModel)) {
			return cfg.defaultModel;
		}
		return this.lastModelsDirectModels[0]?.id;
	}

	private async runCopilotDirectRequest(
		state: ChatHostState,
		args: {
			modelId: string;
			directives: ToolReferences;
			userText: string;
		}
	): Promise<void> {
		const built = await this.buildToolsForRequest(
			this.selectedAgentProfileId,
			args.directives.serverReferences,
			args.directives.toolReferences
		);

		state.copilotConversation ??= [];
		this.ensureCopilotSystemInstructionUpToDate(state);

		let didStreamAssistant = false;
		let effectiveModelId = args.modelId;
		const additionalHeaders: Record<string, string> = {
			'X-Interaction-Id': state.copilotInteractionId ?? createUuid(),
			'X-Initiator': 'user'
		};
		if (effectiveModelId === 'auto') {
			const auto = await this.ensureCopilotAutoSession(state);
			if (auto?.sessionToken) {
				additionalHeaders['Copilot-Session-Token'] = auto.sessionToken;
			}
			effectiveModelId = auto?.selectedModel || this.getFallbackNonAutoCopilotModelId() || effectiveModelId;
		}

		const finalText = await runCopilotDirectToolCallingLoop({
			client: this.copilotClient,
			tokenManager: this.copilotTokenManager,
			modelId: effectiveModelId,
			conversation: state.copilotConversation,
			enabledTools: built.enabledTools,
			toolDefinitions: built.toolDefinitions as unknown as OpenAITool[],
			commandTools: built.commandTools,
			mcpManager: this.mcpManager,
			policy: {
				agentProfileId: this.selectedAgentProfileId,
				askStudySandboxDir: String(
					vscode.workspace.getConfiguration('tripilot').get<string>('askStudySandboxDir', '.tripilot/ask-study') ??
						'.tripilot/ask-study'
				)
			},
			maxIterations: vscode.workspace.getConfiguration('tripilot').get<number>('maxToolIterations', 6),
			intent: 'conversation-panel',
			additionalHeaders,
			postStatus: (s) => this.setAndPostStatus(state, s.status, s.detail),
			postAssistantStart: (initialText) => {
				didStreamAssistant = true;
				state.inProgressAssistantText = initialText ?? '';
				this.postToHost(state, { type: 'chatAssistantStart', initialText });
			},
			postAssistantDelta: (delta) => {
				didStreamAssistant = true;
				state.inProgressAssistantText = (state.inProgressAssistantText ?? '') + delta;
				this.postToHost(state, { type: 'chatAssistantDelta', delta });
			},
			postAssistantEnd: () => {
				this.postToHost(state, { type: 'chatAssistantEnd' });
				state.inProgressAssistantText = undefined;
			},
			postToolInvocationBegin: (m) => {
				this.postToHost(state, m);
			},
			postToolInvocationEnd: (m) => {
				this.postToHost(state, m);
			},
			postTodoList: (m) => {
				this.postToHost(state, m);
			},
			postToolTrace: (toolText) => {
				this.postToHost(state, { type: 'chatAppend', role: 'tool', text: toolText });
				state.transcript.push({ role: 'tool', text: toolText });
				if (!(state.replayState?.active && state.replayState?.locked)) {
					void this.postSubagentTree(state);
				}
				void this.appendHistory(state, {
					kind: 'tool_trace',
					text: toolText,
					profileId: this.selectedAgentProfileId,
					modelId: this.selectedModelId
				});
			},
			requestEditsApproval: (a) => this.requestEditsApproval(state, a),
			postEditsReview: (a) => this.postEditsReview(state, a),
			abortSignal: state.abortController!.signal,
			token: state.lmCancelSource!.token
		});

		if (!didStreamAssistant) {
			this.postToHost(state, { type: 'chatAppend', role: 'assistant', text: finalText });
		}
		state.transcript.push({ role: 'assistant', text: finalText });
		await this.appendHistory(state, {
			kind: 'assistant_message',
			text: finalText,
			profileId: this.selectedAgentProfileId,
			modelId: this.selectedModelId
		});
		this.appendCheckpoint(state);
	}

	private async runModelsDirectRequest(
		state: ChatHostState,
		args: {
			modelId: string;
			directives: ToolReferences;
			userText: string;
		}
	): Promise<void> {
		const cfg = this.getModelsDirectConfig();
		if (!cfg.baseUrl) {
			throw new Error('未配置 tripilot.modelsDirect.baseUrl');
		}

		const built = await this.buildToolsForRequest(
			this.selectedAgentProfileId,
			args.directives.serverReferences,
			args.directives.toolReferences
		);

		state.copilotConversation ??= [];
		this.ensureCopilotSystemInstructionUpToDate(state);

		const modelInfo = this.lastModelsDirectModels.find((m) => m.id === args.modelId);
		const modelTagFromConfig = cfg.modelTags?.[args.modelId];
		const modelExtraFromConfig = cfg.modelExtras?.[args.modelId];
		const effectiveModelTag = modelTagFromConfig || modelInfo?.modelTag || cfg.modelTagDefault;
		const effectiveModelExtra = modelExtraFromConfig ?? modelInfo?.modelExtra;

		let didStreamAssistant = false;
		const finalText = await runModelsDirectToolCallingLoop({
			client: this.modelsDirectClient,
			cfg: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
			modelId: args.modelId,
			conversation: state.copilotConversation,
			enabledTools: built.enabledTools,
			toolDefinitions: built.toolDefinitions as unknown as OpenAITool[],
			commandTools: built.commandTools,
			mcpManager: this.mcpManager,
			policy: {
				agentProfileId: this.selectedAgentProfileId,
				askStudySandboxDir: String(
					vscode.workspace.getConfiguration('tripilot').get<string>('askStudySandboxDir', '.tripilot/ask-study') ??
						'.tripilot/ask-study'
				)
			},
			maxIterations: vscode.workspace.getConfiguration('tripilot').get<number>('maxToolIterations', 6),
			intent: 'conversation-panel',
			additionalHeaders: {
				'X-Interaction-Id': state.copilotInteractionId ?? createUuid(),
				'X-Initiator': 'user'
			},
			requestMeta: {
				modelTag: effectiveModelTag,
				modelExtra: effectiveModelExtra,
				extraFieldName: cfg.extraFieldName
			},
			postStatus: (s) => this.setAndPostStatus(state, s.status, s.detail),
			postAssistantStart: (initialText) => {
				didStreamAssistant = true;
				state.inProgressAssistantText = initialText ?? '';
				this.postToHost(state, { type: 'chatAssistantStart', initialText });
			},
			postAssistantDelta: (delta) => {
				didStreamAssistant = true;
				state.inProgressAssistantText = (state.inProgressAssistantText ?? '') + delta;
				this.postToHost(state, { type: 'chatAssistantDelta', delta });
			},
			postAssistantEnd: () => {
				this.postToHost(state, { type: 'chatAssistantEnd' });
				state.inProgressAssistantText = undefined;
			},
			postToolInvocationBegin: (m) => {
				this.postToHost(state, m);
			},
			postToolInvocationEnd: (m) => {
				this.postToHost(state, m);
			},
			postTodoList: (m) => {
				this.postToHost(state, m);
			},
			postToolTrace: (toolText) => {
				this.postToHost(state, { type: 'chatAppend', role: 'tool', text: toolText });
				state.transcript.push({ role: 'tool', text: toolText });
				if (!(state.replayState?.active && state.replayState?.locked)) {
					void this.postSubagentTree(state);
				}
				void this.appendHistory(state, {
					kind: 'tool_trace',
					text: toolText,
					profileId: this.selectedAgentProfileId,
					modelId: this.selectedModelId
				});
			},
			requestEditsApproval: (a) => this.requestEditsApproval(state, a),
			postEditsReview: (a) => this.postEditsReview(state, a),
			abortSignal: state.abortController!.signal,
			token: state.lmCancelSource!.token
		});

		if (!didStreamAssistant) {
			this.postToHost(state, { type: 'chatAppend', role: 'assistant', text: finalText });
		}
		state.transcript.push({ role: 'assistant', text: finalText });
		await this.appendHistory(state, {
			kind: 'assistant_message',
			text: finalText,
			profileId: this.selectedAgentProfileId,
			modelId: this.selectedModelId
		});
		this.appendCheckpoint(state);
	}

	private async handleUserMessage(text: string, state: ChatHostState) {
		if (!text.trim()) return;
		// Copilot-like: any new user message invalidates the last restore/redo opportunity.
		if (this.lastCheckpointRestoreByHost[state.kind]) {
			this.lastCheckpointRestoreByHost[state.kind] = undefined;
			this.postToHost(state, { type: 'checkpointRedoClear' });
		}
		// Copilot-like: if there is a pending edit approval, treat short confirmations as UI actions.
		// This avoids awkward multi-turn "reply CONFIRM" workflows and keeps approvals in the review flow.
		try {
			const pending = this.pendingEditApproval;
			if (pending && pending.originHost === state.kind) {
				const t = String(text ?? '').trim();
				const low = t.toLowerCase();
				const isPreview = /^(preview|预览|查看|看一下)$/i.test(t);
				const isApply = /^(ok|okay|yes|y|apply|确认|同意|应用|执行|继续|好|可以|行)$/i.test(t);
				const isCancel = /^(no|n|cancel|取消|不要|不用|算了|停止)$/i.test(t);
				if (isPreview || isApply || isCancel) {
					await this.handleEditApprovalAction(state, {
						type: 'editApprovalAction',
						requestId: pending.requestId,
						action: isPreview ? 'preview' : isApply ? 'apply' : 'cancel'
					});
					return;
				}
			}
		} catch {
			// ignore
		}
		// Copilot-like: post-apply review flow also supports short inputs (Undo/Keep/Preview).
		try {
			const lastId = this.lastEditReviewRequestIdByHost[state.kind];
			if (lastId) {
				const pending = this.pendingEditReviews.get(lastId);
				if (pending && pending.originHost === state.kind) {
					const t = String(text ?? '').trim();
					const isPreview = /^(preview|预览|查看|看一下)$/i.test(t);
					const isUndo = /^(undo|撤销|回滚|还原|撤回)$/i.test(t);
					const isKeep = /^(keep|保留|保存|确认|好|可以|行|继续)$/i.test(t);
					if (isPreview || isUndo || isKeep) {
						await this.handleEditReviewAction(state, {
							type: 'editReviewAction',
							requestId: lastId,
							action: isPreview ? 'preview' : isUndo ? 'undo' : 'keep'
						});
						return;
					}
				}
			}
		} catch {
			// ignore
		}
		const chatProvider = this.getChatProvider();
		state.isBusy = true;
		state.inProgressAssistantText = undefined;
		// Treat current chips as draft tokens for this request (Copilot-like per-request scope).
		const draftToolRefs = Array.isArray(state.lastToolReferences) ? state.lastToolReferences.slice() : [];
		const draftHadAttachments = Array.isArray(state.contextAttachments) && state.contextAttachments.length > 0;
		await this.appendHistory(state, {
					kind: 'user_message',
					text,
					profileId: this.selectedAgentProfileId,
					modelId: this.selectedModelId
				});
		this.ensureSystemInstructionUpToDate(state);
		this.ensureCopilotSystemInstructionUpToDate(state);

		const promptSyntax = this.parsePromptSyntax(text);
		const directives = this.parseToolDirectives(text);
		// Compatibility: support #tool:<name> (reference repo supports it), but prefer Copilot-style #<toolName>.
		for (const t of promptSyntax.toolRefs) {
			const name = String(t).trim();
			if (!name) continue;
			directives.toolReferences.add(name);
			// Allow #tool:server.tool to imply enabling that MCP server.
			const dot = name.indexOf('.');
			if (dot > 0) {
				directives.serverReferences.add(name.slice(0, dot));
			}
		}
		for (const t of draftToolRefs) {
			const name = String(t).trim();
			if (!name) continue;
			directives.toolReferences.add(name);
			const dot = name.indexOf('.');
			if (dot > 0) {
				directives.serverReferences.add(name.slice(0, dot));
			}
		}
		state.lastToolReferences = Array.from(directives.toolReferences)
			.map((s) => String(s).trim())
			.filter(Boolean)
			.sort();
		this.postToolChips(state);
		await this.attachFilesFromPromptRefs(state, promptSyntax.fileRefs);
		const effectiveText = this.buildUserTextWithContext(state, promptSyntax.cleanText);

		this.postToHost(state, { type: 'chatAppend', role: 'user', text });
		state.transcript.push({ role: 'user', text });
		this.setAndPostStatus(state, 'thinking');

		// Clear draft chips after capturing them into this request.
		if (draftToolRefs.length) {
			state.lastToolReferences = [];
			this.postToolChips(state);
		}
		if (draftHadAttachments) {
			state.contextAttachments = [];
			this.postContextChips(state);
		}

		if (promptSyntax.toolRefs.length > 0) {
			const warn = '提示：检测到 #tool:<name> 兼容语法。建议使用 Copilot 风格的 #<toolName>（例如 #fetch https://...、#githubRepo owner/repo）。';
			this.postToHost(state, { type: 'chatAppend', role: 'tool', text: warn });
			state.transcript.push({ role: 'tool', text: warn });
		}
		if (chatProvider === 'copilot-direct' || chatProvider === 'models-direct') {
			state.copilotConversation ??= [];
			state.copilotConversation.push({ role: 'user', content: effectiveText });
		} else {
			state.conversation.push(vscode.LanguageModelChatMessage.User(effectiveText));
		}

		state.abortController?.abort();
		state.abortController = new AbortController();
		state.lmCancelSource?.cancel();
		state.lmCancelSource?.dispose();
		state.lmCancelSource = new vscode.CancellationTokenSource();

		try {
			if (chatProvider === 'copilot-direct') {
				if (!this.lastCopilotModels.length) {
					await this.refreshModelsAndPost(state);
				}
				const modelId = this.getSelectedCopilotModelId();
				if (!modelId) {
					throw new Error(
						'未检测到 Copilot 可用模型。\n' +
						'这通常不是“没登录”，而是：账号没有 Copilot 权限、选择了错误的 GitHub 会话（多账号）、或网络阻断 copilot-proxy。\n' +
						'可尝试：将 tripilot.copilotDirect.authMode 设为 permissive；然后在“管理 Copilot 模型…”里重试。'
					);
				}
				await this.runCopilotDirectRequest(state, {
					modelId,
					directives,
					userText: effectiveText
				});
				this.setAndPostStatus(state, 'idle');
				return;
			}

			if (chatProvider === 'models-direct') {
				const cfg = this.getModelsDirectConfig();
				if (!cfg.baseUrl) {
					throw new Error('未配置 tripilot.modelsDirect.baseUrl');
				}

				if (!this.lastModelsDirectModels.length) {
					await this.refreshModelsAndPost(state);
				}
				const modelId = this.getSelectedModelsDirectModelId();
				if (!modelId) {
					throw new Error('未检测到 Models Direct 可用模型。请先在 Settings → Models 里检查 /v1/models 是否可用。');
				}
				await this.runModelsDirectRequest(state, { modelId, directives, userText: effectiveText });
				this.setAndPostStatus(state, 'idle');
				return;
			}

			if (!this.lastModels.length) {
				await this.refreshModelsAndPost(state);
			}
			const model = this.getSelectedModel();
			if (!model) {
				throw new Error('未检测到可用的语言模型。请先在“管理模型…”中添加/启用模型提供方。');
			}

			// Copilot-like: generate a short AI title based on the prompt only (best-effort, non-blocking).
			void this.maybeGenerateAndStoreSessionTitle(state, text, model);

			const built = await this.buildToolsForRequest(
				this.selectedAgentProfileId,
				directives.serverReferences,
				directives.toolReferences
			);

			// Helpful hint: if user is asking to write/edit/save but write tools are disabled, tell them how to enable.
			let wantsWrite = false;
			let hasWriteTools = false;
			try {
				wantsWrite =
					/\b(save|write|edit|apply|append|prepend|update)\b|写入|保存|修改|编辑|创建.*文件|应用并保存|追加|添加|插入|写到|写进|写入到|保存到|加到文件|写进文件|落盘/i.test(
						String(text ?? '')
					);
				hasWriteTools =
					built.enabledTools.has('createFile') ||
					built.enabledTools.has('editFiles') ||
					built.enabledTools.has('createDirectory') ||
					built.enabledTools.has('editNotebook') ||
					built.enabledTools.has('newJupyterNotebook');
				if (wantsWrite && !hasWriteTools) {
					const enabledList = Array.from(built.enabledTools).map(String).filter(Boolean);
					enabledList.sort((a, b) => a.localeCompare(b));
					const previewMax = 30;
					const enabledPreview = enabledList.slice(0, previewMax);
					const enabledSuffix = enabledList.length > previewMax ? ` …(+${enabledList.length - previewMax})` : '';
					const hint =
						'当前对话未启用“写入/编辑”类工具，因此无法直接应用并保存到工作区文件。\n' +
						'打开 Tools 菜单勾选 createFile / editFiles（以及需要时的 createDirectory），或切换到允许写入的 Agent Profile 后再试。\n' +
						'小技巧：你也可以在输入里加上 #edit（工具集），用来显式引导/强制启用编辑相关工具。\n' +
						`(诊断) profile=${this.selectedAgentProfileId} enabledTools=${enabledPreview.join(', ')}${enabledSuffix}`;
					this.postToHost(state, { type: 'chatAppend', role: 'tool', text: hint });
					state.transcript.push({ role: 'tool', text: hint });
				}
			} catch {
				// ignore
			}

			let didInvokeEditTool = false;
			const enabledListForDiag = Array.from(built.enabledTools).map(String).filter(Boolean).sort((a, b) => a.localeCompare(b));

			let didStreamAssistant = false;
			const finalText = await runLmToolCallingLoop({
				model,
				conversation: state.conversation,
				enabledTools: built.enabledTools,
				toolDefinitions: built.toolDefinitions,
				commandTools: built.commandTools,
				mcpManager: this.mcpManager,
				policy: {
					agentProfileId: this.selectedAgentProfileId,
					askStudySandboxDir: String(
						vscode.workspace.getConfiguration('tripilot').get<string>('askStudySandboxDir', '.tripilot/ask-study') ??
						'.tripilot/ask-study'
					)
				},
				maxIterations: vscode.workspace.getConfiguration('tripilot').get<number>('maxToolIterations', 6),
				postStatus: (s) => this.setAndPostStatus(state, s.status, s.detail),
				postAssistantStart: (initialText) => {
					didStreamAssistant = true;
					state.inProgressAssistantText = initialText ?? '';
					this.postToHost(state, { type: 'chatAssistantStart', initialText });
				},
				postAssistantDelta: (delta) => {
					didStreamAssistant = true;
					state.inProgressAssistantText = (state.inProgressAssistantText ?? '') + delta;
					this.postToHost(state, { type: 'chatAssistantDelta', delta });
				},
				postAssistantEnd: () => {
					this.postToHost(state, { type: 'chatAssistantEnd' });
					state.inProgressAssistantText = undefined;
				},
				postToolInvocationBegin: (m) => {
					// Track whether the model actually invoked an edit tool.
					if (m.toolName === 'createFile' || m.toolName === 'create_file' || m.toolName === 'editFiles' || m.toolName === 'apply_patch' || m.toolName === 'edit_files') {
						didInvokeEditTool = true;
					}
					this.postToHost(state, m);
				},
				postToolInvocationEnd: (m) => {
					this.postToHost(state, m);
				},
				postTodoList: (m) => {
					this.postToHost(state, m);
				},
				postToolTrace: (toolText) => {
					this.postToHost(state, { type: 'chatAppend', role: 'tool', text: toolText });
					state.transcript.push({ role: 'tool', text: toolText });
					if (!(state.replayState?.active && state.replayState?.locked)) {
						void this.postSubagentTree(state);
					}
					void this.appendHistory(state, {
						kind: 'tool_trace',
						text: toolText,
						profileId: this.selectedAgentProfileId,
						modelId: this.selectedModelId
					});
				},
				requestEditsApproval: (a) => this.requestEditsApproval(state, a),
				postEditsReview: (a) => this.postEditsReview(state, a),
				abortSignal: state.abortController.signal,
				token: state.lmCancelSource.token
			});

			if (!didStreamAssistant) {
				this.postToHost(state, { type: 'chatAppend', role: 'assistant', text: finalText });
			}

			// If the user asked to write/apply changes, write tools are enabled, but the model didn't call any edit tool,
			// try a best-effort recovery: extract a diff/patch from the assistant response and route it through the normal
			// edit approval flow so the user can click Apply/Cancel.
			if (wantsWrite && hasWriteTools && !didInvokeEditTool) {
				try {
					const previewMax = 30;
					const enabledPreview = enabledListForDiag.slice(0, previewMax);
					const enabledSuffix = enabledListForDiag.length > previewMax ? ` …(+${enabledListForDiag.length - previewMax})` : '';
					const diag =
						`(诊断) profile=${this.selectedAgentProfileId} model=${this.selectedModelId || 'auto'} ` +
						`didInvokeEditTool=${didInvokeEditTool} enabledTools=${enabledPreview.join(', ')}${enabledSuffix}`;
					this.postToHost(state, { type: 'chatAppend', role: 'tool', text: diag });
					state.transcript.push({ role: 'tool', text: diag });
				} catch {
					// ignore
				}

				const diffBlock = extractFirstDiffBlock(finalText);
				if (diffBlock) {
					try {
						await executeToolCall(
							'apply_patch',
							{ input: diffBlock, explanation: 'Recovered from assistant-provided diff block.' },
							{
								abortSignal: state.abortController.signal,
								requestEditsApproval: (a) => this.requestEditsApproval(state, a),
								postEditsReview: (a) => this.postEditsReview(state, a),
								mcpManager: this.mcpManager,
								commandTools: built.commandTools,
								policy: {
									agentProfileId: this.selectedAgentProfileId,
									askStudySandboxDir: String(
										vscode.workspace.getConfiguration('tripilot').get<string>('askStudySandboxDir', '.tripilot/ask-study') ??
											'.tripilot/ask-study'
									)
								}
							}
						);
					} catch (err) {
						const msg = `未能自动将 diff 转为可应用的更改：${safeToString(err)}`;
						this.postToHost(state, { type: 'chatAppend', role: 'tool', text: msg });
						state.transcript.push({ role: 'tool', text: msg });
					}
				}
			}
			state.transcript.push({ role: 'assistant', text: finalText });
			await this.appendHistory(state, {
				kind: 'assistant_message',
				text: finalText,
				profileId: this.selectedAgentProfileId,
				modelId: this.selectedModelId
			});
			this.appendCheckpoint(state);
			this.setAndPostStatus(state, 'idle');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.appendHistory(state, {
				kind: 'error',
				message: message,
				profileId: this.selectedAgentProfileId,
				modelId: this.selectedModelId
			});
			this.setAndPostStatus(state, 'error', message);
			this.postToHost(state, { type: 'chatAppend', role: 'assistant', text: `Error: ${message}` });
			state.transcript.push({ role: 'assistant', text: `Error: ${message}` });
			this.appendCheckpoint(state);
		} finally {
			state.isBusy = false;
			state.inProgressAssistantText = undefined;
		}
	}

	private getHtml(webview: vscode.Webview, host: ChatHostKind = 'sidebar'): string {
		const nonce = getNonce();
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));

		const codiconUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
		);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} https:; font-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${codiconUri}" />
	<link rel="stylesheet" href="${styleUri}" />
	<title></title>
</head>

<body class="host-${host}">
	<div class="app">
		<div class="topbar" role="toolbar" aria-label="Chat toolbar">
			<div class="topbarLeft">
				<div class="topbarTitle">聊天</div>
			</div>
			<div class="topbarRight">
				<button class="icon ghost" id="btnTopNew" aria-label="New" title="New">
					<span class="codicon codicon-add"></span>
					<span class="codicon codicon-chevron-down"></span>
				</button>
				<button class="icon ghost" id="btnTopSettings" aria-label="Settings" title="Settings">
					<span class="codicon codicon-settings-gear"></span>
				</button>
				<button class="icon ghost" id="btnTopMore" aria-label="More" title="More">
					<span class="codicon codicon-ellipsis"></span>
				</button>
			</div>
			<div class="menu menuTop hidden" id="topNewMenu" role="menu" aria-label="New menu">
				<button class="menuItem" data-action="newSession" role="menuitem">新建聊天</button>
				<button class="menuItem" data-action="newChatEditor" role="menuitem">新建聊天编辑器</button>
				<button class="menuItem" data-action="newChatWindow" role="menuitem">新聊天窗口</button>
			</div>
			<div class="menu menuTop hidden" id="topMoreMenu" role="menu" aria-label="More menu">
				<button class="menuItem" data-action="moveToEditor" role="menuitem">将聊天移动到编辑器区域</button>
				<button class="menuItem" data-action="moveToNewWindow" role="menuitem">将聊天移动到新窗口</button>
				<div class="menuDivider" role="separator"></div>
				<button class="menuItem" data-action="showChat" role="menuitem">显示聊天...</button>
				<div class="menuDivider" role="separator"></div>
				<button class="menuItem" data-action="showChatDebug" role="menuitem">显示聊天调试视图</button>
				<button class="menuItem" data-action="defaultView" role="menuitem">默认显示视图</button>
			</div>
		</div>

		<div class="sessions" id="sessions" role="region" aria-label="Sessions">
			<div class="sessionNav hidden" id="sessionNav" role="toolbar" aria-label="Session navigation">
				<button class="icon ghost" id="btnSessionBack" aria-label="Back" title="Back">
					<span class="codicon codicon-arrow-left"></span>
				</button>
				<div class="sessionNavTitle" id="sessionNavTitle"></div>
			</div>
			<div class="sessionsHeader">
				<div class="sessionsHeaderLeft" id="sessionsHeaderText">RECENT SESSIONS</div>
				<div class="sessionsHeaderRight" id="sessionsHeaderActions">
					<button class="icon ghost hidden" id="btnSessionsRefresh" aria-label="Refresh" title="Refresh"><span class="codicon codicon-refresh"></span></button>
					<button class="icon ghost hidden" id="btnSessionsSearch" aria-label="Search" title="Search"><span class="codicon codicon-search"></span></button>
					<button class="icon ghost hidden" id="btnSessionsFilter" aria-label="Filter" title="Filter"><span class="codicon codicon-filter"></span></button>
					<button class="icon ghost" id="btnSessionsView" aria-label="View" title="View"><span class="codicon codicon-layout"></span></button>
				</div>
			</div>
			<div class="sessionsList" id="sessionsList"></div>
			<button class="sessionsToggle ghost" id="btnSessionsToggle">Show All Sessions</button>
		</div>

		<div class="approval hidden" id="approval" role="region" aria-label="Edit approval">
			<div class="approval-text" id="approvalText"></div>
			<div class="approval-files" id="approvalFiles"></div>
			<div class="approval-actions">
				<button class="ghost" id="approvalPreview">Preview</button>
				<button id="approvalApply">Apply</button>
				<button class="ghost" id="approvalCancel">Cancel</button>
			</div>
		</div>
		<div class="messages" id="messages" role="log" aria-live="polite"></div>
		<div class="composer">
			<div class="composerBox">
				<div class="composerTop">
					<button class="contextButton ghost" id="btnAddContext" aria-label="Add context" title="添加上下文">
						<span class="codicon codicon-clippy"></span>
						<span class="contextButtonText">添加上下文...</span>
					</button>
					<div class="composerTokens" aria-label="Prompt tokens">
						<div class="contextChips" id="contextChips" aria-label="Context"></div>
						<div class="contextChips toolChips" id="toolChips" aria-label="Tools"></div>
					</div>
				</div>
				<textarea id="input" rows="2" placeholder="描述下一步要构建的内容" aria-label="Chat input"></textarea>
				<div class="hashSuggest hidden" id="hashSuggest" role="listbox" aria-label="Suggestions"></div>
				<div class="composerBottom" role="toolbar" aria-label="Composer toolbar">
					<div class="bottomLeft">
						<button class="menuButton ghost" id="btnAgentMenu" aria-label="Agent" title="Agent">
							<span class="menuLabel" id="agentLabel">Agent</span>
							<span class="codicon codicon-chevron-down"></span>
						</button>
						<button class="menuButton ghost" id="btnModelMenu" aria-label="Model" title="Model">
							<span class="menuLabel" id="modelLabel">Model</span>
							<span class="codicon codicon-chevron-down"></span>
						</button>
						<button class="icon ghost" id="btnTools" aria-label="Tools" title="Tools（点击打开设置；Shift+点击快速开关）">
							<span class="codicon codicon-tools"></span>
						</button>
					</div>
					<div class="bottomCenter">
						<label class="tempSessionToggle" id="tempSessionToggleWrap" title="开启临时会话（不保存聊天记录）" aria-label="Temporary session">
							<input type="checkbox" id="tempSessionToggle" />
							<span class="tempSessionPill" id="tempSessionPill">临时会话</span>
						</label>
					</div>
					<div class="bottomRight">
						<button class="icon ghost" id="btnContinue" aria-label="Continue chat" title="Continue chat">
							<span class="codicon codicon-redo"></span>
						</button>
						<button id="send" class="icon send" title="Send" aria-label="Send">
							<span class="codicon codicon-send"></span>
						</button>
					</div>
				</div>

				<div class="menu hidden" id="agentMenu" role="menu" aria-label="Agent menu"></div>
					<div class="menu menuModel hidden" id="modelMenu" role="menu" aria-label="Model menu">
						<button class="menuItem" data-value="manageModels" role="menuitem">管理模型...</button>
					</div>
				<div class="menu hidden" id="toolsMenu" role="menu" aria-label="Tools menu">
					${Array.from(OPTIONAL_TOOL_NAMES.values())
						.sort((a, b) => a.localeCompare(b))
						.map((name) => `<label class="menuCheck"><input type="checkbox" data-tool="${name}" />${name}</label>`)
						.join('')}
				</div>
			</div>
		</div>
		<div class="status" id="status"></div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private async refreshSessionsAndPost(): Promise<void> {
		const sidebar = this.hostStates.sidebar;
		if (!sidebar.webview) return;
		const isEnabled = this.isChatHistoryEnabled();
		if (!isEnabled) {
			this.postToHost(sidebar, { type: 'sessions', isHistoryEnabled: false, sessions: [] });
			return;
		}
		const archivedRaw = this.context.globalState.get<string[]>('tripilot.archivedSessionIds') ?? [];
		const archived = new Set(archivedRaw.map((s) => String(s).trim()).filter(Boolean));
		const sessions = await this.listStoredHistorySessions();
		const items = sessions
			.filter((s) => !archived.has(s.sessionId))
			.map((s) => ({
				sessionId: s.sessionId,
				title: s.title,
				preview: s.lastPreview,
				relativeTime: this.formatRelativeTime(s.lastAt || s.startedAt),
				isActive: s.sessionId === sidebar.historySessionId
			}));
		this.postToHost(sidebar, { type: 'sessions', isHistoryEnabled: true, sessions: items });
	}

	private async requestEditsApproval(
		state: ChatHostState,
		args: {
		previews: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }>;
		summary: { editCount: number; fileCount: number };
		canPreview: boolean;
		}
	): Promise<'apply' | 'cancel'> {
		// If webview isn't available, fall back to a modal (best-effort).
		if (!state.webview) {
			const picked = await vscode.window.showInformationMessage(
				`Tripilot wants to apply ${args.summary.editCount} edit(s) to ${args.summary.fileCount} file(s).`,
				{ modal: true },
				'Apply',
				'Cancel'
			);
			return picked === 'Apply' ? 'apply' : 'cancel';
		}

		// If there is an existing pending approval, cancel it.
		this.resolvePendingEditApproval('cancel');

		const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const files = args.previews.map((p) => ({ relativePath: p.relativePath, editCount: p.editCount }));
		const { additions, deletions } = computeDiffStats(args.previews);
		const summaryText = `Tripilot wants to apply ${args.summary.editCount} edit(s) to ${args.summary.fileCount} file(s).`;
		void this.appendHistory(state, {
			kind: 'approval_request',
			requestId,
			summary: args.summary,
			files,
			profileId: this.selectedAgentProfileId,
			modelId: this.selectedModelId
		});

		this.pendingEditApproval = {
			requestId,
			originHost: state.kind,
			resolve: () => {
				// placeholder; replaced below
			},
			previews: args.previews,
			canPreview: args.canPreview
		};

		this.postToHost(state, {
			type: 'editApprovalRequest',
			requestId,
			summary: summaryText,
			files,
			diffStats: { filesChanged: args.summary.fileCount, additions, deletions },
			canPreview: args.canPreview
		});

		return await new Promise<'apply' | 'cancel'>((resolve) => {
			if (!this.pendingEditApproval || this.pendingEditApproval.requestId !== requestId) {
				resolve('cancel');
				return;
			}
			this.pendingEditApproval.resolve = (v) => {
							void this.appendHistory(state, {
									kind: 'approval_decision',
									requestId,
									decision: v,
									profileId: this.selectedAgentProfileId,
									modelId: this.selectedModelId
								});
				this.postToHost(state, { type: 'editApprovalClear', requestId });
				this.pendingEditApproval = undefined;
				resolve(v);
			};
		});
	}

	private resolvePendingEditApproval(result: 'apply' | 'cancel') {
		if (!this.pendingEditApproval) return;
		try {
			this.pendingEditApproval.resolve(result);
		} catch {
			// ignore
		}
	}

	private async handleEditApprovalAction(
		state: ChatHostState,
		msg: Extract<WebviewInboundMessage, { type: 'editApprovalAction' }>
	) {
		const pending = this.pendingEditApproval;
		if (!pending) return;
		if (pending.originHost !== state.kind) return;
		if (pending.requestId !== msg.requestId) return;

		if (msg.action === 'preview') {
			if (!pending.canPreview) return;
			await previewEditsInDiff(pending.previews);
			return;
		}

		if (msg.action === 'apply') {
			pending.resolve('apply');
			return;
		}
		pending.resolve('cancel');
	}

	private postEditsReview(
		state: ChatHostState,
		args: {
			requestId: string;
			previews: Array<{
				relativePath: string;
				uri: vscode.Uri;
				original: string;
				updated: string;
				editCount: number;
				kind: 'add' | 'update' | 'delete';
			}>;
			summary: { editCount: number; fileCount: number };
			canPreview: boolean;
		}
	) {
		if (!state.webview) return;
		const requestId = String(args.requestId || '');
		if (!requestId) return;
		// Record in the applied edits timeline (used by checkpoints/restore).
		const seq = ++this.appliedEditSeq;
		this.appliedEditsTimelineByHost[state.kind].push({
			seq,
			requestId,
			previews: args.previews,
			createdAt: Date.now()
		});
		this.pendingEditReviews.set(requestId, {
			originHost: state.kind,
			previews: args.previews,
			canPreview: Boolean(args.canPreview),
			createdAt: Date.now()
		});
		this.lastEditReviewRequestIdByHost[state.kind] = requestId;
		const files = args.previews.map((p) => ({ relativePath: p.relativePath, editCount: p.editCount }));
		const { additions, deletions } = computeDiffStats(args.previews);
		const summaryText = `已应用 ${args.summary.editCount} 处修改（${args.summary.fileCount} 个文件）。`;
		this.postToHost(state, {
			type: 'editReviewRequest',
			requestId,
			summary: summaryText,
			files,
			diffStats: { filesChanged: args.summary.fileCount, additions, deletions },
			canPreview: Boolean(args.canPreview)
		});
	}

	private appendCheckpoint(state: ChatHostState): void {
		const checkpointId = createUuid();
		const lastEditSeq = this.appliedEditsTimelineByHost[state.kind].length
			? this.appliedEditsTimelineByHost[state.kind][this.appliedEditsTimelineByHost[state.kind].length - 1].seq
			: 0;
		const conversationSnapshot = [...state.conversation];
		let copilotConversationSnapshot: OpenAIChatMessage[] | undefined = undefined;
		if (state.copilotConversation) {
			try {
				copilotConversationSnapshot = structuredClone(state.copilotConversation);
			} catch {
				copilotConversationSnapshot = [...state.copilotConversation];
			}
		}

		state.transcript.push({ role: 'checkpoint', checkpointId });
		this.checkpointsById.set(checkpointId, {
			originHost: state.kind,
			transcriptIndex: state.transcript.length,
			lastEditSeq,
			conversationSnapshot,
			copilotConversationSnapshot,
			createdAt: Date.now()
		});
		this.postToHost(state, { type: 'chatCheckpoint', checkpointId });
	}

	private async handleCheckpointAction(
		state: ChatHostState,
		msg: Extract<WebviewInboundMessage, { type: 'checkpointAction' }>
	): Promise<void> {
		const checkpointId = String(msg.checkpointId || '').trim();
		if (!checkpointId) return;

		if (msg.action === 'redo') {
			const rec = this.lastCheckpointRestoreByHost[state.kind];
			const token = String((msg as any).redoToken ?? '').trim();
			if (!rec) return;
			if (rec.restoredToCheckpointId !== checkpointId) return;
			if (!token || token !== rec.redoToken) return;

			// Abort any in-flight run for this host.
			try {
				state.abortController?.abort();
			} catch {
				// ignore
			}
			state.abortController = undefined;
			try {
				state.lmCancelSource?.cancel();
				state.lmCancelSource?.dispose();
			} catch {
				// ignore
			}
			state.lmCancelSource = undefined;
			state.isBusy = false;
			state.inProgressAssistantText = undefined;
			if (this.pendingEditApproval?.originHost === state.kind) {
				this.resolvePendingEditApproval('cancel');
			}

			// Re-apply edits that were undone during restore.
			const entriesToRedo = rec.appliedTimelineBefore
				.filter((e) => e.seq > rec.checkpointLastEditSeq)
				.sort((a, b) => a.seq - b.seq);
			for (const entry of entriesToRedo) {
				for (const p of entry.previews) {
					if (p.kind === 'delete') {
						try {
							await vscode.workspace.fs.delete(p.uri, { recursive: false, useTrash: true });
						} catch {
							// ignore
						}
						continue;
					}
					await ensureParentDir(p.uri);
					await vscode.workspace.fs.writeFile(p.uri, Buffer.from(p.updated ?? '', 'utf8'));
				}
			}

			// Restore applied edits timeline and edit review handlers.
			this.appliedEditsTimelineByHost[state.kind] = [...rec.appliedTimelineBefore];
			for (const entry of entriesToRedo) {
				this.pendingEditReviews.set(entry.requestId, {
					originHost: state.kind,
					previews: entry.previews,
					canPreview: true,
					createdAt: entry.createdAt
				});
				this.lastEditReviewRequestIdByHost[state.kind] = entry.requestId;
			}

			// Restore checkpoints that were deleted during restore.
			for (const item of rec.removedCheckpoints) {
				this.checkpointsById.set(item.id, item.rec);
			}

			// Restore transcript and conversations.
			state.transcript = [...rec.transcriptBefore];
			state.conversation = [...rec.conversationBefore];
			if (rec.copilotConversationBefore) {
				try {
					state.copilotConversation = structuredClone(rec.copilotConversationBefore);
				} catch {
					state.copilotConversation = [...rec.copilotConversationBefore];
				}
			}
			this.setAndPostStatus(state, 'idle');

			// Clear redo offer after using it.
			this.lastCheckpointRestoreByHost[state.kind] = undefined;
			this.postToHost(state, { type: 'checkpointRedoClear' });

			// Re-render transcript.
			this.postToHost(state, { type: 'chatReset' });
			for (const item of state.transcript) {
				if ((item as any).role === 'checkpoint') {
					this.postToHost(state, { type: 'chatCheckpoint', checkpointId: (item as any).checkpointId });
					continue;
				}
				const msgItem = item as Extract<ChatTranscriptItem, { role: 'user' | 'assistant' | 'tool' }>;
				this.postToHost(state, { type: 'chatAppend', role: msgItem.role, text: msgItem.text });
			}

			// Re-post edit review cards so their Undo/Keep actions remain available after redo.
			for (const entry of entriesToRedo) {
				const files = entry.previews.map((p) => ({ relativePath: p.relativePath, editCount: p.editCount }));
				const editCount = files.reduce((n, f) => n + (Number(f.editCount) || 0), 0);
				const fileCount = new Set(files.map((f) => f.relativePath)).size;
				const summaryText = `已应用 ${editCount} 处修改（${fileCount} 个文件）。`;
				this.postToHost(state, {
					type: 'editReviewRequest',
					requestId: entry.requestId,
					summary: summaryText,
					files,
					canPreview: true
				});
			}
			return;
		}

		if (msg.action !== 'restore') return;
		const cp = this.checkpointsById.get(checkpointId);
		if (!cp) return;
		if (cp.originHost !== state.kind) return;

		// Prepare redo snapshot BEFORE mutating anything.
		const redoToken = createUuid();
		const transcriptBefore: ChatTranscriptItem[] = [...state.transcript];
		const conversationBefore = [...state.conversation];
		let copilotConversationBefore: OpenAIChatMessage[] | undefined = undefined;
		if (state.copilotConversation) {
			try {
				copilotConversationBefore = structuredClone(state.copilotConversation);
			} catch {
				copilotConversationBefore = [...state.copilotConversation];
			}
		}
		const timelineBefore = [...this.appliedEditsTimelineByHost[state.kind]];
		const removedCheckpoints: Array<{ id: string; rec: any }> = [];
		for (const [id, rec] of Array.from(this.checkpointsById.entries())) {
			if (rec.originHost !== state.kind) continue;
			if (rec.createdAt > cp.createdAt) removedCheckpoints.push({ id, rec });
		}

		// Abort any in-flight run for this host.
		try {
			state.abortController?.abort();
		} catch {
			// ignore
		}
		state.abortController = undefined;
		try {
			state.lmCancelSource?.cancel();
			state.lmCancelSource?.dispose();
		} catch {
			// ignore
		}
		state.lmCancelSource = undefined;
		state.isBusy = false;
		state.inProgressAssistantText = undefined;
		if (this.pendingEditApproval?.originHost === state.kind) {
			this.resolvePendingEditApproval('cancel');
		}

		// Undo applied edits after the checkpoint.
		const timeline = this.appliedEditsTimelineByHost[state.kind];
		const toUndo = timeline.filter((e) => e.seq > cp.lastEditSeq).sort((a, b) => b.seq - a.seq);
		for (const entry of toUndo) {
			for (const p of entry.previews) {
				if (p.kind === 'add') {
					try {
						await vscode.workspace.fs.delete(p.uri, { recursive: false, useTrash: true });
					} catch {
						// ignore
					}
					continue;
				}
				await ensureParentDir(p.uri);
				await vscode.workspace.fs.writeFile(p.uri, Buffer.from(p.original ?? '', 'utf8'));
			}
			// Clear any existing review card for this request id.
			this.pendingEditReviews.delete(entry.requestId);
			if (this.lastEditReviewRequestIdByHost[state.kind] === entry.requestId) {
				this.lastEditReviewRequestIdByHost[state.kind] = undefined;
			}
			this.postToHost(state, { type: 'editReviewClear', requestId: entry.requestId });
		}
		this.appliedEditsTimelineByHost[state.kind] = timeline.filter((e) => e.seq <= cp.lastEditSeq);

		// Truncate transcript and restore model conversations.
		state.transcript = state.transcript.slice(0, Math.max(0, Math.min(cp.transcriptIndex, state.transcript.length)));
		state.conversation = [...cp.conversationSnapshot];
		if (cp.copilotConversationSnapshot) {
			try {
				state.copilotConversation = structuredClone(cp.copilotConversationSnapshot);
			} catch {
				state.copilotConversation = [...cp.copilotConversationSnapshot];
			}
		}
		this.setAndPostStatus(state, 'idle');

		// Drop checkpoints after this point for this host (they no longer exist in transcript).
		for (const [id, rec] of Array.from(this.checkpointsById.entries())) {
			if (rec.originHost !== state.kind) continue;
			if (rec.createdAt > cp.createdAt) {
				this.checkpointsById.delete(id);
			}
		}

		// Re-render transcript.
		this.postToHost(state, { type: 'chatReset' });
		for (const item of state.transcript) {
			if ((item as any).role === 'checkpoint') {
				this.postToHost(state, { type: 'chatCheckpoint', checkpointId: (item as any).checkpointId });
				continue;
			}
			const msgItem = item as Extract<ChatTranscriptItem, { role: 'user' | 'assistant' | 'tool' }>;
			this.postToHost(state, { type: 'chatAppend', role: msgItem.role, text: msgItem.text });
		}

		// Offer redo (Copilot-like): available right after restoring.
		this.lastCheckpointRestoreByHost[state.kind] = {
			restoredToCheckpointId: checkpointId,
			checkpointLastEditSeq: cp.lastEditSeq,
			redoToken,
			createdAt: Date.now(),
			transcriptBefore,
			conversationBefore,
			copilotConversationBefore,
			appliedTimelineBefore: timelineBefore,
			removedCheckpoints
		};
		this.postToHost(state, { type: 'checkpointRedoOffer', checkpointId, redoToken });
	}

	private async handleEditReviewAction(
		state: ChatHostState,
		msg: Extract<WebviewInboundMessage, { type: 'editReviewAction' }>
	) {
		const requestId = String(msg.requestId || '');
		if (!requestId) return;
		const pending = this.pendingEditReviews.get(requestId);
		if (!pending) return;
		if (pending.originHost !== state.kind) return;

		if (msg.action === 'preview') {
			if (!pending.canPreview) return;
			await previewEditsInDiff(
				pending.previews.map((p) => ({
					relativePath: p.relativePath,
					uri: p.uri,
					original: p.original,
					updated: p.updated,
					editCount: p.editCount
				}))
			);
			return;
		}

		if (msg.action === 'keep') {
			this.pendingEditReviews.delete(requestId);
			if (this.lastEditReviewRequestIdByHost[state.kind] === requestId) {
				this.lastEditReviewRequestIdByHost[state.kind] = undefined;
			}
			this.postToHost(state, { type: 'editReviewClear', requestId });
			return;
		}

		// undo
		for (const p of pending.previews) {
			if (p.kind === 'add') {
				try {
					await vscode.workspace.fs.delete(p.uri, { recursive: false, useTrash: true });
				} catch {
					// ignore
				}
				continue;
			}
			await ensureParentDir(p.uri);
			await vscode.workspace.fs.writeFile(p.uri, Buffer.from(p.original ?? '', 'utf8'));
		}
		this.pendingEditReviews.delete(requestId);
		if (this.lastEditReviewRequestIdByHost[state.kind] === requestId) {
			this.lastEditReviewRequestIdByHost[state.kind] = undefined;
		}
		this.postToHost(state, { type: 'editReviewClear', requestId });
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function createUuid(): string {
	try {
		return typeof (crypto as any).randomUUID === 'function'
			? (crypto as any).randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	} catch {
		return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}
}

function extractFirstDiffBlock(text: string): string | undefined {
	const s = String(text ?? '');
	// Fast path: common marker.
	if (s.includes('diff --git')) {
		const idx = s.indexOf('diff --git');
		if (idx >= 0) {
			// If it's inside a fenced block, prefer the fenced content.
			// Otherwise, take a bounded slice to avoid grabbing the entire answer.
			const slice = s.slice(idx);
			const endFence = slice.indexOf('```');
			if (endFence > 0) return slice.slice(0, endFence).trim();
			return slice.trim();
		}
	}

	// Parse fenced blocks: ```lang\n...\n```
	let i = 0;
	while (i < s.length) {
		const start = s.indexOf('```', i);
		if (start < 0) break;
		const langLineEnd = s.indexOf('\n', start + 3);
		if (langLineEnd < 0) break;
		const lang = s
			.slice(start + 3, langLineEnd)
			.trim()
			.toLowerCase();
		const end = s.indexOf('```', langLineEnd + 1);
		if (end < 0) break;
		const body = s.slice(langLineEnd + 1, end).trim();
		const looksLikeDiff =
			lang === 'diff' ||
			lang === 'patch' ||
			body.startsWith('diff --git') ||
			body.startsWith('--- ') ||
			body.startsWith('*** Begin Patch');
		if (looksLikeDiff && body) return body;
		i = end + 3;
	}
	return undefined;
}

async function runLmToolCallingLoop(args: {
	model: vscode.LanguageModelChat;
	conversation: vscode.LanguageModelChatMessage[];
	enabledTools: Set<string>;
	toolDefinitions: ReturnType<typeof getToolDefinitions>;
	commandTools: Map<string, CommandToolConfig>;
	mcpManager: McpClientManager;
	policy?: ToolPolicy;
	maxIterations: number;
	postStatus: (m: Extract<WebviewOutboundMessage, { type: 'chatSetStatus' }>) => void;
	postAssistantStart?: (initialText?: string) => void;
	postAssistantDelta?: (delta: string) => void;
	postAssistantEnd?: () => void;
	postToolTrace?: (text: string) => void;
	postToolInvocationBegin?: (m: Extract<WebviewOutboundMessage, { type: 'chatToolInvocationBegin' }>) => void;
	postToolInvocationEnd?: (m: Extract<WebviewOutboundMessage, { type: 'chatToolInvocationEnd' }>) => void;
	postTodoList?: (m: Extract<WebviewOutboundMessage, { type: 'chatTodoList' }>) => void;
	requestEditsApproval?: ToolRuntime['requestEditsApproval'];
	postEditsReview?: ToolRuntime['postEditsReview'];
	abortSignal: AbortSignal;
	token: vscode.CancellationToken;
}): Promise<string> {
	const truncateForWebview = (text: string, max = 20_000) => {
		const s = String(text ?? '');
		if (s.length <= max) return s;
		return s.slice(0, max) + `\n…(truncated, ${s.length - max} chars)`;
	};

	const runSubagent: ToolRuntime['runSubagent'] = async ({ prompt, description }) => {
		args.abortSignal.throwIfAborted?.();
		const enabledTools = new Set(args.enabledTools);
		enabledTools.delete('runSubagent');
		enabledTools.delete('agent.runSubagent');
		const subConversation: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(
				`[Subagent]\nTask: ${description}\n` +
					'Work autonomously and return ONLY the final result. Do not include intermediate reasoning or tool logs.'
			),
			vscode.LanguageModelChatMessage.User(String(prompt ?? ''))
		];
		return await runLmToolCallingLoop({
			model: args.model,
			conversation: subConversation,
			enabledTools,
			toolDefinitions: args.toolDefinitions,
			commandTools: args.commandTools,
			mcpManager: args.mcpManager,
			policy: args.policy,
			maxIterations: Math.min(8, Math.max(2, args.maxIterations)),
			postStatus: () => {
				// keep subagent quiet
			},
			postAssistantStart: undefined,
			postAssistantDelta: undefined,
			postAssistantEnd: undefined,
			postToolTrace: undefined,
			requestEditsApproval: args.requestEditsApproval,
			abortSignal: args.abortSignal,
			token: args.token
		});
	};

	const lmTools: vscode.LanguageModelChatTool[] = args.toolDefinitions
		.filter((t) => args.enabledTools.has(t.function.name))
		.map((t) => ({
			name: t.function.name,
			description: t.function.description,
			inputSchema: t.function.parameters
		}));

	for (let iteration = 0; iteration < args.maxIterations; iteration++) {
		args.abortSignal.throwIfAborted?.();
		args.postStatus({ type: 'chatSetStatus', status: iteration === 0 ? 'thinking' : 'running-tools' });

		const response = await args.model.sendRequest(
			args.conversation,
			{
				tools: lmTools,
				toolMode: vscode.LanguageModelChatToolMode.Auto
			},
			args.token
		);

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let streamedAnyText = false;

		for await (const part of response.stream) {
			// Cooperative cancellation across both abort styles.
			args.abortSignal.throwIfAborted?.();
			if (args.token.isCancellationRequested) throw new Error('Canceled.');

			if (part instanceof vscode.LanguageModelTextPart) {
				if (!streamedAnyText) {
					streamedAnyText = true;
					args.postAssistantStart?.('');
				}
				args.postAssistantDelta?.(part.value);
				assistantParts.push(part);
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				assistantParts.push(part);
				toolCalls.push(part);
				continue;
			}
		}

		if (streamedAnyText) {
			args.postAssistantEnd?.();
		}

		if (assistantParts.length) {
			args.conversation.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
		}

		if (toolCalls.length === 0) {
			const finalText = assistantParts
				.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
				.map((p) => p.value)
				.join('');
			return finalText;
		}

		const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
		for (const call of toolCalls) {
			const invocationId = String(call.callId ?? createUuid());
			const inputPreview = safeOneLine(JSON.stringify(call.input ?? {}));
			args.postToolInvocationBegin?.({
				type: 'chatToolInvocationBegin',
				invocationId,
				toolName: call.name,
				inputPreview
			});
			args.postToolTrace?.(`→ ${call.name}(${inputPreview})`);
			const startedAt = Date.now();
			let resultText = '';
			let ok = true;
			try {
				resultText = await executeToolCall(call.name, call.input, {
					abortSignal: args.abortSignal,
					requestEditsApproval: args.requestEditsApproval,
					postEditsReview: args.postEditsReview,
					runSubagent,
					mcpManager: args.mcpManager,
					commandTools: args.commandTools,
					policy: args.policy
				});
			} catch (err) {
				ok = false;
				resultText = JSON.stringify({ error: true, ...serializeUnknownError(err) }, null, 2);
			}
			const durationMs = Date.now() - startedAt;
			const outputPreview = safeOneLine(resultText, 800);
			args.postToolInvocationEnd?.({
				type: 'chatToolInvocationEnd',
				invocationId,
				toolName: call.name,
				ok,
				outputPreview,
				outputFull: truncateForWebview(resultText),
				durationMs
			});
			args.postToolTrace?.(`← ${call.name}: ${outputPreview}`);

			if (call.name === 'manage_todo_list') {
				try {
					const parsed = JSON.parse(resultText);
					const todoList = Array.isArray(parsed?.todoList) ? parsed.todoList : [];
					const note = typeof parsed?.note === 'string' ? parsed.note : undefined;
					if (todoList.length) {
						args.postTodoList?.({ type: 'chatTodoList', todoList, note });
					}
				} catch {
					// ignore
				}
			}

			toolResultParts.push(
				new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(resultText)])
			);
		}

		// Feed tool results back into the model.
		args.conversation.push(vscode.LanguageModelChatMessage.User(toolResultParts));
	}

	throw new Error(`Tool loop exceeded max iterations (${args.maxIterations}).`);
}

async function runModelsDirectToolCallingLoop(args: {
	client: ModelsDirectClient;
	cfg: { baseUrl: string; apiKey?: string };
	modelId: string;
	conversation: OpenAIChatMessage[];
	enabledTools: Set<string>;
	toolDefinitions: OpenAITool[];
	commandTools: Map<string, CommandToolConfig>;
	mcpManager: McpClientManager;
	policy?: ToolPolicy;
	maxIterations: number;
	intent?: string;
	additionalHeaders?: Record<string, string>;
	requestMeta?: { modelTag?: string; modelExtra?: any; extraFieldName?: string };
	postStatus: (m: Extract<WebviewOutboundMessage, { type: 'chatSetStatus' }>) => void;
	postAssistantStart?: (initialText?: string) => void;
	postAssistantDelta?: (delta: string) => void;
	postAssistantEnd?: () => void;
	postToolTrace?: (text: string) => void;
	postToolInvocationBegin?: (m: Extract<WebviewOutboundMessage, { type: 'chatToolInvocationBegin' }>) => void;
	postToolInvocationEnd?: (m: Extract<WebviewOutboundMessage, { type: 'chatToolInvocationEnd' }>) => void;
	postTodoList?: (m: Extract<WebviewOutboundMessage, { type: 'chatTodoList' }>) => void;
	requestEditsApproval?: ToolRuntime['requestEditsApproval'];
	postEditsReview?: ToolRuntime['postEditsReview'];
	abortSignal: AbortSignal;
	token: vscode.CancellationToken;
}): Promise<string> {
	const truncateForWebview = (text: string, max = 20_000) => {
		const s = String(text ?? '');
		if (s.length <= max) return s;
		return s.slice(0, max) + `\n…(truncated, ${s.length - max} chars)`;
	};

	const runSubagent: ToolRuntime['runSubagent'] = async ({ prompt, description }) => {
		args.abortSignal.throwIfAborted?.();
		const enabledTools = new Set(args.enabledTools);
		enabledTools.delete('runSubagent');
		enabledTools.delete('agent.runSubagent');
		const subConversation: OpenAIChatMessage[] = [
			{
				role: 'system',
				content:
					`You are a context-isolated subagent. Task: ${description}.\n` +
					'Work autonomously and return ONLY the final result. Do not include intermediate reasoning or tool logs.'
			},
			{ role: 'user', content: String(prompt ?? '') }
		];
		return await runModelsDirectToolCallingLoop({
			client: args.client,
			cfg: args.cfg,
			modelId: args.modelId,
			conversation: subConversation,
			enabledTools,
			toolDefinitions: args.toolDefinitions,
			commandTools: args.commandTools,
			mcpManager: args.mcpManager,
			policy: args.policy,
			maxIterations: Math.min(8, Math.max(2, args.maxIterations)),
			intent: args.intent,
			additionalHeaders: args.additionalHeaders,
			requestMeta: args.requestMeta,
			postStatus: () => {
				// keep subagent quiet
			},
			postAssistantStart: undefined,
			postAssistantDelta: undefined,
			postAssistantEnd: undefined,
			postToolTrace: undefined,
			requestEditsApproval: args.requestEditsApproval,
			abortSignal: args.abortSignal,
			token: args.token
		});
	};

	const tools: OpenAITool[] = args.toolDefinitions.filter((t) => args.enabledTools.has(t.function.name));

	for (let iteration = 0; iteration < args.maxIterations; iteration++) {
		args.abortSignal.throwIfAborted?.();
		if (args.token.isCancellationRequested) throw new Error('Canceled.');
		args.postStatus({ type: 'chatSetStatus', status: iteration === 0 ? 'thinking' : 'running-tools' });

		const abort = new AbortController();
		const d1 = args.token.onCancellationRequested(() => abort.abort());
		const onAbort = () => abort.abort();
		args.abortSignal.addEventListener('abort', onAbort, { once: true });

		let streamedAnyText = false;
		try {
			const result = await args.client.streamChatCompletions({
				cfg: { baseUrl: args.cfg.baseUrl, apiKey: args.cfg.apiKey },
				model: args.modelId,
				messages: args.conversation,
				tools: tools.length ? tools : undefined,
				requestMeta: args.requestMeta,
				headers: args.additionalHeaders,
				signal: abort.signal,
				onTextDelta: (delta) => {
					if (!streamedAnyText) {
						streamedAnyText = true;
						args.postAssistantStart?.('');
					}
					args.postAssistantDelta?.(delta);
				}
			});

			if (streamedAnyText) args.postAssistantEnd?.();

			const assistantMsg: OpenAIChatMessage = {
				role: 'assistant',
				content: result.assistantText,
				...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {})
			};
			args.conversation.push(assistantMsg);

			if (!result.toolCalls.length) {
				return result.assistantText;
			}

			for (const call of result.toolCalls) {
				const name = call.function.name;
				const rawArgs = call.function.arguments ?? '';
				let parsedArgs: any = {};
				try {
					parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
				} catch {
					parsedArgs = { _parseError: true, raw: rawArgs };
				}

				const invocationId = String(call.id ?? createUuid());
				const inputPreview = safeOneLine(JSON.stringify(parsedArgs ?? {}));
				args.postToolInvocationBegin?.({
					type: 'chatToolInvocationBegin',
					invocationId,
					toolName: name,
					inputPreview
				});
				args.postToolTrace?.(`→ ${name}(${inputPreview})`);
				const startedAt = Date.now();
				let resultText = '';
				let ok = true;
				try {
					resultText = await executeToolCall(name, parsedArgs, {
						abortSignal: args.abortSignal,
						requestEditsApproval: args.requestEditsApproval,
						postEditsReview: args.postEditsReview,
						runSubagent,
						mcpManager: args.mcpManager,
						commandTools: args.commandTools,
						policy: args.policy
					});
				} catch (err) {
					ok = false;
					resultText = JSON.stringify({ error: true, ...serializeUnknownError(err) }, null, 2);
				}
				const durationMs = Date.now() - startedAt;
				const outputPreview = safeOneLine(resultText, 800);
				args.postToolInvocationEnd?.({
					type: 'chatToolInvocationEnd',
					invocationId,
					toolName: name,
					ok,
					outputPreview,
					outputFull: truncateForWebview(resultText),
					durationMs
				});
				args.postToolTrace?.(`← ${name}: ${outputPreview}`);

				if (name === 'manage_todo_list') {
					try {
						const parsed = JSON.parse(resultText);
						const todoList = Array.isArray(parsed?.todoList) ? parsed.todoList : [];
						const note = typeof parsed?.note === 'string' ? parsed.note : undefined;
						if (todoList.length) {
							args.postTodoList?.({ type: 'chatTodoList', todoList, note });
						}
					} catch {
						// ignore
					}
				}

				args.conversation.push({ role: 'tool', tool_call_id: call.id, content: resultText });
			}
		} finally {
			try {
				args.abortSignal.removeEventListener('abort', onAbort);
			} catch {
				// ignore
			}
			d1.dispose();
		}
	}

	throw new Error(`Tool loop exceeded max iterations (${args.maxIterations}).`);
}

async function runCopilotDirectToolCallingLoop(args: {
	client: CopilotDirectClient;
	tokenManager: CopilotTokenManager;
	modelId: string;
	conversation: OpenAIChatMessage[];
	enabledTools: Set<string>;
	toolDefinitions: OpenAITool[];
	commandTools: Map<string, CommandToolConfig>;
	mcpManager: McpClientManager;
	policy?: ToolPolicy;
	maxIterations: number;
	intent?: string;
	additionalHeaders?: Record<string, string>;
	postStatus: (m: Extract<WebviewOutboundMessage, { type: 'chatSetStatus' }>) => void;
	postAssistantStart?: (initialText?: string) => void;
	postAssistantDelta?: (delta: string) => void;
	postAssistantEnd?: () => void;
	postToolTrace?: (text: string) => void;
	postToolInvocationBegin?: (m: Extract<WebviewOutboundMessage, { type: 'chatToolInvocationBegin' }>) => void;
	postToolInvocationEnd?: (m: Extract<WebviewOutboundMessage, { type: 'chatToolInvocationEnd' }>) => void;
	postTodoList?: (m: Extract<WebviewOutboundMessage, { type: 'chatTodoList' }>) => void;
	requestEditsApproval?: ToolRuntime['requestEditsApproval'];
	postEditsReview?: ToolRuntime['postEditsReview'];
	abortSignal: AbortSignal;
	token: vscode.CancellationToken;
}): Promise<string> {
	const truncateForWebview = (text: string, max = 20_000) => {
		const s = String(text ?? '');
		if (s.length <= max) return s;
		return s.slice(0, max) + `\n…(truncated, ${s.length - max} chars)`;
	};

	const runSubagent: ToolRuntime['runSubagent'] = async ({ prompt, description }) => {
		args.abortSignal.throwIfAborted?.();
		const enabledTools = new Set(args.enabledTools);
		enabledTools.delete('runSubagent');
		enabledTools.delete('agent.runSubagent');
		const subConversation: OpenAIChatMessage[] = [
			{
				role: 'system',
				content:
					`You are a context-isolated subagent. Task: ${description}.\n` +
					'Work autonomously and return ONLY the final result. Do not include intermediate reasoning or tool logs.'
			},
			{ role: 'user', content: String(prompt ?? '') }
		];
		return await runCopilotDirectToolCallingLoop({
			client: args.client,
			tokenManager: args.tokenManager,
			modelId: args.modelId,
			conversation: subConversation,
			enabledTools,
			toolDefinitions: args.toolDefinitions,
			commandTools: args.commandTools,
			mcpManager: args.mcpManager,
			policy: args.policy,
			maxIterations: Math.min(8, Math.max(2, args.maxIterations)),
			intent: args.intent,
			additionalHeaders: args.additionalHeaders,
			postStatus: () => {
				// keep subagent quiet
			},
			postAssistantStart: undefined,
			postAssistantDelta: undefined,
			postAssistantEnd: undefined,
			postToolTrace: undefined,
			requestEditsApproval: args.requestEditsApproval,
			abortSignal: args.abortSignal,
			token: args.token
		});
	};

	const tools: OpenAITool[] = args.toolDefinitions.filter((t) => args.enabledTools.has(t.function.name));

	for (let iteration = 0; iteration < args.maxIterations; iteration++) {
		args.abortSignal.throwIfAborted?.();
		if (args.token.isCancellationRequested) throw new Error('Canceled.');
		args.postStatus({ type: 'chatSetStatus', status: iteration === 0 ? 'thinking' : 'running-tools' });

		const copilotToken = await args.tokenManager.getCopilotToken();

		const abort = new AbortController();
		const d1 = args.token.onCancellationRequested(() => abort.abort());
		const onAbort = () => abort.abort();
		args.abortSignal.addEventListener('abort', onAbort, { once: true });

		let streamedAnyText = false;
		try {
			const result = await args.client.streamChatCompletions({
				copilotToken,
				model: args.modelId,
				messages: args.conversation,
				tools: tools.length ? tools : undefined,
				intent: args.intent,
				headers: args.additionalHeaders,
				signal: abort.signal,
				onTextDelta: (delta) => {
					if (!streamedAnyText) {
						streamedAnyText = true;
						args.postAssistantStart?.('');
					}
					args.postAssistantDelta?.(delta);
				}
			});

			if (streamedAnyText) args.postAssistantEnd?.();

			// Append assistant message (with tool calls if present).
			const assistantMsg: OpenAIChatMessage = {
				role: 'assistant',
				content: result.assistantText,
				...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {})
			};
			args.conversation.push(assistantMsg);

			if (!result.toolCalls.length) {
				return result.assistantText;
			}

			for (const call of result.toolCalls) {
				const name = call.function.name;
				const rawArgs = call.function.arguments ?? '';
				let parsedArgs: any = {};
				try {
					parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
				} catch {
					parsedArgs = { _parseError: true, raw: rawArgs };
				}

				const invocationId = String(call.id ?? createUuid());
				const inputPreview = safeOneLine(JSON.stringify(parsedArgs ?? {}));
				args.postToolInvocationBegin?.({
					type: 'chatToolInvocationBegin',
					invocationId,
					toolName: name,
					inputPreview
				});
				args.postToolTrace?.(`→ ${name}(${inputPreview})`);
				const startedAt = Date.now();
				let resultText = '';
				let ok = true;
				try {
					resultText = await executeToolCall(name, parsedArgs, {
						abortSignal: args.abortSignal,
						requestEditsApproval: args.requestEditsApproval,
						postEditsReview: args.postEditsReview,
						runSubagent,
						mcpManager: args.mcpManager,
						commandTools: args.commandTools,
						policy: args.policy
					});
				} catch (err) {
					ok = false;
					resultText = JSON.stringify({ error: true, ...serializeUnknownError(err) }, null, 2);
				}
				const durationMs = Date.now() - startedAt;
				const outputPreview = safeOneLine(resultText, 800);
				args.postToolInvocationEnd?.({
					type: 'chatToolInvocationEnd',
					invocationId,
					toolName: name,
					ok,
					outputPreview,
					outputFull: truncateForWebview(resultText),
					durationMs
				});
				args.postToolTrace?.(`← ${name}: ${outputPreview}`);

				if (name === 'manage_todo_list') {
					try {
						const parsed = JSON.parse(resultText);
						const todoList = Array.isArray(parsed?.todoList) ? parsed.todoList : [];
						const note = typeof parsed?.note === 'string' ? parsed.note : undefined;
						if (todoList.length) {
							args.postTodoList?.({ type: 'chatTodoList', todoList, note });
						}
					} catch {
						// ignore
					}
				}

				args.conversation.push({ role: 'tool', tool_call_id: call.id, content: resultText });
			}
		} finally {
			try {
				args.abortSignal.removeEventListener('abort', onAbort);
			} catch {
				// ignore
			}
			d1.dispose();
		}
	}

	throw new Error(`Tool loop exceeded max iterations (${args.maxIterations}).`);
}

function getToolDefinitions() {
	const defs = [
		// --- Copilot-aligned built-in tool names (Tripilot compatibility layer) ---
		{
			type: 'function',
			function: {
				name: 'manage_todo_list',
				description: 'Update the structured todo list for progress tracking (best-effort).',
				parameters: {
					type: 'object',
					properties: {
						todoList: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'number' },
									title: { type: 'string' },
									description: { type: 'string' },
									status: { type: 'string', description: 'not-started | in-progress | completed' }
								},
								required: ['id', 'title', 'description', 'status']
							}
						}
					},
					required: ['todoList']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'read_file',
				description:
					'Read the contents of a file. Line numbers are 1-indexed. This tool truncates output at 2000 lines; call again with offset/limit to read larger files in chunks.',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path.' },
						startLine: { type: 'number', description: 'V1: 1-based start line (optional; use with endLine).' },
						endLine: { type: 'number', description: 'V1: 1-based end line (optional; use with startLine).' },
						offset: {
							type: 'number',
							description:
								'V2: Optional 1-based line offset to start reading from. Prefer using offset/limit when reading large files.'
						},
						limit: {
							type: 'number',
							description:
								'V2: Optional maximum number of lines to read (capped so the total output is at most ~2000 lines). Use together with offset.'
						}
					},
					required: ['filePath']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'readFile',
				description:
					'Read the contents of a file. Line numbers are 1-indexed. This tool truncates output at 2000 lines; call again with offset/limit to read larger files in chunks.',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path.' },
						startLine: { type: 'number', description: 'V1: 1-based start line (optional; use with endLine).' },
						endLine: { type: 'number', description: 'V1: 1-based end line (optional; use with startLine).' },
						offset: {
							type: 'number',
							description:
								'V2: Optional 1-based line offset to start reading from. Prefer using offset/limit when reading large files.'
						},
						limit: {
							type: 'number',
							description:
								'V2: Optional maximum number of lines to read (capped so the total output is at most ~2000 lines). Use together with offset.'
						}
					},
					required: ['filePath']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'file_search',
				description: 'Search for files in the workspace by glob pattern (Copilot-compatible).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Glob pattern like **/*.{js,ts}.' },
						maxResults: { type: 'number', description: 'Max results (optional).' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'fileSearch',
				description: 'Search for files in the workspace by glob pattern (Copilot-compatible).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Glob pattern like **/*.{js,ts}.' },
						maxResults: { type: 'number', description: 'Max results (optional).' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'grep_search',
				description: 'Text search in workspace files (string or regex).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Search string or regex.' },
						isRegexp: { type: 'boolean', description: 'Whether query is regex.' },
						includePattern: { type: 'string', description: 'Glob include pattern (optional).' },
						maxResults: { type: 'number', description: 'Max results (optional).' },
						includeIgnoredFiles: { type: 'boolean', description: 'Include ignored files (optional).' }
					},
					required: ['query', 'isRegexp']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'textSearch',
				description: 'Text search in workspace files (string or regex).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Search string or regex.' },
						isRegexp: { type: 'boolean', description: 'Whether query is regex.' },
						includePattern: { type: 'string', description: 'Glob include pattern (optional).' },
						maxResults: { type: 'number', description: 'Max results (optional).' },
						includeIgnoredFiles: { type: 'boolean', description: 'Include ignored files (optional).' }
					},
					required: ['query', 'isRegexp']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'list_dir',
				description: 'List children of a directory (files and folders).',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Absolute path or workspace-relative path.' }
					},
					required: ['path']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'listDirectory',
				description: 'List children of a directory (files and folders).',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Absolute path or workspace-relative path.' }
					},
					required: ['path']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'create_directory',
				description: 'Create a directory (mkdir -p).',
				parameters: {
					type: 'object',
					properties: {
						dirPath: { type: 'string', description: 'Absolute path or workspace-relative path.' }
					},
					required: ['dirPath']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'createDirectory',
				description: 'Create a directory (mkdir -p).',
				parameters: {
					type: 'object',
					properties: {
						dirPath: { type: 'string', description: 'Absolute path or workspace-relative path.' }
					},
					required: ['dirPath']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'create_file',
				description: 'Create a new file with content (fails if exists, unless overwrite=true).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path.' },
						content: { type: 'string', description: 'File content.' },
						overwrite: { type: 'boolean', description: 'If true, overwrite existing file.', default: false }
					},
					required: ['filePath', 'content']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'createFile',
				description: 'Create a new file with content (fails if exists, unless overwrite=true).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path.' },
						content: { type: 'string', description: 'File content.' },
						overwrite: { type: 'boolean', description: 'If true, overwrite existing file.', default: false }
					},
					required: ['filePath', 'content']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'apply_patch',
				description: 'Apply a patch in the "*** Begin Patch" format to workspace files (with approval).',
				parameters: {
					type: 'object',
					properties: {
						input: { type: 'string', description: 'Patch text (preferred field name).' },
						patch: { type: 'string', description: 'Patch text (alias of input).' },
						diff: { type: 'string', description: 'Unified diff text (alias of input).' },
						edits: {
							type: 'array',
							description:
								'Optional: replace-string edits (Copilot-style). Use when patches are too fragile. Each edit replaces one exact snippet with another.',
							items: {
								type: 'object',
								properties: {
									filePath: { type: 'string', description: 'Absolute path or workspace-relative path.' },
									oldString: { type: 'string', description: 'Exact snippet to replace (must match uniquely).' },
									newString: { type: 'string', description: 'Replacement snippet.' },
									expected_replacements: {
										type: 'number',
										description:
											'Optional: expected number of replacements (usually 1). If provided and the match count differs, the tool errors.'
									}
								},
								required: ['filePath', 'oldString', 'newString']
							}
						},
						explanation: { type: 'string', description: 'Human-readable intent (optional).' }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'editFiles',
				description: 'Apply a patch in the "*** Begin Patch" format to workspace files (with approval).',
				parameters: {
					type: 'object',
					properties: {
						input: { type: 'string', description: 'Patch text (preferred field name).' },
						patch: { type: 'string', description: 'Patch text (alias of input).' },
						diff: { type: 'string', description: 'Unified diff text (alias of input).' },
						edits: {
							type: 'array',
							description:
								'Optional: replace-string edits (Copilot-style). Use when patches are too fragile. Each edit replaces one exact snippet with another.',
							items: {
								type: 'object',
								properties: {
									filePath: { type: 'string', description: 'Absolute path or workspace-relative path.' },
									oldString: { type: 'string', description: 'Exact snippet to replace (must match uniquely).' },
									newString: { type: 'string', description: 'Replacement snippet.' },
									expected_replacements: {
										type: 'number',
										description:
											'Optional: expected number of replacements (usually 1). If provided and the match count differs, the tool errors.'
									}
								},
								required: ['filePath', 'oldString', 'newString']
							}
						},
						explanation: { type: 'string', description: 'Human-readable intent (optional).' }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'edit_files',
				description: 'Alias for apply_patch (reference-aligned name; expects the same {input, explanation}).',
				parameters: {
					type: 'object',
					properties: {
						input: { type: 'string', description: 'Patch text (preferred field name).' },
						patch: { type: 'string', description: 'Patch text (alias of input).' },
						diff: { type: 'string', description: 'Unified diff text (alias of input).' },
						edits: {
							type: 'array',
							description:
								'Optional: replace-string edits (Copilot-style). Use when patches are too fragile. Each edit replaces one exact snippet with another.',
							items: {
								type: 'object',
								properties: {
									filePath: { type: 'string', description: 'Absolute path or workspace-relative path.' },
									oldString: { type: 'string', description: 'Exact snippet to replace (must match uniquely).' },
									newString: { type: 'string', description: 'Replacement snippet.' },
									expected_replacements: {
										type: 'number',
										description:
											'Optional: expected number of replacements (usually 1). If provided and the match count differs, the tool errors.'
									}
								},
								required: ['filePath', 'oldString', 'newString']
							}
						},
						explanation: { type: 'string', description: 'Human-readable intent (optional).' }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'get_errors',
				description: 'List diagnostics (problems) for given files or whole workspace.',
				parameters: {
					type: 'object',
					properties: {
						filePaths: { type: 'array', items: { type: 'string' }, description: 'Absolute or workspace-relative file paths.' }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'problems',
				description: 'List diagnostics (problems) for given files or whole workspace.',
				parameters: {
					type: 'object',
					properties: {
						filePaths: { type: 'array', items: { type: 'string' }, description: 'Absolute or workspace-relative file paths.' }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'get_changed_files',
				description: 'List git changed files (staged/unstaged).',
				parameters: {
					type: 'object',
					properties: {
						repositoryPath: { type: 'string', description: 'Repository root (optional).' },
						sourceControlState: {
							type: 'array',
							items: { type: 'string', enum: ['staged', 'unstaged', 'merge-conflicts'] },
							description: 'Filter by git state (optional).'
						}
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'changes',
				description: 'List git changed files (staged/unstaged).',
				parameters: {
					type: 'object',
					properties: {
						repositoryPath: { type: 'string', description: 'Repository root (optional).' },
						sourceControlState: {
							type: 'array',
							items: { type: 'string', enum: ['staged', 'unstaged', 'merge-conflicts'] },
							description: 'Filter by git state (optional).'
						}
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'run_in_terminal',
				description: 'Run a shell command (captured) with optional background execution.',
				parameters: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'Shell command to run.' },
						explanation: { type: 'string', description: 'One-sentence purpose shown to user.' },
						isBackground: { type: 'boolean', description: 'Run in background if true.' }
					},
					required: ['command', 'explanation', 'isBackground']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'runInTerminal',
				description: 'Alias for run_in_terminal (reference tool name).',
				parameters: {
					type: 'object',
					properties: {
						command: { type: 'string' },
						explanation: { type: 'string' },
						isBackground: { type: 'boolean' }
					},
					required: ['command', 'explanation', 'isBackground']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'get_terminal_output',
				description: 'Get output of a previous run_in_terminal command by id.',
				parameters: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Terminal run id.' }
					},
					required: ['id']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'getTerminalOutput',
				description: 'Alias for get_terminal_output (reference tool name).',
				parameters: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Terminal run id.' }
					},
					required: ['id']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'terminal_last_command',
				description: 'Get the last command run via run_in_terminal (best-effort).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'terminalLastCommand',
				description: 'Get the last command run via run_in_terminal (best-effort).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'terminal_selection',
				description: 'Get the current selection in the active terminal (not available; returns empty).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'terminalSelection',
				description: 'Get the current selection in the active terminal (not available; returns empty).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'get_search_view_results',
				description: 'Return the last search results produced by grep_search/file_search (best-effort).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'searchResults',
				description: 'Return the last search results produced by grep_search/file_search (best-effort).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'create_and_run_task',
				description: 'Create and run a task (best-effort, output captured by Tripilot).',
				parameters: {
					type: 'object',
					properties: {
						workspaceFolder: { type: 'string', description: 'Workspace folder path (absolute or relative).' },
						task: {
							type: 'object',
							properties: {
								label: { type: 'string' },
								type: { type: 'string', enum: ['shell'] },
								command: { type: 'string' },
								args: { type: 'array', items: { type: 'string' } },
								isBackground: { type: 'boolean' }
							},
							required: ['label', 'type', 'command']
						}
					},
					required: ['workspaceFolder', 'task']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'createAndRunTask',
				description: 'Create and run a task (best-effort, output captured by Tripilot).',
				parameters: {
					type: 'object',
					properties: {
						workspaceFolder: { type: 'string', description: 'Workspace folder path (absolute or relative).' },
						task: {
							type: 'object',
							properties: {
								label: { type: 'string' },
								type: { type: 'string', enum: ['shell'] },
								command: { type: 'string' },
								args: { type: 'array', items: { type: 'string' } },
								isBackground: { type: 'boolean' }
							},
							required: ['label', 'type', 'command']
						}
					},
					required: ['workspaceFolder', 'task']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'run_task',
				description: 'Run an existing task by id/label (best-effort).',
				parameters: {
					type: 'object',
					properties: {
						workspaceFolder: { type: 'string' },
						id: { type: 'string' }
					},
					required: ['workspaceFolder', 'id']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'runTask',
				description: 'Alias for run_task (reference tool name).',
				parameters: {
					type: 'object',
					properties: {
						workspaceFolder: { type: 'string' },
						id: { type: 'string' }
					},
					required: ['workspaceFolder', 'id']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'get_task_output',
				description: 'Get captured output for a previously started task.',
				parameters: {
					type: 'object',
					properties: {
						workspaceFolder: { type: 'string' },
						id: { type: 'string' }
					},
					required: ['workspaceFolder', 'id']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'getTaskOutput',
				description: 'Alias for get_task_output (reference tool name).',
				parameters: {
					type: 'object',
					properties: {
						workspaceFolder: { type: 'string' },
						id: { type: 'string' }
					},
					required: ['workspaceFolder', 'id']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'run_tests',
				description: 'Run workspace tests (best-effort: npm test).',
				parameters: {
					type: 'object',
					properties: {
						scope: { type: 'string', description: 'Test scope (optional).' },
						coverage: { type: 'boolean', description: 'Generate coverage if supported (optional).', default: false }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'runTests',
				description: 'Alias for run_tests (reference tool name).',
				parameters: {
					type: 'object',
					properties: {
						scope: { type: 'string' },
						coverage: { type: 'boolean', default: false }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'test_failure',
				description: 'Return details from the most recent failed run_tests (best-effort).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'testFailure',
				description: 'Alias for test_failure (reference tool name).',
				parameters: { type: 'object', properties: {} }
			}
		},
		{
			type: 'function',
			function: {
				name: 'copilot_getNotebookSummary',
				description:
					'Get a summary of all cells in a Jupyter notebook (.ipynb): cellId, kind, language, line ranges, execution info and output mime types.',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' }
					},
					required: ['filePath']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'getNotebookSummary',
				description:
					'Get a summary of all cells in a Jupyter notebook (.ipynb): cellId, kind, language, line ranges, execution info and output mime types.',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' }
					},
					required: ['filePath']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'run_notebook_cell',
				description: 'Execute a code cell in a Jupyter notebook (best-effort).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' },
						cellId: { type: 'string', description: 'Cell id (from copilot_getNotebookSummary).' },
						reason: { type: 'string', description: 'Why the cell is being run (optional).' },
						continueOnError: { type: 'boolean', description: 'Whether to continue if error encountered (unused for single-cell).', default: false }
					},
					required: ['filePath', 'cellId']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'runNotebookCell',
				description: 'Execute a code cell in a Jupyter notebook (best-effort).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' },
						cellId: { type: 'string', description: 'Cell id (from getNotebookSummary).' },
						reason: { type: 'string', description: 'Why the cell is being run (optional).' },
						continueOnError: { type: 'boolean', description: 'Whether to continue if error encountered (unused for single-cell).', default: false }
					},
					required: ['filePath', 'cellId']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'read_notebook_cell_output',
				description: 'Read the most recent output for a notebook cell (does not execute).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' },
						cellId: { type: 'string', description: 'Cell id (from copilot_getNotebookSummary).' }
					},
					required: ['filePath', 'cellId']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'readNotebookCellOutput',
				description: 'Read the most recent output for a notebook cell (does not execute).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' },
						cellId: { type: 'string', description: 'Cell id (from getNotebookSummary).' }
					},
					required: ['filePath', 'cellId']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'edit_notebook_file',
				description: 'Insert, delete, or edit a Jupyter notebook cell (with approval).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' },
						cellId: {
							type: 'string',
							description:
								'Cell id to edit/delete, or anchor cell id to insert after. Use TOP or BOTTOM to insert at file boundaries.'
						},
						newCode: { type: ['string', 'array'], description: 'New cell code for insert/edit.' },
						language: { type: 'string', description: 'Cell language: markdown/python/javascript/etc (optional).' },
						editType: { type: 'string', enum: ['insert', 'delete', 'edit'] }
					},
					required: ['filePath', 'cellId', 'editType']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'editNotebook',
				description: 'Insert, delete, or edit a Jupyter notebook cell (with approval).',
				parameters: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'Absolute path or workspace-relative path to a .ipynb file.' },
						cellId: {
							type: 'string',
							description:
								'Cell id to edit/delete, or anchor cell id to insert after. Use TOP or BOTTOM to insert at file boundaries.'
						},
						newCode: { type: ['string', 'array'], description: 'New cell code for insert/edit.' },
						language: { type: 'string', description: 'Cell language: markdown/python/javascript/etc (optional).' },
						editType: { type: 'string', enum: ['insert', 'delete', 'edit'] }
					},
					required: ['filePath', 'cellId', 'editType']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'create_new_jupyter_notebook',
				description: 'Generate a new Jupyter Notebook (.ipynb) file (with approval).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Natural language description of the notebook to generate.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'newJupyterNotebook',
				description: 'Generate a new Jupyter Notebook (.ipynb) file (with approval).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Natural language description of the notebook to generate.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'runSubagent',
				description:
					'Delegate a complex task to a context-isolated subagent and return only its final result (no recursion).',
				parameters: {
					type: 'object',
					properties: {
						prompt: { type: 'string', description: 'Task prompt for the subagent.' },
						description: { type: 'string', description: 'Short 3-5 word description.' }
					},
					required: ['prompt', 'description']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'agent.runSubagent',
				description: 'Alias for runSubagent.',
				parameters: {
					type: 'object',
					properties: {
						prompt: { type: 'string' },
						description: { type: 'string' }
					},
					required: ['prompt', 'description']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'fetch_webpage',
				description: 'Fetch and extract readable text content from one or more web pages (with URL approval).',
				parameters: {
					type: 'object',
					properties: {
						urls: { type: 'array', items: { type: 'string' }, description: 'URLs to fetch.' },
						query: { type: 'string', description: 'What to look for in the page(s).' }
					},
					required: ['urls', 'query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'fetch',
				description: 'Fetch and extract readable text content from one or more web pages (with URL approval).',
				parameters: {
					type: 'object',
					properties: {
						urls: { type: 'array', items: { type: 'string' }, description: 'URLs to fetch.' },
						query: { type: 'string', description: 'What to look for in the page(s).' }
					},
					required: ['urls', 'query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'github_repo',
				description: 'Search a public GitHub repo for relevant code snippets (best-effort; may require a token).',
				parameters: {
					type: 'object',
					properties: {
						repo: { type: 'string', description: "Repo in the form 'owner/repo'." },
						query: { type: 'string', description: 'Search query.' }
					},
					required: ['repo', 'query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'githubRepo',
				description: 'Search a public GitHub repo for relevant code snippets (best-effort; may require a token).',
				parameters: {
					type: 'object',
					properties: {
						repo: { type: 'string', description: "Repo in the form 'owner/repo'." },
						query: { type: 'string', description: 'Search query.' }
					},
					required: ['repo', 'query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'extensions',
				description: 'List installed VS Code extensions (id/displayName/isActive).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Optional filter (id/displayName substring).' },
						includeDisabled: { type: 'boolean', description: 'Include disabled extensions if available (best-effort).', default: true },
						maxResults: { type: 'number', description: 'Max results (optional).', default: 200 }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'install_extension',
				description: 'Install a VS Code extension by id (requires user confirmation).',
				parameters: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Extension id in the format publisher.name.' },
						name: { type: 'string', description: 'Human-readable extension name.' }
					},
					required: ['id', 'name']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'installExtension',
				description: 'Install a VS Code extension by id (requires user confirmation).',
				parameters: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Extension id in the format publisher.name.' },
						name: { type: 'string', description: 'Human-readable extension name.' }
					},
					required: ['id', 'name']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'vscode_searchExtensions_internal',
				description: 'Search for VS Code extensions (best-effort; may open Extensions UI).',
				parameters: {
					type: 'object',
					properties: {
						category: { type: 'string', description: 'Optional category.' },
						keywords: { type: 'array', items: { type: 'string' }, description: 'Search keywords.' },
						ids: { type: 'array', items: { type: 'string' }, description: 'Known extension ids to look up.' }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'open_simple_browser',
				description: 'Open a URL in VS Code Simple Browser (or external browser fallback).',
				parameters: {
					type: 'object',
					properties: {
						url: { type: 'string', description: 'http(s) URL.' }
					},
					required: ['url']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'openSimpleBrowser',
				description: 'Open a URL in VS Code Simple Browser (or external browser fallback).',
				parameters: {
					type: 'object',
					properties: {
						url: { type: 'string', description: 'http(s) URL.' }
					},
					required: ['url']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'run_vscode_command',
				description: 'Run a VS Code command (best-effort; subject to allowlist in ask&study).',
				parameters: {
					type: 'object',
					properties: {
						commandId: { type: 'string', description: 'Command id.' },
						name: { type: 'string', description: 'Human-readable description.' },
						args: { type: 'array', items: { type: 'string' }, description: 'Optional args array.' }
					},
					required: ['commandId', 'name']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'runCommand',
				description: 'Run a VS Code command (best-effort; subject to allowlist in ask&study).',
				parameters: {
					type: 'object',
					properties: {
						commandId: { type: 'string', description: 'Command id.' },
						name: { type: 'string', description: 'Human-readable description.' },
						args: { type: 'array', items: { type: 'string' }, description: 'Optional args array.' }
					},
					required: ['commandId', 'name']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'run_command',
				description: 'Alias for run_vscode_command (reference-aligned name).',
				parameters: {
					type: 'object',
					properties: {
						commandId: { type: 'string', description: 'Command id.' },
						args: { type: 'array', items: { type: 'string' }, description: 'Optional args array.' }
					},
					required: ['commandId']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'create_new_workspace',
				description: 'Scaffold a new workspace/project under the current workspace (with approval).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Description of the workspace to generate.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'newWorkspace',
				description: 'Scaffold a new workspace/project under the current workspace (with approval).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Description of the workspace to generate.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'new_workspace',
				description: 'Create a new workspace/project (reference-aligned shape; best-effort).',
				parameters: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'Project/workspace name.' },
						directory: { type: 'string', description: 'Workspace-relative directory hint.' },
						template: { type: 'string', description: 'Template name (e.g. vite, next-js, python-project).' },
						openInNewWindow: { type: 'boolean', description: 'Whether to open in a new window (best-effort).' }
					},
					required: ['name']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'get_project_setup_info',
				description: 'Get setup/build/run/test guidance for a project type (best-effort).',
				parameters: {
					type: 'object',
					properties: {
						projectType: { type: 'string', description: 'python-project/python-script/next-js/vite/vscode-extension/mcp-server/other.' }
					},
					required: ['projectType']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'getProjectSetupInfo',
				description: 'Get setup/build/run/test guidance for a project type (best-effort).',
				parameters: {
					type: 'object',
					properties: {
						projectType: { type: 'string', description: 'python-project/python-script/next-js/vite/vscode-extension/mcp-server/other.' }
					},
					required: ['projectType']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'get_vscode_api',
				description: 'Search VS Code API docs/types for guidance (offline best-effort).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Question or API name to search for.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'vscodeAPI',
				description: 'Search VS Code API docs/types for guidance (offline best-effort).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Question or API name to search for.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'vscode_api',
				description: 'Alias for get_vscode_api (reference-aligned name).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Question or API name to search for.' },
						version: { type: 'string', description: 'Optional version hint.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'list_code_usages',
				description: 'List usages/references of a symbol name in the workspace (best-effort text search).',
				parameters: {
					type: 'object',
					properties: {
						symbolName: { type: 'string', description: 'Symbol to search for.' },
						filePaths: { type: 'array', items: { type: 'string' }, description: 'Optional hint files (workspace-relative).' }
					},
					required: ['symbolName']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'usages',
				description: 'List usages/references of a symbol name in the workspace (best-effort text search).',
				parameters: {
					type: 'object',
					properties: {
						symbolName: { type: 'string', description: 'Symbol to search for.' },
						filePaths: { type: 'array', items: { type: 'string' }, description: 'Optional hint files (workspace-relative).' }
					},
					required: ['symbolName']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'semantic_search',
				description: 'Semantic-ish search over the codebase (best-effort keyword search).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Natural language query.' }
					},
					required: ['query']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'codebase',
				description: 'Semantic-ish search over the codebase (best-effort keyword search).',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Natural language query.' }
					},
					required: ['query']
				}
			}
		},

		{
			type: 'function',
			function: {
				name: 'editor_getActiveDocument',
				description: 'Get info about the active editor document and (optionally) its text.',
				parameters: {
					type: 'object',
					properties: {
						includeText: { type: 'boolean', description: 'If true, include the document text (may be truncated).' },
						maxChars: { type: 'number', description: 'Max chars to return when includeText=true.', default: 20000 },
						startLine: { type: 'number', description: '1-based start line (optional).' },
						endLine: { type: 'number', description: '1-based end line (optional).' }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'editor_getSelection',
				description: 'Get the current selection text in the active editor.',
				parameters: {
					type: 'object',
					properties: {
						maxChars: { type: 'number', description: 'Max chars to return.', default: 20000 }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'workspace_listFiles',
				description: 'List files under a workspace-relative directory (non-recursive by default).',
				parameters: {
					type: 'object',
					properties: {
						relativeDir: { type: 'string', description: 'Workspace-relative directory path.' },
						recursive: { type: 'boolean', description: 'If true, list recursively.' }
					},
					required: ['relativeDir']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'workspace_readFile',
				description: 'Read a UTF-8 text file by workspace-relative path.',
				parameters: {
					type: 'object',
					properties: {
						relativePath: { type: 'string' }
					},
					required: ['relativePath']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'workspace_writeFile',
				description: 'Write a UTF-8 text file by workspace-relative path (creates folders as needed).',
				parameters: {
					type: 'object',
					properties: {
						relativePath: { type: 'string' },
						content: { type: 'string' }
					},
					required: ['relativePath', 'content']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'workspace_findInFiles',
				description: 'Search text in workspace files, returning matched lines and ranges (limited).',
				parameters: {
					type: 'object',
					properties: {
						pattern: { type: 'string', description: 'Search pattern.' },
						isRegExp: { type: 'boolean', default: false },
						isCaseSensitive: { type: 'boolean', default: false },
						isWordMatch: { type: 'boolean', default: false },
						include: { type: 'string', description: 'Glob include, e.g. **/*.ts' },
						exclude: { type: 'string', description: 'Glob exclude, e.g. **/node_modules/**' },
						maxResults: { type: 'number', default: 50 }
					},
					required: ['pattern']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'workspace_applyEdits',
				description: 'Apply text edits to workspace files using WorkspaceEdit. Lines/chars are 1-based.',
				parameters: {
					type: 'object',
					properties: {
						edits: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									relativePath: { type: 'string' },
									startLine: { type: 'number', description: '1-based.' },
									startCharacter: { type: 'number', description: '1-based.' },
									endLine: { type: 'number', description: '1-based.' },
									endCharacter: { type: 'number', description: '1-based.' },
									newText: { type: 'string' }
								},
								required: ['relativePath', 'startLine', 'startCharacter', 'endLine', 'endCharacter', 'newText']
							}
						}
					},
					required: ['edits']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'diagnostics_list',
				description: 'List VS Code diagnostics (problems) for a file or whole workspace (limited).',
				parameters: {
					type: 'object',
					properties: {
						relativePath: { type: 'string', description: 'Optional workspace-relative file path.' },
						maxItems: { type: 'number', default: 200 }
					}
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'vscode_executeCommand',
				description: 'Execute a VS Code command by id.',
				parameters: {
					type: 'object',
					properties: {
						command: { type: 'string' },
						args: { type: 'array', items: {} }
					},
					required: ['command']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'terminal_run',
				description: 'Run a shell command in a VS Code terminal and return captured output (best-effort).',
				parameters: {
					type: 'object',
					properties: {
						command: { type: 'string' },
						shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: 'Preferred shell.' }
					},
					required: ['command']
				}
			}
		}
		,
		{
			type: 'function',
			function: {
				name: 'process_run',
				description: 'Run a process (non-interactive) and capture stdout/stderr. Prefer this when you need output.',
				parameters: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'Executable name or path.' },
						args: { type: 'array', items: { type: 'string' }, description: 'Arguments array.' },
						cwd: { type: 'string', description: 'Workspace-relative working directory (optional).' },
						timeoutMs: { type: 'number', default: 60000 },
						maxOutputChars: { type: 'number', default: 60000 }
					},
					required: ['command']
				}
			}
		}
	];

	// Expose only the Copilot-style tool surface (no extra internal tools).
	const ALIAS_FROM_COPILOT_NAME: Record<string, string> = {
		// todo
		manage_todo_list: 'manage_todo_list',
		// read
		readFile: 'read_file',
		problems: 'get_errors',
		terminalLastCommand: 'terminal_last_command',
		terminalSelection: 'terminal_selection',
		getNotebookSummary: 'copilot_getNotebookSummary',
		readNotebookCellOutput: 'read_notebook_cell_output',
		getTaskOutput: 'get_task_output',
		// search
		fileSearch: 'file_search',
		textSearch: 'grep_search',
		listDirectory: 'list_dir',
		searchResults: 'get_search_view_results',
		codebase: 'semantic_search',
		usages: 'list_code_usages',
		changes: 'get_changed_files',
		// edit
		createDirectory: 'create_directory',
		createFile: 'create_file',
		editFiles: 'apply_patch',
		editNotebook: 'edit_notebook_file',
		newJupyterNotebook: 'create_new_jupyter_notebook',
		// execute
		runInTerminal: 'run_in_terminal',
		getTerminalOutput: 'get_terminal_output',
		createAndRunTask: 'create_and_run_task',
		runTask: 'run_task',
		runTests: 'run_tests',
		testFailure: 'test_failure',
		runNotebookCell: 'run_notebook_cell',
		// agent
		runSubagent: 'runSubagent',
		// vscode
		extensions: 'extensions',
		installExtension: 'install_extension',
		openSimpleBrowser: 'open_simple_browser',
		runCommand: 'run_vscode_command',
		newWorkspace: 'create_new_workspace',
		getProjectSetupInfo: 'get_project_setup_info',
		vscodeAPI: 'get_vscode_api',
		// web
		fetch: 'fetch_webpage',
		githubRepo: 'github_repo'
	};

	const byName = new Map<string, any>();
	for (const d of defs) byName.set(String(d?.function?.name ?? ''), d);

	const out: any[] = [];
	for (const copilotName of OPTIONAL_TOOL_NAMES) {
		const baseName = ALIAS_FROM_COPILOT_NAME[copilotName] ?? copilotName;
		const base = byName.get(baseName);
		if (!base) continue;
		if (baseName === copilotName) {
			out.push(base);
			continue;
		}
		out.push({
			...base,
			function: {
				...base.function,
				name: copilotName,
				description: `Copilot name alias for ${baseName}. ${String(base.function?.description ?? '')}`.trim()
			}
		});
	}

	return out;
}

// --- Copilot-aligned tool state (best-effort) ---
type CapturedRun = {
	id: string;
	command: string;
	explanation: string;
	isBackground: boolean;
	startedAt: number;
	pid?: number;
	stdout: string;
	stderr: string;
	exitCode?: number | null;
	done: boolean;
};

const CAPTURED_RUNS = new Map<string, CapturedRun>();
type CapturedTask = CapturedRun & { label: string; workspaceFolder: string; commandExe: string; args: string[] };
const CAPTURED_TASKS = new Map<string, CapturedTask>();
const TASK_DEFS = new Map<string, { workspaceFolder: string; label: string; command: string; args: string[]; isBackground: boolean }>();
let LAST_TERMINAL_COMMAND: string | undefined;
let LAST_SEARCH_RESULTS: any | undefined;
let LAST_TEST_FAILURE: string | undefined;
let LAST_TODO_LIST: unknown[] | undefined;

function isProbablyAbsolutePath(p: string): boolean {
	const s = String(p ?? '');
	// Windows drive path, UNC, or POSIX root.
	return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/');
}

function resolveAnyPathToUri(p: string): vscode.Uri {
	const raw = String(p ?? '').trim();
	if (!raw) throw new Error('Path is required.');
	if (isProbablyAbsolutePath(raw)) {
		return vscode.Uri.file(raw);
	}
	// Treat as workspace-relative.
	const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '');
	return resolveWorkspaceUri(rel);
}

function toWorkspaceRelativePosix(uri: vscode.Uri): string {
	const rel = vscode.workspace.asRelativePath(uri, false);
	return String(rel ?? '').replace(/\\/g, '/');
}

function normalizeNewlinesToLf(text: string): string {
	return String(text ?? '').replace(/\r\n/g, '\n');
}

function escapeRegExp(s: string): string {
	return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSafeHttpUrl(url: string): boolean {
	try {
		const u = new URL(String(url));
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
		return true;
	} catch {
		return false;
	}
}

async function fetchUrlText(url: string, timeoutMs = 20000): Promise<{ finalUrl: string; status: number; contentType?: string; text: string }> {
	const target = String(url ?? '').trim();
	if (!isSafeHttpUrl(target)) throw new Error(`Invalid URL: ${target}`);

	// Prefer global fetch when available (Node 18+), otherwise fall back to http(s).
	const anyFetch = (globalThis as any).fetch as undefined | ((...args: any[]) => Promise<any>);
	if (typeof anyFetch === 'function') {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const res = await anyFetch(target, {
				redirect: 'follow',
				signal: ac.signal,
				headers: {
					'User-Agent': 'Tripilot/0.0.1 (+https://github.com/)'
				}
			});
			const text = await res.text();
			return {
				finalUrl: String(res.url ?? target),
				status: Number(res.status ?? 0),
				contentType: String(res.headers?.get?.('content-type') ?? ''),
				text
			};
		} finally {
			clearTimeout(t);
		}
	}

	return await new Promise((resolve, reject) => {
		try {
			const u = new URL(target);
			const lib = u.protocol === 'https:' ? https : http;
			const req = lib.request(
				{
					method: 'GET',
					host: u.hostname,
					path: u.pathname + u.search,
					port: u.port ? Number(u.port) : undefined,
					headers: { 'User-Agent': 'Tripilot/0.0.1' }
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						resolve({
							finalUrl: target,
							status: Number(res.statusCode ?? 0),
							contentType: String(res.headers?.['content-type'] ?? ''),
							text
						});
					});
				}
			);
			req.on('error', reject);
			req.setTimeout(timeoutMs, () => {
				req.destroy(new Error('Request timeout'));
			});
			req.end();
		} catch (e) {
			reject(e);
		}
	});
}

function extractReadableTextFromHtml(html: string): string {
	let s = String(html ?? '');
	// Remove scripts/styles.
	s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
	s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
	// Remove tags.
	s = s.replace(/<[^>]+>/g, ' ');
	// Basic entity decode.
	s = s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
	// Collapse whitespace.
	s = s.replace(/\s+/g, ' ').trim();
	return s;
}

function pickRelevantText(fullText: string, query: string, maxChars = 20000): string {
	const text = String(fullText ?? '');
	const q = String(query ?? '').trim();
	if (!q) return truncate(text, maxChars);
	const tokens = q
		.toLowerCase()
		.split(/[^a-z0-9\u4e00-\u9fff]+/)
		.filter((t) => t.length >= 3)
		.slice(0, 10);
	if (!tokens.length) return truncate(text, maxChars);

	// Prefer sentences containing any token.
	const sentences = text.split(/(?<=[.!?。！？])\s+/);
	const picked: string[] = [];
	for (const s of sentences) {
		const low = s.toLowerCase();
		if (tokens.some((t) => low.includes(t))) {
			picked.push(s.trim());
			if (picked.join(' ').length >= maxChars) break;
		}
	}
	const out = picked.length ? picked.join(' ') : text;
	return truncate(out, maxChars);
}

function slugifyFileBase(input: string): string {
	const raw = String(input ?? '').trim().toLowerCase();
	const s = raw
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
		.replace(/^-+/, '')
		.replace(/-+$/, '');
	return s || 'notebook';
}

function resolveNotebookCellIdToIndex(cellId: string, cells: readonly vscode.NotebookCell[]): number {
	const raw = String(cellId ?? '').trim();
	if (!raw) throw new Error('cellId is required.');
	const cellCount = cells.length;

	// Preferred legacy format: cell-<index>
	const m = /^cell-(\d+)$/.exec(raw);
	if (m) {
		const idx = Number(m[1]);
		if (!Number.isFinite(idx) || idx < 0 || idx >= cellCount) throw new Error('cellId out of range.');
		return idx;
	}
	// Accept numeric string as index.
	if (/^\d+$/.test(raw)) {
		const idx = Number(raw);
		if (!Number.isFinite(idx) || idx < 0 || idx >= cellCount) throw new Error('cellId out of range.');
		return idx;
	}

	// Accept a notebook cell document URI string (stable-ish across edits).
	const uriMatchIndex = cells.findIndex((c) => String(c.document?.uri?.toString() ?? '') === raw);
	if (uriMatchIndex >= 0) return uriMatchIndex;

	// Accept our own metadata id: tripilot:<uuid>
	const tripilotPrefix = 'tripilot:';
	if (raw.startsWith(tripilotPrefix)) {
		const wanted = raw.slice(tripilotPrefix.length);
		const idx = cells.findIndex((c) => {
			const md = (c as any)?.metadata;
			return md && typeof md === 'object' && String((md as any).tripilotCellId ?? '') === wanted;
		});
		if (idx >= 0) return idx;
	}

	throw new Error(`Unknown cellId format: ${raw}`);
}

function normalizeNotebookNewCode(newCode: unknown): string {
	if (Array.isArray(newCode)) return newCode.map((x) => String(x ?? '')).join('');
	return String(newCode ?? '');
}

function notebookOutputsToStructured(
	outputs: readonly vscode.NotebookCellOutput[],
	maxCharsPerItem = 20000
): {
	text: string;
	mimeTypes: string[];
	outputs: Array<{
		items: Array<{ mime: string; byteLength: number; textPreview?: string }>;
	}>;
} {
	const mimeTypes = new Set<string>();
	const textParts: string[] = [];
	const structured: Array<{ items: Array<{ mime: string; byteLength: number; textPreview?: string }> }> = [];

	for (const o of outputs ?? []) {
		const outItems: Array<{ mime: string; byteLength: number; textPreview?: string }> = [];
		for (const item of o.items ?? []) {
			const mime = String((item as any)?.mime ?? '');
			if (mime) mimeTypes.add(mime);
			let byteLength = 0;
			let textPreview: string | undefined;
			try {
				const data = (item as any)?.data as Uint8Array | undefined;
				byteLength = data?.byteLength ?? 0;
				const isTextish =
					mime.startsWith('text/') ||
					mime === 'application/vnd.code.notebook.stdout' ||
					mime === 'application/vnd.code.notebook.stderr' ||
					mime === 'application/json' ||
					mime === 'application/javascript';
				if (isTextish && data && data.byteLength) {
					textPreview = Buffer.from(data).toString('utf8');
					if (textPreview.length > maxCharsPerItem) {
						textPreview = textPreview.slice(0, maxCharsPerItem) + '\n…(truncated)';
					}
					textParts.push(textPreview);
				}
			} catch {
				// ignore
			}
			outItems.push({ mime, byteLength, ...(textPreview ? { textPreview } : {}) });
		}
		structured.push({ items: outItems });
	}

	return {
		text: textParts.join('\n').trim(),
		mimeTypes: Array.from(mimeTypes.values()).sort((a, b) => a.localeCompare(b)),
		outputs: structured
	};
}

type PatchAction =
	| { kind: 'add'; filePath: string; content: string }
	| { kind: 'delete'; filePath: string }
	| { kind: 'update'; filePath: string; hunks: Array<{ before: string; after: string }> };

function parseTripilotPatch(input: string): PatchAction[] {
	const text = String(input ?? '');
	// Be tolerant: some models omit the end marker. If Begin exists, treat EOF as End.
	if (!text.includes('*** Begin Patch')) {
		throw new Error('Patch must include "*** Begin Patch" marker.');
	}
	const normalized = text.includes('*** End Patch') ? text : text + '\n*** End Patch';
	const lines = normalized.split(/\r?\n/);
	const actions: PatchAction[] = [];
	let i = 0;
	const takePath = (line: string) => line.split(':').slice(1).join(':').trim();

	while (i < lines.length) {
		const line = lines[i];
		if (line.startsWith('*** Add File:')) {
			const filePath = takePath(line);
			i++;
			const body: string[] = [];
			while (i < lines.length && !lines[i].startsWith('*** ')) {
				body.push(lines[i]);
				i++;
			}
			const content = body
				.filter((l) => l !== '\\ No newline at end of file')
				.map((l) => (l.startsWith('+') ? l.slice(1) : l))
				.join('\n');
			actions.push({ kind: 'add', filePath, content });
			continue;
		}
		if (line.startsWith('*** Delete File:')) {
			const filePath = takePath(line);
			actions.push({ kind: 'delete', filePath });
			i++;
			continue;
		}
		if (line.startsWith('*** Update File:')) {
			const filePath = takePath(line);
			i++;
			const hunks: Array<{ before: string; after: string }> = [];
			let hunkLines: string[] = [];
			const flush = () => {
				if (!hunkLines.length) return;
				const beforeLines: string[] = [];
				const afterLines: string[] = [];
				for (const hl of hunkLines) {
					if (!hl) {
						beforeLines.push('');
						afterLines.push('');
						continue;
					}
					if (hl.startsWith('@@')) {
						// context marker, ignore
						continue;
					}
					if (hl.startsWith('-')) {
						beforeLines.push(hl.slice(1));
						continue;
					}
					if (hl.startsWith('+')) {
						afterLines.push(hl.slice(1));
						continue;
					}
					// context line
					beforeLines.push(hl);
					afterLines.push(hl);
				}
				hunks.push({ before: beforeLines.join('\n'), after: afterLines.join('\n') });
				hunkLines = [];
			};
			while (i < lines.length && !lines[i].startsWith('*** ')) {
				const l = lines[i];
				// New hunk marker: flush current block.
				if (l.startsWith('@@')) {
					flush();
					hunkLines.push(l);
					i++;
					continue;
				}
				hunkLines.push(l);
				i++;
			}
			flush();
			actions.push({ kind: 'update', filePath, hunks });
			continue;
		}
		i++;
	}

	return actions;
}

function applyHunksToText(original: string, hunks: Array<{ before: string; after: string }>): string {
	const originalLf = normalizeNewlinesToLf(original);
	const endsWithNewline = originalLf.endsWith('\n');
	let lines = originalLf.split('\n');
	if (endsWithNewline) lines = lines.slice(0, -1);

	const splitLines = (text: string) => {
		const t = normalizeNewlinesToLf(text);
		// Avoid returning [''] for empty.
		return t ? t.split('\n') : [];
	};
	const maybeUnescapeLeadingTabs = (s: string) => {
		// Some models emit literal "\\t" instead of a tab at the start of lines.
		// Keep this conservative: only fix a leading "\\t" when the string has no real tabs.
		const str = String(s ?? '');
		if (!str.includes('\t') && str.startsWith('\\t')) return '\t' + str.slice(2);
		return str;
	};
	const normalizeForCompare = (s: string, mode: 'exact' | 'trimEnd' | 'trim') => {
		const base = maybeUnescapeLeadingTabs(String(s ?? ''));
		if (mode === 'exact') return base;
		if (mode === 'trimEnd') return base.replace(/[\t\f\v \u00A0]+$/g, '');
		return base.trim();
	};
	const levenshteinWithin = (a: string, b: string, maxDistance: number) => {
		if (a === b) return 0;
		if (maxDistance <= 0) return 1;
		const al = a.length;
		const bl = b.length;
		if (Math.abs(al - bl) > maxDistance) return maxDistance + 1;
		if (al === 0) return bl;
		if (bl === 0) return al;
		// Ensure b is the shorter string for less memory.
		if (bl > al) return levenshteinWithin(b, a, maxDistance);

		let prev = new Array(bl + 1);
		let curr = new Array(bl + 1);
		for (let j = 0; j <= bl; j++) prev[j] = j;
		for (let i = 1; i <= al; i++) {
			curr[0] = i;
			let rowMin = curr[0];
			const ca = a.charCodeAt(i - 1);
			for (let j = 1; j <= bl; j++) {
				const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
				const del = prev[j] + 1;
				const ins = curr[j - 1] + 1;
				const sub = prev[j - 1] + cost;
				const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
				curr[j] = v;
				if (v < rowMin) rowMin = v;
			}
			if (rowMin > maxDistance) return maxDistance + 1;
			[prev, curr] = [curr, prev];
		}
		return prev[bl];
	};
	const findSubsequenceMatches = (haystack: string[], needle: string[], mode: 'exact' | 'trimEnd' | 'trim') => {
		const matches: number[] = [];
		if (!needle.length) return matches;
		if (needle.length > haystack.length) return matches;
		for (let i = 0; i <= haystack.length - needle.length; i++) {
			let ok = true;
			for (let j = 0; j < needle.length; j++) {
				if (normalizeForCompare(haystack[i + j], mode) !== normalizeForCompare(needle[j], mode)) {
					ok = false;
					break;
				}
			}
			if (ok) matches.push(i);
		}
		return matches;
	};
	const findFuzzyIndexByAnchors = (haystack: string[], needle: string[]) => {
		if (!needle.length) return 0;
		const nonEmptyIdx = needle
			.map((l, idx) => ({ l, idx }))
			.filter((x) => x.l.trim().length > 0);
		if (!nonEmptyIdx.length) return -1;
		const first = nonEmptyIdx[0];
		const last = nonEmptyIdx[nonEmptyIdx.length - 1];

		const candidates: number[] = [];
		for (let i = 0; i < haystack.length; i++) {
			if (normalizeForCompare(haystack[i], 'trim') === normalizeForCompare(first.l, 'trim')) candidates.push(i);
		}
		if (!candidates.length) return -1;

		let bestStart = -1;
		let bestScore = -1;
		let bestCount = 0;
		for (const p of candidates) {
			const start = p - first.idx;
			if (start < 0) continue;
			const end = start + needle.length;
			if (end > haystack.length) continue;
			// Require the last anchor to match, otherwise skip quickly.
			const lastPos = start + last.idx;
			if (lastPos < 0 || lastPos >= haystack.length) continue;
			if (normalizeForCompare(haystack[lastPos], 'trim') !== normalizeForCompare(last.l, 'trim')) continue;

			let score = 0;
			for (let j = 0; j < needle.length; j++) {
				if (normalizeForCompare(haystack[start + j], 'trimEnd') === normalizeForCompare(needle[j], 'trimEnd')) score++;
			}
			if (score > bestScore) {
				bestScore = score;
				bestStart = start;
				bestCount = 1;
			} else if (score === bestScore && score !== -1) {
				bestCount++;
			}
		}

		// Only accept high-confidence, unambiguous matches.
		const ratio = needle.length ? bestScore / needle.length : 0;
		if (bestStart >= 0 && ratio >= 0.85 && bestCount === 1) return bestStart;
		return -1;
	};
	const findEditDistanceIndexByAnchors = (haystack: string[], needle: string[]) => {
		// Conservative edit-distance matching (Copilot-style): allow small per-line drift.
		if (!needle.length) return 0;
		const nonEmptyIdx = needle
			.map((l, idx) => ({ l, idx }))
			.filter((x) => x.l.trim().length > 0);
		if (!nonEmptyIdx.length) return -1;
		const first = nonEmptyIdx[0];
		const last = nonEmptyIdx[nonEmptyIdx.length - 1];

		const candidates: number[] = [];
		for (let i = 0; i < haystack.length; i++) {
			if (normalizeForCompare(haystack[i], 'trim') === normalizeForCompare(first.l, 'trim')) candidates.push(i);
		}
		if (!candidates.length) return -1;

		const allowanceRatio = 0.34;
		let bestStart = -1;
		let bestTotalDist = Number.POSITIVE_INFINITY;
		let bestCount = 0;
		for (const p of candidates) {
			const start = p - first.idx;
			if (start < 0) continue;
			const end = start + needle.length;
			if (end > haystack.length) continue;
			const lastPos = start + last.idx;
			if (lastPos < 0 || lastPos >= haystack.length) continue;
			if (normalizeForCompare(haystack[lastPos], 'trim') !== normalizeForCompare(last.l, 'trim')) continue;

			let totalDist = 0;
			let ok = true;
			for (let j = 0; j < needle.length; j++) {
				const a = normalizeForCompare(haystack[start + j], 'trimEnd');
				const b = normalizeForCompare(needle[j], 'trimEnd');
				if (a === b) continue;
				const maxLen = Math.max(a.length, b.length);
				const allowed = Math.max(1, Math.floor(maxLen * allowanceRatio));
				const d = levenshteinWithin(a, b, allowed);
				if (d > allowed) {
					ok = false;
					break;
				}
				totalDist += d;
			}
			if (!ok) continue;
			if (totalDist < bestTotalDist) {
				bestTotalDist = totalDist;
				bestStart = start;
				bestCount = 1;
			} else if (totalDist === bestTotalDist) {
				bestCount++;
			}
		}
		if (bestStart >= 0 && bestCount === 1) return bestStart;
		return -1;
	};

	for (const h of hunks) {
		const before = normalizeNewlinesToLf(h.before);
		const after = normalizeNewlinesToLf(h.after);
		if (!before) {
			// If no before context, append after.
			const afterLines = splitLines(after);
			if (afterLines.length) lines.push(...afterLines);
			continue;
		}

		const beforeLines = splitLines(before);
		const afterLines = splitLines(after);

		let start = -1;
		for (const mode of ['exact', 'trimEnd', 'trim'] as const) {
			const matches = findSubsequenceMatches(lines, beforeLines, mode);
			if (matches.length === 1) {
				start = matches[0];
				break;
			}
			if (matches.length > 1) {
				throw new Error(
					`Patch hunk matched multiple locations (${matches.length}). Make the context more specific (include more unchanged lines around the edit) and try again.`
				);
			}
		}
		if (start === -1) start = findFuzzyIndexByAnchors(lines, beforeLines);
		if (start === -1) start = findEditDistanceIndexByAnchors(lines, beforeLines);
		if (start === -1) {
				throw new Error(
					'Patch hunk did not match the current file content.\n\n' +
						'Next steps:\n' +
						'1) Use read_file to fetch the latest content for this file (around the area you want to change).\n' +
						'2) Re-generate the patch with more unchanged context lines, OR switch to apply_patch.edits (replace-string) for a more stable edit.\n'
				);
		}

		lines.splice(start, beforeLines.length, ...afterLines);
	}

	let out = lines.join('\n');
	if (endsWithNewline) out += '\n';
	return out;
}

function escapeRegex(str: string): string {
	return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectEol(text: string): '\r\n' | '\n' {
	return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

function normalizeToLf(text: string): string {
	return String(text ?? '').replace(/\r\n/g, '\n');
}

function toOriginalEol(textLf: string, eol: '\r\n' | '\n'): string {
	return eol === '\r\n' ? String(textLf ?? '').replace(/\n/g, '\r\n') : String(textLf ?? '');
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while (true) {
		const next = haystack.indexOf(needle, idx);
		if (next === -1) break;
		count++;
		idx = next + needle.length;
	}
	return count;
}

function levenshteinWithin(a: string, b: string, maxDistance: number): number {
	const s1 = String(a ?? '');
	const s2 = String(b ?? '');
	if (s1 === s2) return 0;
	if (maxDistance <= 0) return 1;
	const al = s1.length;
	const bl = s2.length;
	if (Math.abs(al - bl) > maxDistance) return maxDistance + 1;
	if (al === 0) return bl;
	if (bl === 0) return al;
	if (bl > al) return levenshteinWithin(s2, s1, maxDistance);

	let prev = new Array(bl + 1);
	let curr = new Array(bl + 1);
	for (let j = 0; j <= bl; j++) prev[j] = j;
	for (let i = 1; i <= al; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		const ca = s1.charCodeAt(i - 1);
		for (let j = 1; j <= bl; j++) {
			const cost = ca === s2.charCodeAt(j - 1) ? 0 : 1;
			const del = prev[j] + 1;
			const ins = curr[j - 1] + 1;
			const sub = prev[j - 1] + cost;
			const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
			curr[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > maxDistance) return maxDistance + 1;
		[prev, curr] = [curr, prev];
	}
	return prev[bl];
}

function buildWhitespaceFlexibleRegex(pattern: string): RegExp {
	// Builds a conservative whitespace-flexible regex:
	// - preserves line breaks (\r?\n)
	// - allows variable horizontal whitespace (spaces/tabs)
	const p = normalizeToLf(pattern);
	let out = '';
	let i = 0;
	while (i < p.length) {
		const ch = p[i];
		if (ch === '\n') {
			out += '(?:\\r?\\n)';
			i++;
			continue;
		}
		if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
			let j = i;
			while (j < p.length) {
				const cj = p[j];
				if (cj === ' ' || cj === '\t' || cj === '\f' || cj === '\v') {
					j++;
					continue;
				}
				break;
			}
			out += '[\\t\\f\\v \u00A0]+';
			i = j;
			continue;
		}
		out += escapeRegex(ch);
		i++;
	}
	return new RegExp(out, 'g');
}

function suggestClosestSnippet(fileTextLf: string, targetLf: string): string | undefined {
	const hayLines = fileTextLf.split('\n');
	const needleLines = targetLf.split('\n');
	const window = needleLines.length;
	if (!window || window > 200 || hayLines.length < window) return undefined;

	let bestStart = -1;
	let bestScore = -1;
	let bestCount = 0;
	for (let i = 0; i <= hayLines.length - window; i++) {
		let score = 0;
		for (let j = 0; j < window; j++) {
			const a = hayLines[i + j].trimEnd();
			const b = needleLines[j].trimEnd();
			if (a === b) {
				score += 2;
				continue;
			}
			const maxLen = Math.max(a.length, b.length);
			const allowed = Math.max(1, Math.floor(maxLen * 0.34));
			const d = levenshteinWithin(a, b, allowed);
			if (d > allowed) continue;
			score += 1;
		}
		if (score > bestScore) {
			bestScore = score;
			bestStart = i;
			bestCount = 1;
		} else if (score === bestScore) {
			bestCount++;
		}
	}
	if (bestStart < 0 || bestCount !== 1) return undefined;
	if (bestScore < Math.max(2, window)) return undefined;
	return hayLines.slice(bestStart, bestStart + window).join('\n');
}

function applyReplaceStringOnce(args: {
	fileText: string;
	oldString: string;
	newString: string;
	expectedReplacements?: number;
}): { updatedText: string; occurrences: number; matchType: string; suggestion?: string } {
	const eol = detectEol(args.fileText);
	const fileLf = normalizeToLf(args.fileText);
	const oldLf = normalizeToLf(args.oldString);
	const newLf = normalizeToLf(args.newString);
	const expected = typeof args.expectedReplacements === 'number' ? args.expectedReplacements : undefined;

	if (oldLf === newLf) {
		return { updatedText: args.fileText, occurrences: 0, matchType: 'noChange' };
	}

	const occExact = countOccurrences(fileLf, oldLf);
	if (occExact > 0) {
		if (expected !== undefined && occExact !== expected) {
			return { updatedText: args.fileText, occurrences: occExact, matchType: 'expectedMismatch' };
		}
		if (expected === undefined && occExact !== 1) {
			return { updatedText: args.fileText, occurrences: occExact, matchType: 'multiple' };
		}
		const replaced = fileLf.split(oldLf).join(newLf);
		return { updatedText: toOriginalEol(replaced, eol), occurrences: occExact, matchType: 'exact' };
	}

	// Whitespace-flexible matching (single unique match only)
	const rx = buildWhitespaceFlexibleRegex(oldLf);
	const matches = Array.from(fileLf.matchAll(rx));
	if (matches.length === 1 && matches[0].index !== undefined) {
		if (expected !== undefined && expected !== 1) {
			return { updatedText: args.fileText, occurrences: 1, matchType: 'expectedMismatch' };
		}
		const start = matches[0].index;
		const end = start + matches[0][0].length;
		const replaced = fileLf.slice(0, start) + newLf + fileLf.slice(end);
		return { updatedText: toOriginalEol(replaced, eol), occurrences: 1, matchType: 'whitespace' };
	}
	if (matches.length > 1) {
		return { updatedText: args.fileText, occurrences: matches.length, matchType: 'multiple' };
	}

	// Line-by-line trailing-whitespace tolerant match (unique only)
	const hayLines = fileLf.split('\n');
	const needleLines = oldLf.split('\n');
	if (needleLines.length > 0 && needleLines.length <= hayLines.length) {
		const window = needleLines.length;
		const starts: number[] = [];
		for (let i = 0; i <= hayLines.length - window; i++) {
			let ok = true;
			for (let j = 0; j < window; j++) {
				if (hayLines[i + j].trimEnd() !== needleLines[j].trimEnd()) {
					ok = false;
					break;
				}
			}
			if (ok) starts.push(i);
		}
		if (starts.length === 1) {
			if (expected !== undefined && expected !== 1) {
				return { updatedText: args.fileText, occurrences: 1, matchType: 'expectedMismatch' };
			}
			const before = hayLines.slice(0, starts[0]).join('\n');
			const after = hayLines.slice(starts[0] + window).join('\n');
			const replaced = [before, newLf, after].filter((x) => x.length > 0).join('\n');
			return { updatedText: toOriginalEol(replaced, eol), occurrences: 1, matchType: 'line' };
		}
		if (starts.length > 1) {
			return { updatedText: args.fileText, occurrences: starts.length, matchType: 'multiple' };
		}
	}

	const suggestion = suggestClosestSnippet(fileLf, oldLf);
	return { updatedText: args.fileText, occurrences: 0, matchType: 'none', suggestion };
}

async function executeToolCall(name: string, input: unknown, runtime?: ToolRuntime): Promise<string> {
	const policy = runtime?.policy;
	const isAskStudy = policy?.agentProfileId === 'ask-study';
	const tripilotCfg = vscode.workspace.getConfiguration('tripilot');
	const editsApprovalMode = String(tripilotCfg.get<string>('edits.approvalMode', 'post') ?? 'post');
	const defaultSensitiveGlobs = [
		'**/.env',
		'**/.env.*',
		'**/.git/**',
		'**/.ssh/**',
		'**/id_rsa',
		'**/id_ed25519',
		'**/*.pem',
		'**/*.p12',
		'**/*.pfx',
		'**/*secret*',
		'**/*token*',
		'**/*key*'
	];
	const sensitiveGlobsRaw = tripilotCfg.get<unknown>('edits.sensitiveGlobs', defaultSensitiveGlobs);
	const sensitiveGlobs = Array.isArray(sensitiveGlobsRaw)
		? sensitiveGlobsRaw.map((s) => String(s ?? '').trim()).filter(Boolean)
		: defaultSensitiveGlobs;
	const globToRegExp = (glob: string) => {
		const g = String(glob ?? '').replace(/\\/g, '/');
		let re = '^';
		for (let i = 0; i < g.length; i++) {
			const ch = g[i];
			if (ch === '*') {
				const next = g[i + 1];
				if (next === '*') {
					re += '.*';
					i++;
				} else {
					re += '[^/]*';
				}
				continue;
			}
			if (ch === '?') {
				re += '[^/]';
				continue;
			}
			if (/[\\.^$+(){}|\[\]]/.test(ch)) {
				re += `\\${ch}`;
				continue;
			}
			re += ch;
		}
		re += '$';
		return new RegExp(re, 'i');
	};
	const sensitiveMatchers = sensitiveGlobs.map(globToRegExp);
	const isSensitiveRelPath = (relPosix: string) => {
		const p = String(relPosix ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
		return sensitiveMatchers.some((r) => r.test(p));
	};

	const normalizeRel = (p: string) => {
		const s = String(p ?? '').replace(/\\/g, '/');
		return path.posix.normalize(s).replace(/^\/+/, '');
	};

	const getAskStudySandbox = () => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) throw new Error('No workspace folder opened.');
		const rel = normalizeRel(policy?.askStudySandboxDir || '.tripilot/ask-study');
		return { folder, rel, uri: vscode.Uri.joinPath(folder.uri, rel) };
	};

	const ensureWorkspaceAndMaybeSandboxForAbsolutePath = (uri: vscode.Uri) => {
		if (uri.scheme !== 'file') throw new Error('仅支持本地文件路径。');
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) throw new Error('No workspace folder opened.');
		const relFs = path.relative(folder.uri.fsPath, uri.fsPath);
		if (!relFs || relFs.startsWith('..') || path.isAbsolute(relFs)) {
			throw new Error(`仅允许在当前工作区目录内写入/修改：${uri.fsPath}`);
		}
		if (isAskStudy) {
			const relPosix = relFs.replace(/\\/g, '/');
			assertRelPathInSandbox(relPosix);
		}
	};

	const ensureSandboxDir = async () => {
		if (!isAskStudy) return;
		const { uri } = getAskStudySandbox();
		await vscode.workspace.fs.createDirectory(uri);
	};

	const assertRelPathInSandbox = (relativePath: string) => {
		if (!isAskStudy) return;
		const { rel: sandboxRel } = getAskStudySandbox();
		const fileRel = normalizeRel(relativePath);
		const base = sandboxRel.endsWith('/') ? sandboxRel : `${sandboxRel}/`;
		if (fileRel !== sandboxRel && !fileRel.startsWith(base)) {
			throw new Error(`ask&study 仅允许在沙盒目录内写入/修改：${sandboxRel}。当前：${fileRel}`);
		}
	};

	const resolveCwdFsPathForAskStudy = (cwdRel?: string) => {
		const { folder, rel: sandboxRel, uri: sandboxUri } = getAskStudySandbox();
		if (!cwdRel) return sandboxUri.fsPath;
		const normalized = normalizeRel(cwdRel);
		const base = sandboxRel.endsWith('/') ? sandboxRel : `${sandboxRel}/`;
		if (normalized !== sandboxRel && !normalized.startsWith(base)) {
			throw new Error(`ask&study 仅允许在沙盒目录内执行：${sandboxRel}。当前 cwd：${normalized}`);
		}
		return vscode.Uri.joinPath(folder.uri, normalized).fsPath;
	};

	let parsed: any;
	if (typeof input === 'string') {
		try {
			parsed = input ? JSON.parse(input) : {};
		} catch {
			throw new Error(`Invalid JSON arguments for tool ${name}: ${input}`);
		}
	} else if (input && typeof input === 'object') {
		parsed = input;
	} else {
		parsed = {};
	}

	// Copilot tool name compatibility (Copilot UI names -> Tripilot internal tool handlers).
	const COPILOT_TOOL_ALIASES: Record<string, string> = {
		// todo
		manage_todo_list: 'manage_todo_list',
		// read
		readFile: 'read_file',
		problems: 'get_errors',
		terminalLastCommand: 'terminal_last_command',
		terminalSelection: 'terminal_selection',
		getNotebookSummary: 'copilot_getNotebookSummary',
		readNotebookCellOutput: 'read_notebook_cell_output',
		getTaskOutput: 'get_task_output',
		// search
		fileSearch: 'file_search',
		textSearch: 'grep_search',
		listDirectory: 'list_dir',
		searchResults: 'get_search_view_results',
		codebase: 'semantic_search',
		usages: 'list_code_usages',
		changes: 'get_changed_files',
		// edit
		createDirectory: 'create_directory',
		createFile: 'create_file',
		editFiles: 'apply_patch',
		editNotebook: 'edit_notebook_file',
		newJupyterNotebook: 'create_new_jupyter_notebook',
		// execute
		runInTerminal: 'run_in_terminal',
		getTerminalOutput: 'get_terminal_output',
		createAndRunTask: 'create_and_run_task',
		runTask: 'run_task',
		runTests: 'run_tests',
		testFailure: 'test_failure',
		runNotebookCell: 'run_notebook_cell',
		// vscode
		extensions: 'extensions',
		installExtension: 'install_extension',
		openSimpleBrowser: 'open_simple_browser',
		runCommand: 'run_vscode_command',
		newWorkspace: 'create_new_workspace',
		getProjectSetupInfo: 'get_project_setup_info',
		vscodeAPI: 'get_vscode_api',
		// web
		fetch: 'fetch_webpage',
		githubRepo: 'github_repo'
	};
	const aliased = COPILOT_TOOL_ALIASES[name];
	if (aliased && aliased !== name) {
		name = aliased;
	}

	// Command-backed tools (extension commands).
	if (runtime?.commandTools?.has(name)) {
		if (isAskStudy && !ASK_STUDY_ALLOWED_COMMAND_TOOL_NAMES.has(name)) {
			throw new Error(`ask&study 不允许使用该扩展工具：${name}`);
		}
		const cfg = runtime.commandTools.get(name);
		if (!cfg) throw new Error(`Unknown command tool: ${name}`);
		const args = Array.isArray(parsed?.args) ? parsed.args : [];
		const result = await vscode.commands.executeCommand(cfg.command as any, ...args);
		return safeToString(result);
	}

	// MCP tools (mapped to lmToolName).
	if (runtime?.mcpManager) {
		const info = runtime.mcpManager.resolveMcpToolByLmName(name);
		if (info) {
			if (isAskStudy && !ASK_STUDY_ALLOWED_MCP_SERVER_IDS.has(info.serverId)) {
				throw new Error(`ask&study 不允许使用该 MCP server：${info.serverId}`);
			}
			const result = await runtime.mcpManager.callToolByLmName(name, parsed ?? {});
			const textParts = Array.isArray(result?.content)
				? result.content
						.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
						.map((c: any) => c.text)
						.join('\n')
				: '';
			if (textParts) return textParts;
			if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
			return safeToString(result);
		}

		// Support qualified aliases: "serverId.toolName" -> internal lmToolName.
		const dot = name.indexOf('.');
		if (dot > 0) {
			const serverId = name.slice(0, dot);
			const toolName = name.slice(dot + 1);
			if (isAskStudy && !ASK_STUDY_ALLOWED_MCP_SERVER_IDS.has(serverId)) {
				throw new Error(`ask&study 不允许使用该 MCP server：${serverId}`);
			}
			const lmToolName = makeMcpLmToolName(serverId, toolName);
			const aliasInfo = runtime.mcpManager.resolveMcpToolByLmName(lmToolName);
			if (aliasInfo) {
				const result = await runtime.mcpManager.callToolByLmName(lmToolName, parsed ?? {});
				const textParts = Array.isArray(result?.content)
					? result.content
							.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
							.map((c: any) => c.text)
							.join('\n')
					: '';
				if (textParts) return textParts;
				if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
				return safeToString(result);
			}
		}
	}

	switch (name) {
		// --- Copilot-aligned compatibility tools ---
		case 'manage_todo_list': {
			const { todoList } = parsed as { todoList: unknown };
			if (!Array.isArray(todoList)) throw new Error('todoList must be an array.');
			const normalized = todoList
				.map((x) => (x && typeof x === 'object' ? (x as any) : null))
				.filter(Boolean)
				.map((t) => ({
					id: Number(t.id),
					title: String(t.title ?? ''),
					description: String(t.description ?? ''),
					status: String(t.status ?? 'not-started')
				}));
			const inProgressCount = normalized.filter((t) => t.status === 'in-progress').length;
			LAST_TODO_LIST = normalized;
			return JSON.stringify(
				{
					todoList: normalized,
					note: inProgressCount > 1 ? 'More than one item is in-progress; consider keeping at most one.' : undefined
				},
				null,
				2
			);
		}
		case 'read_file': {
			const { filePath, startLine, endLine, offset, limit } = parsed as {
				filePath: string;
				startLine?: number;
				endLine?: number;
				offset?: number;
				limit?: number;
			};
			const uri = resolveAnyPathToUri(filePath);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(bytes).toString('utf8');

			// Copilot-aligned behavior for empty/whitespace-only files.
			if (text.length === 0) {
				return `(The file \`${String(filePath)}\` exists, but is empty)`;
			}
			if (text.trim().length === 0) {
				return `(The file \`${String(filePath)}\` exists, but contains only whitespace)`;
			}

			const MAX_LINES_PER_READ = 2000;
			const lines = normalizeNewlinesToLf(text).split('\n');
			const lineCount = lines.length;

			const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
			const asFiniteNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

			// Resolve language id for fenced code blocks.
			let languageId = '';
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				languageId = String((doc as any)?.languageId ?? '');
			} catch {
				languageId = '';
			}
			if (!languageId || languageId === 'plaintext') languageId = '';

			const hasV1 = asFiniteNumber(startLine) !== undefined || asFiniteNumber(endLine) !== undefined;
			const hasV2 = asFiniteNumber(offset) !== undefined || asFiniteNumber(limit) !== undefined;

			let start = 1;
			let end = lineCount;
			let truncated = false;

			if (hasV2 && !hasV1) {
				const rawOffset = asFiniteNumber(offset);
				if (rawOffset !== undefined && rawOffset > lineCount) {
					throw new Error(
						`Invalid offset ${rawOffset}: file only has ${lineCount} line${lineCount === 1 ? '' : 's'}. Line numbers are 1-indexed.`
					);
				}

				const requestedLimit = asFiniteNumber(limit);
				const effectiveLimit = clamp(requestedLimit ?? Infinity, 1, MAX_LINES_PER_READ - 1);
				start = clamp(rawOffset ?? 1, 1, lineCount);
				end = clamp(start + effectiveLimit, 1, lineCount);
				truncated = effectiveLimit !== requestedLimit && end < lineCount;
			} else {
				// V1: startLine/endLine; also apply max lines truncation as a safety cap.
				start = clamp(asFiniteNumber(startLine) ?? 1, 1, lineCount);
				end = clamp(asFiniteNumber(endLine) ?? lineCount, 1, lineCount);
				if (start > end) [start, end] = [end, start];
				if (end - start + 1 > MAX_LINES_PER_READ) {
					end = clamp(start + (MAX_LINES_PER_READ - 1), 1, lineCount);
					truncated = end < lineCount;
				}
			}

			const slice = lines.slice(start - 1, end);
			const fenced = `\`\`\`${languageId}\n${slice.join('\n')}\n\`\`\``;
			if (!truncated) return fenced;
			return (
				fenced +
				`\n\n[File content truncated at line ${end}. Use read_file with offset/limit parameters to view more.]`
			);
		}
		case 'file_search': {
			const { query, maxResults } = parsed as { query: string; maxResults?: number };
			const limit = typeof maxResults === 'number' ? Math.max(1, maxResults) : undefined;
			const uris = await vscode.workspace.findFiles(String(query), '**/node_modules/**');
			const rels = uris.map(toWorkspaceRelativePosix);
			const out = limit ? rels.slice(0, limit) : rels;
			LAST_SEARCH_RESULTS = { kind: 'file_search', query, results: out };
			return JSON.stringify(out, null, 2);
		}
		case 'grep_search': {
			const { query, isRegexp, includePattern, maxResults, includeIgnoredFiles } = parsed as {
				query: string;
				isRegexp: boolean;
				includePattern?: string;
				maxResults?: number;
				includeIgnoredFiles?: boolean;
			};
			const limit = typeof maxResults === 'number' ? Math.max(1, maxResults) : 50;
			const results = await findInFiles({
				pattern: String(query),
				isRegExp: Boolean(isRegexp),
				isCaseSensitive: false,
				isWordMatch: false,
				include: includePattern,
				exclude: includeIgnoredFiles ? undefined : '**/node_modules/**',
				maxResults: limit
			});
			LAST_SEARCH_RESULTS = { kind: 'grep_search', query, isRegexp: Boolean(isRegexp), includePattern, results };
			return JSON.stringify(results, null, 2);
		}
		case 'list_dir': {
			const { path: dirPath } = parsed as { path: string };
			const dirUri = resolveAnyPathToUri(dirPath);
			let entries: [string, vscode.FileType][] = [];
			try {
				entries = await vscode.workspace.fs.readDirectory(dirUri);
			} catch (err) {
				throw new Error(`Cannot read directory: ${safeToString(err)}`);
			}
			const children = entries
				.map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
				.sort((a, b) => a.localeCompare(b));
			return JSON.stringify(children, null, 2);
		}
		case 'create_directory': {
			await ensureSandboxDir();
			const { dirPath } = parsed as { dirPath: string };
			const uri = resolveAnyPathToUri(dirPath);
			// Enforce workspace-only for absolute paths; ask&study also enforces sandbox.
			if (isProbablyAbsolutePath(dirPath)) {
				ensureWorkspaceAndMaybeSandboxForAbsolutePath(uri);
			} else {
				assertRelPathInSandbox(dirPath);
			}
			await vscode.workspace.fs.createDirectory(uri);
			return 'ok';
		}
		case 'create_file': {
			await ensureSandboxDir();
			const { filePath, content, overwrite } = parsed as { filePath: string; content: string; overwrite?: boolean };
			const uri = resolveAnyPathToUri(filePath);
			// Enforce workspace-only for absolute paths; ask&study also enforces sandbox.
			if (isProbablyAbsolutePath(filePath)) {
				ensureWorkspaceAndMaybeSandboxForAbsolutePath(uri);
			} else {
				assertRelPathInSandbox(filePath);
			}
			await ensureParentDir(uri);
			let exists = false;
			try {
				await vscode.workspace.fs.stat(uri);
				exists = true;
			} catch {
				exists = false;
			}
			if (exists && !overwrite) throw new Error('File already exists.');

			let original = '';
			if (exists) {
				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					original = Buffer.from(bytes).toString('utf8');
				} catch {
					original = '';
				}
			}
			const updated = String(content ?? '');
			const folder = vscode.workspace.workspaceFolders?.[0];
			const relPath = folder ? safeWorkspaceRelativePath(uri) || uri.fsPath : uri.fsPath;
			const relPosix = String(relPath ?? '').replace(/\\/g, '/');
			const kind: 'add' | 'update' = exists ? 'update' : 'add';
			const needsPreApproval = isAskStudy || editsApprovalMode === 'pre' || isSensitiveRelPath(relPosix);

			runtime?.abortSignal?.throwIfAborted?.();
			if (needsPreApproval) {
				if (runtime?.requestEditsApproval) {
					const decision = await runtime.requestEditsApproval({
						previews: [{ relativePath: relPosix, uri, original, updated, editCount: 1 }],
						summary: { editCount: 1, fileCount: 1 },
						canPreview: true
					});
					if (decision !== 'apply') {
						return JSON.stringify({ applied: false, cancelled: true, fileCount: 1 }, null, 2);
					}
				} else {
					return JSON.stringify({ applied: false, cancelled: true, reason: 'no-approval-channel' }, null, 2);
				}
			}

			await ensureParentDir(uri);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
			if (!isAskStudy && runtime?.postEditsReview) {
				const requestId = createUuid();
				runtime.postEditsReview({
					requestId,
					previews: [{ relativePath: relPosix, uri, original, updated, editCount: 1, kind }],
					summary: { editCount: 1, fileCount: 1 },
					canPreview: true
				});
			}
			return 'ok';
		}
		case 'apply_patch': {
			await ensureSandboxDir();
			// Be tolerant: some models may send {patch:...} / {diff:...} or even non-JSON raw args.
			const patchRaw = (() => {
				// If JSON parsing failed upstream (models-direct/copilot-direct), we keep the raw args.
				if (parsed && typeof parsed === 'object' && (parsed as any)._parseError && typeof (parsed as any).raw === 'string') {
					return String((parsed as any).raw ?? '');
				}
				const obj = parsed && typeof parsed === 'object' ? (parsed as any) : {};
				const text = obj.input ?? obj.patch ?? obj.diff;
				return String(text ?? '');
			})();
			const previews: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }> = [];
			const actionByUri = new Map<string, { kind: 'add' | 'update' | 'delete' }>();
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) throw new Error('No workspace folder opened.');
			const workspaceRoot = folder.uri.fsPath;
			const ensureWorkspaceFileAndGetRelPosix = (uri: vscode.Uri): string => {
				if (uri.scheme !== 'file') {
					throw new Error('editFiles only supports local workspace files.');
				}
				const relFs = path.relative(workspaceRoot, uri.fsPath);
				if (!relFs || relFs.startsWith('..') || path.isAbsolute(relFs)) {
					throw new Error(`editFiles only supports files under the current workspace folder: ${uri.fsPath}`);
				}
				return relFs.replace(/\\/g, '/');
			};

			const stripGitPrefix = (name: string) => {
				let n = String(name ?? '').trim();
				// parsePatch often yields "a/path" and "b/path".
				n = n.replace(/^(a|b)\//, '');
				return n;
			};
			const isDevNull = (name: string) => {
				const n = String(name ?? '').trim();
				return n === '/dev/null' || n === 'dev/null' || n.endsWith('/dev/null') || n.endsWith('dev/null');
			};

			// Prefer Copilot-style replace-string edits[] when present.
			const obj = parsed && typeof parsed === 'object' ? (parsed as any) : {};
			const edits = Array.isArray(obj?.edits) ? (obj.edits as any[]) : undefined;
			if (edits && edits.length) {
				const globalEnableHealing = !!vscode.workspace.getConfiguration('tripilot').get<boolean>('edits.enableHealing', false);
				const profileId = runtime?.policy?.agentProfileId ? String(runtime.policy.agentProfileId) : getDefaultAgentProfileId();
				const profileEnableHealing = getAgentProfileMerged(profileId).editsEnableHealing;
				const enableHealing = isAskStudy || (profileEnableHealing ?? globalEnableHealing);

				const grouped = new Map<string, any[]>();
				for (const e of edits) {
					const filePath = String(e?.filePath ?? e?.path ?? '').trim();
					if (!filePath) continue;
					const arr = grouped.get(filePath) ?? [];
					arr.push(e);
					grouped.set(filePath, arr);
				}
				if (!grouped.size) {
					throw new Error('apply_patch.edits was provided but contained no valid filePath entries.');
				}

				for (const [filePath, fileEdits] of grouped) {
					const uri = resolveAnyPathToUri(filePath);
					const relPath = ensureWorkspaceFileAndGetRelPosix(uri);
					assertRelPathInSandbox(relPath);

					let original = '';
					try {
						const bytes = await vscode.workspace.fs.readFile(uri);
						original = Buffer.from(bytes).toString('utf8');
					} catch {
						original = '';
					}

					let updated = original;
					let editCount = 0;
					for (const e of fileEdits) {
						runtime?.abortSignal?.throwIfAborted?.();
						const oldString = String(e?.oldString ?? e?.old_string ?? '');
						const newString = String(e?.newString ?? e?.new_string ?? '');
						const expected = e?.expected_replacements ?? e?.expectedReplacements;
						const expectedReplacements = typeof expected === 'number' ? expected : undefined;

						if (!oldString) {
							throw new Error(
								`Missing required field oldString for ${relPath}.\n\n` +
									'Next steps:\n' +
									'1) Use read_file to fetch the latest content of the file.\n' +
									'2) Set oldString to an exact snippet from the current file and retry.\n'
							);
						}
						const res = applyReplaceStringOnce({ fileText: updated, oldString, newString, expectedReplacements });
						if (res.matchType === 'noChange') {
							throw new Error(
								`This edit makes no changes in ${relPath} (oldString and newString are identical).\n\n` +
									'Next steps:\n' +
									'1) Remove this edit entry, or change newString.\n'
							);
						}
						if (res.matchType === 'multiple') {
							throw new Error(
								`Couldn't apply the edit in ${relPath} because the target text is ambiguous (matched ${res.occurrences} times).\n\n` +
									'Next steps:\n' +
									'1) Make oldString more specific by including more surrounding unchanged text.\n' +
									'2) Or set expected_replacements to the intended match count if replacing multiple occurrences is desired.\n'
							);
						}
						if (res.matchType === 'expectedMismatch') {
							throw new Error(
								`Couldn't apply the edit in ${relPath}: expected ${expectedReplacements} replacements, but found ${res.occurrences}.\n\n` +
									'Next steps:\n' +
									'1) Use read_file to verify the current content.\n' +
									'2) Update oldString to match the current file, or adjust expected_replacements.\n'
							);
						}
						if (res.matchType === 'none') {
							let healingAttempted = false;
							if (enableHealing && res.suggestion && (expectedReplacements === undefined || expectedReplacements === 1)) {
								healingAttempted = true;
								const healed = applyReplaceStringOnce({
									fileText: updated,
									oldString: res.suggestion,
									newString,
									expectedReplacements: 1
								});
								if (
									healed.occurrences === 1 &&
									healed.updatedText !== updated &&
									healed.matchType !== 'none' &&
									healed.matchType !== 'multiple' &&
									healed.matchType !== 'expectedMismatch' &&
									healed.matchType !== 'noChange'
								) {
									updated = healed.updatedText;
									editCount++;
									continue;
								}
							}

							const hint = res.suggestion
								? `\nClosest similar snippet (may help update oldString):\n\n\`\`\`\n${res.suggestion}\n\`\`\`\n`
								: '';
							const healingNote = healingAttempted
								? '\n\nNote: Healing was enabled, but no safe unique match was found.'
								: '';
							const retryTemplate = res.suggestion
								? `\n\nReady-to-use retry template (copy, adjust newString, and retry apply_patch):\n\`\`\`json\n${JSON.stringify(
										{
											edits: [
												{
													filePath: relPath,
													oldString: res.suggestion,
													newString: newString || '<update this to the new content>',
													expected_replacements: 1
												}
											]
										},
										null,
										2
									)}\n\`\`\`\n`
								: '';
							throw new Error(
								`Couldn't find the text to replace in ${relPath}.\n\n` +
									'Why this happens: the file may have changed since it was read, or whitespace/newlines differ (CRLF vs LF).\n\n' +
									'Next steps:\n' +
									`1) Use read_file on ${relPath} to fetch the latest content around the area.\n` +
									'2) Update oldString to exactly match the current file and retry apply_patch.edits.\n' +
									'3) If you have a diff patch, regenerate it with more unchanged context.\n' +
									healingNote +
									hint +
									retryTemplate
							);
						}
						if (res.updatedText === updated) {
							throw new Error(
								`The edit didn't change ${relPath}.\n\n` +
									'Next steps:\n' +
									'1) Use read_file to verify the exact snippet you want to replace.\n' +
									'2) Adjust oldString/newString so the replacement results in a real change.\n'
							);
						}
						updated = res.updatedText;
						editCount++;
					}

					const kind: 'add' | 'update' = original ? 'update' : 'add';
					previews.push({ relativePath: relPath, uri, original, updated, editCount: editCount || 1 });
					actionByUri.set(uri.toString(), { kind });
				}
			} else if (patchRaw.includes('*** Begin Patch')) {
				const actions = parseTripilotPatch(patchRaw);
				for (const a of actions) {
					const filePathRaw = String(a.filePath ?? '').trim();
					if (!filePathRaw) continue;
					const uri = resolveAnyPathToUri(filePathRaw);
					const relPath = ensureWorkspaceFileAndGetRelPosix(uri);
					assertRelPathInSandbox(relPath);
					let original = '';
					try {
						const bytes = await vscode.workspace.fs.readFile(uri);
						original = Buffer.from(bytes).toString('utf8');
					} catch {
						original = '';
					}
					let updated = original;
					let editCount = 1;
					if (a.kind === 'add') {
						updated = a.content;
					} else if (a.kind === 'delete') {
						updated = '';
					} else {
						updated = applyHunksToText(original, a.hunks);
						editCount = a.hunks.length;
					}
					previews.push({ relativePath: relPath, uri, original, updated, editCount });
					actionByUri.set(uri.toString(), { kind: a.kind });
				}
			} else {
				const filePatches = parsePatch(patchRaw);
				const tryAppendOnly = (originalText: string, fp: any): string | undefined => {
					const hunks = Array.isArray(fp?.hunks) ? fp.hunks : [];
					const added: string[] = [];
					let removedCount = 0;
					for (const h of hunks) {
						const lines = Array.isArray(h?.lines) ? h.lines : [];
						for (const ln of lines) {
							const line = String(ln ?? '');
							if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) continue;
							if (line.startsWith('-')) {
								removedCount++;
								continue;
							}
							if (line.startsWith('+')) {
								added.push(line.slice(1));
							}
						}
					}
					if (!added.length || removedCount > 0) return undefined;
					const base = normalizeNewlinesToLf(originalText);
					const appendText = normalizeNewlinesToLf(added.join('\n')).replace(/\s+$/g, '');
					return base + (base.endsWith('\n') || !base ? '' : '\n') + appendText + '\n';
				};
				const trySingleFileAppendFromRaw = async (): Promise<boolean> => {
					const m = patchRaw.match(/^\+\+\+\s+b\/(.+)$/m);
					if (!m) return false;
					const targetName = stripGitPrefix(String(m[1] ?? '').trim());
					if (!targetName) return false;
					const lines = patchRaw.split(/\r?\n/);
					const added: string[] = [];
					let removedCount = 0;
					for (const ln of lines) {
						if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff --git') || ln.startsWith('index ') || ln.startsWith('@@')) continue;
						if (ln.startsWith('-')) {
							removedCount++;
							continue;
						}
						if (ln.startsWith('+')) added.push(ln.slice(1));
					}
					if (!added.length || removedCount > 0) return false;
					const uri = resolveAnyPathToUri(targetName);
					const relPath = ensureWorkspaceFileAndGetRelPosix(uri);
					assertRelPathInSandbox(relPath);
					let original = '';
					try {
						const bytes = await vscode.workspace.fs.readFile(uri);
						original = Buffer.from(bytes).toString('utf8');
					} catch {
						original = '';
					}
					const base = normalizeNewlinesToLf(original);
					const appendText = normalizeNewlinesToLf(added.join('\n')).replace(/\s+$/g, '');
					const updated = base + (base.endsWith('\n') || !base ? '' : '\n') + appendText + '\n';
					previews.push({ relativePath: relPath, uri, original, updated, editCount: 1 });
					actionByUri.set(uri.toString(), { kind: original ? 'update' : 'add' });
					return true;
				};

				if (!Array.isArray(filePatches) || filePatches.length === 0) {
					const didRecover = await trySingleFileAppendFromRaw();
					if (!didRecover) {
						throw new Error('Unsupported patch format. Expected Tripilot patch (*** Begin Patch) or unified git diff (diff --git).');
					}
				} else {
					for (const fp of filePatches as any[]) {
					const oldName = stripGitPrefix(String(fp?.oldFileName ?? ''));
					const newName = stripGitPrefix(String(fp?.newFileName ?? ''));
					const kind: 'add' | 'update' | 'delete' =
						isDevNull(oldName) && !isDevNull(newName)
							? 'add'
							: !isDevNull(oldName) && isDevNull(newName)
								? 'delete'
								: 'update';
					const targetName = kind === 'delete' ? oldName : newName || oldName;
					if (!targetName || isDevNull(targetName)) continue;

					const uri = resolveAnyPathToUri(targetName);
					const relPath = ensureWorkspaceFileAndGetRelPosix(uri);
					assertRelPathInSandbox(relPath);

					let original = '';
					try {
						const bytes = await vscode.workspace.fs.readFile(uri);
						original = Buffer.from(bytes).toString('utf8');
					} catch {
						original = '';
					}

					let updated = original;
					const hunkCount = Array.isArray(fp?.hunks) ? fp.hunks.length : 1;
					if (kind === 'delete') {
						updated = '';
					} else {
						const applied = applyUnifiedPatch(original, fp as any);
						if (applied === false) {
							const appended = tryAppendOnly(original, fp);
							if (!appended) {
								throw new Error(
									`Couldn't apply the patch to ${relPath} because the file content doesn't match the diff context.\n\n` +
										'Next steps:\n' +
										`1) Use read_file on ${relPath} to fetch the latest content.\n` +
										'2) Regenerate the diff with more unchanged context around the change.\n' +
										'3) Or switch to apply_patch.edits (replace-string) for a more stable edit.\n'
								);
							}
							updated = appended;
						} else {
							updated = String(applied);
						}
					}

					previews.push({ relativePath: relPath, uri, original, updated, editCount: hunkCount });
					actionByUri.set(uri.toString(), { kind });
					}
				}
			}

			if (!previews.length) return 'no-op';
			const summary = { editCount: previews.reduce((n, p) => n + p.editCount, 0), fileCount: previews.length };
			const needsPreApproval =
				isAskStudy ||
				editsApprovalMode === 'pre' ||
				previews.some((p) => isSensitiveRelPath(String(p.relativePath ?? '')));

			runtime?.abortSignal?.throwIfAborted?.();
			if (needsPreApproval) {
				if (runtime?.requestEditsApproval) {
					const decision = await runtime.requestEditsApproval({ previews, summary, canPreview: true });
					if (decision !== 'apply') {
						return JSON.stringify({ applied: false, cancelled: true, fileCount: previews.length }, null, 2);
					}
				} else {
					return JSON.stringify({ applied: false, cancelled: true, reason: 'no-approval-channel' }, null, 2);
				}
			}

			for (const p of previews) {
				const meta = actionByUri.get(p.uri.toString());
				if (meta?.kind === 'delete') {
					try {
						await vscode.workspace.fs.delete(p.uri, { recursive: false, useTrash: true });
					} catch {
						// ignore
					}
					continue;
				}
				await ensureParentDir(p.uri);
				await vscode.workspace.fs.writeFile(p.uri, Buffer.from(p.updated ?? '', 'utf8'));
			}
			if (!isAskStudy && runtime?.postEditsReview) {
				const requestId = createUuid();
				runtime.postEditsReview({
					requestId,
					previews: previews.map((p) => ({
						relativePath: p.relativePath,
						uri: p.uri,
						original: p.original,
						updated: p.updated,
						editCount: p.editCount,
						kind: actionByUri.get(p.uri.toString())?.kind ?? 'update'
					})),
					summary,
					canPreview: true
				});
			}
			return JSON.stringify({ applied: true, fileCount: previews.length }, null, 2);
		}
		case 'edit_files': {
			return await executeToolCall('apply_patch', parsed, runtime);
		}
		case 'get_errors': {
			const { filePaths } = parsed as { filePaths?: string[] };
			const normalized = Array.isArray(filePaths) ? filePaths.map(String).filter(Boolean) : undefined;
			const maxItems = 200;
			let tuples: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = [];
			if (normalized && normalized.length) {
				tuples = normalized.map((p) => {
					const uri = resolveAnyPathToUri(p);
					return [uri, vscode.languages.getDiagnostics(uri)] as [vscode.Uri, readonly vscode.Diagnostic[]];
				});
			} else {
				tuples = vscode.languages.getDiagnostics();
			}
			const items: any[] = [];
			for (const [uri, diags] of tuples) {
				for (const d of diags) {
					items.push({
						path: toWorkspaceRelativePosix(uri) || uri.fsPath,
						severity: severityToString(d.severity),
						message: d.message,
						source: d.source ?? null,
						range: {
							startLine: d.range.start.line + 1,
							startCharacter: d.range.start.character + 1,
							endLine: d.range.end.line + 1,
							endCharacter: d.range.end.character + 1
						}
					});
					if (items.length >= maxItems) break;
				}
				if (items.length >= maxItems) break;
			}
			return JSON.stringify({ count: items.length, items }, null, 2);
		}
		case 'get_changed_files': {
			const { repositoryPath, sourceControlState } = parsed as {
				repositoryPath?: string;
				sourceControlState?: Array<'staged' | 'unstaged' | 'merge-conflicts'>;
			};
			const folder = vscode.workspace.workspaceFolders?.[0];
			const cwd = repositoryPath
				? (isProbablyAbsolutePath(repositoryPath) ? repositoryPath : (folder ? vscode.Uri.joinPath(folder.uri, repositoryPath).fsPath : repositoryPath))
				: folder?.uri.fsPath;
			if (!cwd) throw new Error('No workspace folder opened.');
			const states = Array.isArray(sourceControlState) && sourceControlState.length ? sourceControlState : ['staged', 'unstaged'];
			const execFileAsync = promisify(execFile);
			const files = new Set<string>();
			for (const s of states) {
				if (s === 'merge-conflicts') {
					// Best-effort: list unmerged paths.
					try {
						const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd });
						for (const line of String(stdout ?? '').split(/\r?\n/)) {
							const t = line.trim();
							if (t) files.add(t);
						}
					} catch {
						// ignore
					}
					continue;
				}
				const args = s === 'staged' ? ['diff', '--name-only', '--cached'] : ['diff', '--name-only'];
				const { stdout } = await execFileAsync('git', args, { cwd });
				for (const line of String(stdout ?? '').split(/\r?\n/)) {
					const t = line.trim();
					if (t) files.add(t);
				}
			}
			return JSON.stringify(Array.from(files.values()), null, 2);
		}
		case 'run_in_terminal': {
			await ensureSandboxDir();
			const { command, explanation, isBackground } = parsed as { command: string; explanation: string; isBackground: boolean };
			const cmd = String(command ?? '');
			LAST_TERMINAL_COMMAND = cmd;
			const id = createUuid();
			const folder = vscode.workspace.workspaceFolders?.[0];
			const cwd = folder ? (isAskStudy ? resolveCwdFsPathForAskStudy(undefined) : folder.uri.fsPath) : undefined;
			// Use PowerShell on Windows for better parity.
			const child = process.platform === 'win32'
				? spawn('powershell', ['-NoProfile', '-Command', cmd], { cwd, windowsHide: true })
				: spawn('bash', ['-lc', cmd], { cwd });
			const rec: CapturedRun = {
				id,
				command: cmd,
				explanation: String(explanation ?? ''),
				isBackground: Boolean(isBackground),
				startedAt: Date.now(),
				pid: child.pid,
				stdout: '',
				stderr: '',
				exitCode: null,
				done: false
			};
			CAPTURED_RUNS.set(id, rec);
			child.stdout?.on('data', (b) => {
				rec.stdout += String(b ?? '');
			});
			child.stderr?.on('data', (b) => {
				rec.stderr += String(b ?? '');
			});
			const donePromise = new Promise<void>((resolve) => {
				child.on('close', (code) => {
					rec.exitCode = typeof code === 'number' ? code : null;
					rec.done = true;
					resolve();
				});
			});
			if (rec.isBackground) {
				// Do not await.
				return JSON.stringify({ id, pid: rec.pid ?? null, isBackground: true }, null, 2);
			}
			await donePromise;
			return JSON.stringify(
				{
					id,
					pid: rec.pid ?? null,
					exitCode: rec.exitCode ?? null,
					stdout: truncate(rec.stdout, 60000),
					stderr: truncate(rec.stderr, 60000)
				},
				null,
				2
			);
		}
		case 'runInTerminal': {
			return await executeToolCall('run_in_terminal', parsed, runtime);
		}
		case 'get_terminal_output': {
			const { id } = parsed as { id: string };
			const rec = CAPTURED_RUNS.get(String(id));
			if (!rec) throw new Error('Unknown terminal id.');
			return JSON.stringify(
				{
					id: rec.id,
					pid: rec.pid ?? null,
					done: rec.done,
					exitCode: rec.exitCode ?? null,
					stdout: truncate(rec.stdout, 60000),
					stderr: truncate(rec.stderr, 60000)
				},
				null,
				2
			);
		}
		case 'getTerminalOutput': {
			return await executeToolCall('get_terminal_output', parsed, runtime);
		}
		case 'terminal_last_command': {
			return JSON.stringify({ command: LAST_TERMINAL_COMMAND ?? null }, null, 2);
		}
		case 'terminal_selection': {
			return JSON.stringify({ selection: '' }, null, 2);
		}
		case 'get_search_view_results': {
			return JSON.stringify(LAST_SEARCH_RESULTS ?? null, null, 2);
		}
		case 'create_and_run_task': {
			await ensureSandboxDir();
			const { workspaceFolder, task } = parsed as {
				workspaceFolder: string;
				task: { label: string; type: 'shell'; command: string; args?: string[]; isBackground?: boolean };
			};
			const wsFolder = String(workspaceFolder ?? '').trim();
			const label = String(task?.label ?? '').trim() || 'task';
			const commandExe = String(task?.command ?? '').trim();
			const args = Array.isArray(task?.args) ? task.args.map(String) : [];
			const isBackground = Boolean(task?.isBackground);
			if (!wsFolder || !commandExe) throw new Error('workspaceFolder and task.command are required.');
			TASK_DEFS.set(label, { workspaceFolder: wsFolder, label, command: commandExe, args, isBackground });

			const folder = vscode.workspace.workspaceFolders?.[0];
			const cwd = isProbablyAbsolutePath(wsFolder)
				? wsFolder
				: folder
					? vscode.Uri.joinPath(folder.uri, wsFolder.replace(/\\/g, '/').replace(/^\/+/, '')).fsPath
					: wsFolder;

			const id = createUuid();
			const child = spawn(commandExe, args, { cwd, windowsHide: true });
			const rec: CapturedTask = {
				id,
				label,
				workspaceFolder: wsFolder,
				commandExe,
				args,
				command: [commandExe, ...args].join(' '),
				explanation: `task: ${label}`,
				isBackground,
				startedAt: Date.now(),
				pid: child.pid,
				stdout: '',
				stderr: '',
				exitCode: null,
				done: false
			};
			CAPTURED_TASKS.set(id, rec);
			child.stdout?.on('data', (b) => (rec.stdout += String(b ?? '')));
			child.stderr?.on('data', (b) => (rec.stderr += String(b ?? '')));
			const donePromise = new Promise<void>((resolve) => {
				child.on('close', (code) => {
					rec.exitCode = typeof code === 'number' ? code : null;
					rec.done = true;
					resolve();
				});
			});
			if (isBackground) {
				return JSON.stringify({ id, label, isBackground: true }, null, 2);
			}
			await donePromise;
			return JSON.stringify(
				{
					id,
					label,
					exitCode: rec.exitCode ?? null,
					stdout: truncate(rec.stdout, 60000),
					stderr: truncate(rec.stderr, 60000)
				},
				null,
				2
			);
		}
		case 'run_task': {
			await ensureSandboxDir();
			const { workspaceFolder, id } = parsed as { workspaceFolder: string; id: string };
			const wsFolder = String(workspaceFolder ?? '').trim();
			const taskId = String(id ?? '').trim();
			if (!wsFolder || !taskId) throw new Error('workspaceFolder and id are required.');

			// Prefer our own captured tasks by id.
			const existing = CAPTURED_TASKS.get(taskId);
			if (existing) {
				return JSON.stringify({ id: existing.id, label: existing.label, alreadyStarted: true }, null, 2);
			}

			// If a definition exists (by label), run it.
			const def = TASK_DEFS.get(taskId);
			if (def) {
				return await executeToolCall('create_and_run_task', { workspaceFolder: def.workspaceFolder, task: { label: def.label, type: 'shell', command: def.command, args: def.args, isBackground: def.isBackground } }, runtime);
			}

			// Best-effort: run VS Code task if present (no output capture).
			try {
				const tasks = await vscode.tasks.fetchTasks();
				const match = tasks.find((t) => String(t.name ?? '').trim() === taskId);
				if (match) {
					await vscode.tasks.executeTask(match);
					return JSON.stringify({ started: true, id: taskId, note: 'VS Code task started; output capture is not available via public API.' }, null, 2);
				}
			} catch {
				// ignore
			}

			throw new Error(`Unknown task id: ${taskId}`);
		}
		case 'runTask': {
			return await executeToolCall('run_task', parsed, runtime);
		}
		case 'get_task_output': {
			const { id } = parsed as { workspaceFolder: string; id: string };
			const rec = CAPTURED_TASKS.get(String(id ?? ''));
			if (!rec) throw new Error('Unknown task id (only captured tasks are supported).');
			return JSON.stringify(
				{
					id: rec.id,
					label: rec.label,
					done: rec.done,
					exitCode: rec.exitCode ?? null,
					stdout: truncate(rec.stdout, 60000),
					stderr: truncate(rec.stderr, 60000)
				},
				null,
				2
			);
		}
		case 'getTaskOutput': {
			return await executeToolCall('get_task_output', parsed, runtime);
		}
		case 'run_tests': {
			await ensureSandboxDir();
			// Best-effort: npm test in workspace root.
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) throw new Error('No workspace folder opened.');
			const cmd = 'npm';
			const args = ['test'];
			const id = createUuid();
			const child = spawn(cmd, args, { cwd: folder.uri.fsPath, windowsHide: true });
			const out: { stdout: string; stderr: string } = { stdout: '', stderr: '' };
			child.stdout?.on('data', (b) => (out.stdout += String(b ?? '')));
			child.stderr?.on('data', (b) => (out.stderr += String(b ?? '')));
			const exitCode: number | null = await new Promise((resolve) => child.on('close', (c) => resolve(typeof c === 'number' ? c : null)));
			if (exitCode && exitCode !== 0) {
				LAST_TEST_FAILURE = truncate(out.stdout + '\n' + out.stderr, 120000);
			} else {
				LAST_TEST_FAILURE = undefined;
			}
			return JSON.stringify(
				{ id, exitCode, stdout: truncate(out.stdout, 60000), stderr: truncate(out.stderr, 60000) },
				null,
				2
			);
		}
		case 'runTests': {
			return await executeToolCall('run_tests', parsed, runtime);
		}
		case 'test_failure': {
			return JSON.stringify({ failure: LAST_TEST_FAILURE ?? null }, null, 2);
		}
		case 'testFailure': {
			return await executeToolCall('test_failure', parsed, runtime);
		}
		case 'copilot_getNotebookSummary': {
			const { filePath } = parsed as { filePath: string };
			const uri = resolveAnyPathToUri(String(filePath ?? ''));
			const doc = await vscode.workspace.openNotebookDocument(uri);
			const cells = doc.getCells();
			let cumulativeLine = 1;
			const items = cells.map((c, i) => {
				const kind = c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
				const lineCount = c.document?.lineCount ?? 1;
				const startLine = cumulativeLine;
				const endLine = cumulativeLine + Math.max(1, lineCount) - 1;
				cumulativeLine = endLine + 1;
				const out = notebookOutputsToStructured(c.outputs, 4000);
				const exec = (c as any).executionSummary as vscode.NotebookCellExecutionSummary | undefined;
				const md = (c as any)?.metadata;
				const tripilotCellId = md && typeof md === 'object' ? String((md as any).tripilotCellId ?? '') : '';
				const stableId = c.document?.uri?.toString() ?? '';
				return {
					id: `cell-${i}`,
					stableId: stableId || null,
					tripilotCellId: tripilotCellId ? `tripilot:${tripilotCellId}` : null,
					index: i,
					kind,
					language: c.document?.languageId ?? 'plaintext',
					cellDocumentUri: c.document?.uri?.toString() ?? null,
					lineRange: { startLine, endLine },
					execution: exec
						? {
							success: Boolean((exec as any).success),
							startTime: (exec as any).timing?.startTime ?? null,
							endTime: (exec as any).timing?.endTime ?? null
						}
						: null,
					outputMimeTypes: out.mimeTypes,
					outputTextPreview: out.text ? truncate(out.text, 2000) : '',
					outputs: out.outputs
				};
			});
			return JSON.stringify({ filePath: uri.fsPath, cellCount: items.length, cells: items }, null, 2);
		}
		case 'read_notebook_cell_output': {
			const { filePath, cellId } = parsed as { filePath: string; cellId: string };
			const uri = resolveAnyPathToUri(String(filePath ?? ''));
			const doc = await vscode.workspace.openNotebookDocument(uri);
			const cells = doc.getCells();
			const idx = resolveNotebookCellIdToIndex(String(cellId ?? ''), cells);
			const cell = cells[idx];
			const out = notebookOutputsToStructured(cell.outputs, 20000);
			return JSON.stringify(
				{
					filePath: uri.fsPath,
					cellId: `cell-${idx}`,
					index: idx,
					mimeTypes: out.mimeTypes,
					text: truncate(out.text, 60000),
					outputs: out.outputs
				},
				null,
				2
			);
		}
		case 'run_notebook_cell': {
			await ensureSandboxDir();
			const { filePath, cellId } = parsed as { filePath: string; cellId: string; reason?: string };
			// Running code is execution: keep ask&study constrained to sandbox-relative paths.
			if (isAskStudy && isProbablyAbsolutePath(filePath)) {
				throw new Error('ask&study 运行 notebook cell 仅允许使用工作区相对路径（且位于沙盒目录）。');
			}
			if (isAskStudy && !isProbablyAbsolutePath(filePath)) {
				assertRelPathInSandbox(filePath);
			}
			const uri = resolveAnyPathToUri(String(filePath ?? ''));
			const doc = await vscode.workspace.openNotebookDocument(uri);
			const editor = await vscode.window.showNotebookDocument(doc, { preview: false, preserveFocus: true });
			const cells = doc.getCells();
			const idx = resolveNotebookCellIdToIndex(String(cellId ?? ''), cells);
			const range = new vscode.NotebookRange(idx, idx + 1);
			const before = notebookOutputsToStructured(cells[idx].outputs, 20000);
			let executed = false;
			let lastErr: unknown = undefined;
			for (const attempt of [
				() => vscode.commands.executeCommand('notebook.cell.execute', { ranges: [range], document: doc.uri }),
				() => vscode.commands.executeCommand('notebook.cell.execute', doc.uri, range),
				() => vscode.commands.executeCommand('notebook.cell.execute', range),
				() => vscode.commands.executeCommand('notebook.cell.execute')
			]) {
				try {
					await attempt();
					executed = true;
					break;
				} catch (e) {
					lastErr = e;
				}
			}
			if (!executed) {
				throw new Error(`Failed to execute notebook cell via VS Code commands: ${safeToString(lastErr)}`);
			}

			// Best-effort wait: outputs or execution summary changes.
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline) {
				runtime?.abortSignal?.throwIfAborted?.();
				await new Promise((r) => setTimeout(r, 300));
				const latestCells = editor.notebook.getCells();
				const latest = latestCells[idx];
				const now = notebookOutputsToStructured(latest.outputs, 20000);
				const exec = (latest as any).executionSummary as vscode.NotebookCellExecutionSummary | undefined;
				if (now.text !== before.text || (exec && (exec as any).timing?.endTime)) {
					break;
				}
			}

			const finalCells = editor.notebook.getCells();
			const final = finalCells[idx];
			const out = notebookOutputsToStructured(final.outputs, 20000);
			const exec = (final as any).executionSummary as vscode.NotebookCellExecutionSummary | undefined;
			return JSON.stringify(
				{
					filePath: uri.fsPath,
					cellId: `cell-${idx}`,
					index: idx,
					execution: exec
						? {
							success: Boolean((exec as any).success),
							startTime: (exec as any).timing?.startTime ?? null,
							endTime: (exec as any).timing?.endTime ?? null
						}
						: null,
					mimeTypes: out.mimeTypes,
					text: truncate(out.text, 60000),
					outputs: out.outputs
				},
				null,
				2
			);
		}
		case 'edit_notebook_file': {
			await ensureSandboxDir();
			const { filePath, cellId, editType, newCode, language } = parsed as {
				filePath: string;
				cellId: string;
				editType: 'insert' | 'delete' | 'edit';
				newCode?: string | string[];
				language?: string;
			};
			if (isAskStudy && isProbablyAbsolutePath(filePath)) {
				throw new Error('ask&study 编辑 notebook 仅允许使用工作区相对路径（且位于沙盒目录）。');
			}
			if (isAskStudy && !isProbablyAbsolutePath(filePath)) {
				assertRelPathInSandbox(filePath);
			}
			const uri = resolveAnyPathToUri(String(filePath ?? ''));
			// Open notebook so we can resolve stable cell ids (URI / tripilot:<id>) to an index.
			let resolvedIndexFromToolId: number | undefined;
			try {
				const docForIndex = await vscode.workspace.openNotebookDocument(uri);
				const vsCells = docForIndex.getCells();
				const anchor = String(cellId ?? '').trim();
				if (anchor && anchor !== 'TOP' && anchor !== 'BOTTOM') {
					resolvedIndexFromToolId = resolveNotebookCellIdToIndex(anchor, vsCells);
				}
			} catch {
				resolvedIndexFromToolId = undefined;
			}
			let originalText = '';
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				originalText = Buffer.from(bytes).toString('utf8');
			} catch {
				originalText = '';
			}
			const nb: any = originalText ? JSON.parse(originalText) : { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] };
			nb.cells = Array.isArray(nb.cells) ? nb.cells : [];

			const cells: any[] = nb.cells;
			const code = normalizeNotebookNewCode(newCode);
			const lang = String(language ?? '').trim();
			const kind = lang.toLowerCase() === 'markdown' ? 'markdown' : 'code';
			const anchor = String(cellId ?? '').trim();
			const isTop = anchor === 'TOP';
			const isBottom = anchor === 'BOTTOM';
			let targetIndex = -1;
			if (editType === 'insert') {
				if (isTop) targetIndex = 0;
				else if (isBottom) targetIndex = cells.length;
				else {
					if (typeof resolvedIndexFromToolId !== 'number' || !Number.isFinite(resolvedIndexFromToolId)) {
						throw new Error('Unable to resolve cellId to an index for insert.');
					}
					targetIndex = resolvedIndexFromToolId + 1;
				}
				const newCell: any =
					kind === 'markdown'
						? { cell_type: 'markdown', metadata: { tripilotCellId: createUuid() }, source: code }
						: { cell_type: 'code', metadata: { tripilotCellId: createUuid() }, execution_count: null, outputs: [], source: code };
				cells.splice(targetIndex, 0, newCell);
			} else if (editType === 'delete') {
				if (isTop || isBottom) throw new Error('delete requires a concrete cellId (not TOP/BOTTOM).');
				if (typeof resolvedIndexFromToolId !== 'number' || !Number.isFinite(resolvedIndexFromToolId)) {
					throw new Error('Unable to resolve cellId to an index for delete.');
				}
				targetIndex = resolvedIndexFromToolId;
				cells.splice(targetIndex, 1);
			} else {
				if (isTop || isBottom) throw new Error('edit requires a concrete cellId (not TOP/BOTTOM).');
				if (typeof resolvedIndexFromToolId !== 'number' || !Number.isFinite(resolvedIndexFromToolId)) {
					throw new Error('Unable to resolve cellId to an index for edit.');
				}
				targetIndex = resolvedIndexFromToolId;
				const cell = cells[targetIndex];
				if (!cell || typeof cell !== 'object') throw new Error('Target cell not found.');
				cell.cell_type = kind === 'markdown' ? 'markdown' : (cell.cell_type ?? 'code');
				cell.source = code;
				if (!cell.metadata || typeof cell.metadata !== 'object') cell.metadata = {};
				if (!cell.metadata.tripilotCellId) cell.metadata.tripilotCellId = createUuid();
			}

			const updatedText = JSON.stringify(nb, null, 2) + '\n';
			const previews = [
				{
					relativePath: isProbablyAbsolutePath(filePath) ? uri.fsPath : String(filePath).replace(/\\/g, '/').replace(/^\/+/, ''),
					uri,
					original: originalText,
					updated: updatedText,
					editCount: 1
				}
			];

			runtime?.abortSignal?.throwIfAborted?.();
			if (runtime?.requestEditsApproval) {
				const decision = await runtime.requestEditsApproval({
					previews,
					summary: { editCount: 1, fileCount: 1 },
					canPreview: true
				});
				if (decision !== 'apply') {
					return JSON.stringify({ applied: false, cancelled: true }, null, 2);
				}
			} else {
				return JSON.stringify({ applied: false, cancelled: true, reason: 'no-approval-channel' }, null, 2);
			}

			await ensureParentDir(uri);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(updatedText, 'utf8'));

			// Re-open to report stable ids for chaining.
			let resolved: any = { cellId: null, stableId: null, tripilotCellId: null, index: null };
			try {
				const afterDoc = await vscode.workspace.openNotebookDocument(uri);
				const afterCells = afterDoc.getCells();
				let idx = targetIndex;
				// For insert, the new cell is at targetIndex.
				// For delete, report the deleted index (may now point to next cell) as best-effort.
				if (idx < 0) idx = 0;
				if (idx >= afterCells.length) idx = Math.max(0, afterCells.length - 1);
				const cell = afterCells[idx];
				const md = (cell as any)?.metadata;
				const tripilotIdRaw = md && typeof md === 'object' ? String((md as any).tripilotCellId ?? '') : '';
				resolved = {
					cellId: `cell-${idx}`,
					stableId: cell.document?.uri?.toString() ?? null,
					tripilotCellId: tripilotIdRaw ? `tripilot:${tripilotIdRaw}` : null,
					index: idx
				};
			} catch {
				// ignore
			}

			return JSON.stringify({ applied: true, filePath: uri.fsPath, affectedCell: resolved }, null, 2);
		}
		case 'create_new_jupyter_notebook': {
			await ensureSandboxDir();
			const { query } = parsed as { query: string };
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) throw new Error('No workspace folder opened.');
			const base = slugifyFileBase(String(query ?? '').slice(0, 80));
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const relDir = isAskStudy ? `${getAskStudySandbox().rel}/notebooks` : '.tripilot/notebooks';
			const relPath = `${relDir}/${base}-${stamp}.ipynb`.replace(/\\/g, '/');
			if (isAskStudy) assertRelPathInSandbox(relPath);
			const uri = resolveWorkspaceUri(relPath);
			const nb = {
				nbformat: 4,
				nbformat_minor: 5,
				metadata: {
					kernelspec: {
						name: 'python3',
						display_name: 'Python 3'
					},
					language_info: {
						name: 'python'
					}
				},
				cells: [
					{ cell_type: 'markdown', metadata: { tripilotCellId: createUuid() }, source: `# ${String(query ?? 'New Notebook').trim()}\n` },
					{
						cell_type: 'code',
						metadata: { tripilotCellId: createUuid() },
						execution_count: null,
						outputs: [],
						source:
							"# TODO: add your code here\n# Query:\n# " + String(query ?? '').trim().replace(/\r?\n/g, '\\n') + '\n'
					}
				]
			};
			const content = JSON.stringify(nb, null, 2) + '\n';

			const previews = [
				{ relativePath: relPath, uri, original: '', updated: content, editCount: 1 }
			];
			runtime?.abortSignal?.throwIfAborted?.();
			if (runtime?.requestEditsApproval) {
				const decision = await runtime.requestEditsApproval({
					previews,
					summary: { editCount: 1, fileCount: 1 },
					canPreview: true
				});
				if (decision !== 'apply') {
					return JSON.stringify({ created: false, cancelled: true, relativePath: relPath }, null, 2);
				}
			} else {
				return JSON.stringify({ created: false, cancelled: true, reason: 'no-approval-channel' }, null, 2);
			}

			await ensureParentDir(uri);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
			return JSON.stringify({ created: true, relativePath: relPath, filePath: uri.fsPath }, null, 2);
		}
		case 'runSubagent':
		case 'agent.runSubagent': {
			const { prompt, description } = parsed as { prompt: string; description: string };
			if (!runtime?.runSubagent) throw new Error('runSubagent is not available in this runtime.');
			const result = await runtime.runSubagent({ prompt: String(prompt ?? ''), description: String(description ?? '') });
			return JSON.stringify({ result }, null, 2);
		}
		case 'fetch_webpage': {
			if (isAskStudy) throw new Error('ask&study 不允许联网抓取网页（fetch_webpage）。');
			const { urls, query } = parsed as { urls: string[]; query: string };
			const list = Array.isArray(urls) ? urls.map(String).filter(Boolean) : [];
			if (!list.length) throw new Error('urls is required.');
			const q = String(query ?? '').trim();
			const items: any[] = [];
			for (const u of list.slice(0, 5)) {
				if (!isSafeHttpUrl(u)) {
					items.push({ url: u, error: 'invalid_url' });
					continue;
				}
				// Pre-approval
				const pre = await vscode.window.showWarningMessage(
					`Tripilot 将访问外部 URL：${u}`,
					{ modal: true },
					'允许一次',
					'取消'
				);
				if (pre !== '允许一次') {
					items.push({ url: u, skipped: true, reason: 'user_denied_pre_approval' });
					continue;
				}

				let fetched: { finalUrl: string; status: number; contentType?: string; text: string };
				try {
					fetched = await fetchUrlText(u, 20000);
				} catch (e) {
					items.push({ url: u, error: safeToString(e) });
					continue;
				}

				const readable = extractReadableTextFromHtml(fetched.text);
				const selected = pickRelevantText(readable, q, 20000);
				// Post-approval
				const preview = truncate(selected, 1200);
				const post = await vscode.window.showWarningMessage(
					`Tripilot 已抓取内容（预览）：\n${preview}\n\n是否将其提供给模型作为上下文？`,
					{ modal: true },
					'纳入上下文',
					'取消'
				);
				if (post !== '纳入上下文') {
					items.push({ url: u, finalUrl: fetched.finalUrl, status: fetched.status, skipped: true, reason: 'user_denied_post_approval' });
					continue;
				}

				items.push({
					url: u,
					finalUrl: fetched.finalUrl,
					status: fetched.status,
					contentType: fetched.contentType ?? null,
					content: selected
				});
			}
			return JSON.stringify({ items }, null, 2);
		}
		case 'github_repo': {
			if (isAskStudy) throw new Error('ask&study 不允许访问 GitHub（github_repo）。');
			const { repo, query } = parsed as { repo: string; query: string };
			const r = String(repo ?? '').trim();
			const q = String(query ?? '').trim();
			if (!/^[^/\s]+\/[^/\s]+$/.test(r)) throw new Error("repo must be 'owner/repo'.");
			if (!q) throw new Error('query is required.');
			const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
			const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(q + ' repo:' + r)}&per_page=5`;
			const pre = await vscode.window.showWarningMessage(
				`Tripilot 将访问 GitHub API：${apiUrl}`,
				{ modal: true },
				'允许一次',
				'取消'
			);
			if (pre !== '允许一次') {
				return JSON.stringify({ matches: [], skipped: true, reason: 'user_denied_pre_approval' }, null, 2);
			}

			let jsonText = '';
			try {
				const fetched = await fetchUrlText(apiUrl, 20000);
				jsonText = fetched.text;
			} catch (e) {
				return JSON.stringify({ matches: [], error: safeToString(e), note: 'GitHub API request failed.' }, null, 2);
			}
			let payload: any;
			try {
				payload = JSON.parse(jsonText);
			} catch {
				payload = null;
			}
			// If rate-limited without auth, tell user how to fix.
			if (!payload || payload.message) {
				return JSON.stringify(
					{
						matches: [],
						error: payload?.message ?? 'unknown_error',
						note: token
							? 'If this is a permission issue, check the token scopes.'
							: 'Tip: set GITHUB_TOKEN to improve rate limits.'
					},
					null,
					2
				);
			}
			const items = Array.isArray(payload.items) ? payload.items : [];
			const matches = items.map((it: any) => {
				const path = String(it?.path ?? '');
				const htmlUrl = String(it?.html_url ?? '');
				return { path, snippet: '', score: it?.score ?? null, url: htmlUrl };
			});
			// Post-approval: we only return minimal metadata by default.
			const post = await vscode.window.showWarningMessage(
				`Tripilot 将把 GitHub 搜索结果（${matches.length} 条）提供给模型。是否继续？`,
				{ modal: true },
				'继续',
				'取消'
			);
			if (post !== '继续') {
				return JSON.stringify({ matches: [], skipped: true, reason: 'user_denied_post_approval' }, null, 2);
			}
			return JSON.stringify({ matches }, null, 2);
		}
		case 'extensions': {
			const { query, maxResults } = parsed as { query?: string; includeDisabled?: boolean; maxResults?: number };
			const q = String(query ?? '').trim().toLowerCase();
			const limit = typeof maxResults === 'number' ? Math.max(1, Math.min(500, maxResults)) : 200;
			const all = vscode.extensions.all ?? [];
			const list = all
				.map((e) => ({
					id: e.id,
					displayName: e.packageJSON?.displayName ?? e.id,
					isActive: Boolean(e.isActive)
				}))
				.filter((e) => (q ? e.id.toLowerCase().includes(q) || String(e.displayName).toLowerCase().includes(q) : true))
				.slice(0, limit);
			return JSON.stringify({ count: list.length, extensions: list }, null, 2);
		}
		case 'install_extension': {
			if (isAskStudy) throw new Error('ask&study 不允许安装扩展（install_extension）。');
			const { id, name } = parsed as { id: string; name: string };
			const extId = String(id ?? '').trim();
			if (!extId) throw new Error('id is required.');
			const ok = await vscode.window.showWarningMessage(
				`Tripilot 请求安装扩展：${String(name ?? extId)} (${extId})`,
				{ modal: true },
				'安装',
				'取消'
			);
			if (ok !== '安装') {
				return JSON.stringify({ status: 'needs-user-action', message: 'User cancelled.' }, null, 2);
			}
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', extId);
				return JSON.stringify({ status: 'installed', id: extId }, null, 2);
			} catch (e) {
				return JSON.stringify({ status: 'failed', id: extId, message: safeToString(e) }, null, 2);
			}
		}
		case 'vscode_searchExtensions_internal': {
			if (isAskStudy) throw new Error('ask&study 不允许搜索/安装扩展（vscode_searchExtensions_internal）。');
			const { keywords, ids } = parsed as { category?: string; keywords?: string[]; ids?: string[] };
			const kw = Array.isArray(keywords) ? keywords.map(String).filter(Boolean) : [];
			const known = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
			if (known.length) {
				return JSON.stringify({ results: known.map((id) => ({ id })) }, null, 2);
			}
			const term = kw.join(' ').trim();
			if (!term) return JSON.stringify({ results: [] }, null, 2);
			try {
				await vscode.commands.executeCommand('workbench.extensions.search', term);
			} catch {
				// ignore
			}
			return JSON.stringify({ note: 'Opened Extensions search UI (best-effort).', term }, null, 2);
		}
		case 'open_simple_browser': {
			const { url } = parsed as { url: string };
			const u = String(url ?? '').trim();
			if (!isSafeHttpUrl(u)) throw new Error('Only http(s) URLs are supported.');
			try {
				await vscode.commands.executeCommand('simpleBrowser.show', u);
				return 'ok';
			} catch {
				await vscode.env.openExternal(vscode.Uri.parse(u));
				return 'ok';
			}
		}
		case 'run_vscode_command': {
			const { commandId, args } = parsed as { commandId: string; name?: string; args?: string[] };
			const id = String(commandId ?? '').trim();
			if (!id) throw new Error('commandId is required.');
			if (isAskStudy && !ASK_STUDY_ALLOWED_VSCODE_COMMAND_IDS.has(id)) {
				throw new Error(`ask&study 不允许执行 VS Code command：${id}`);
			}
			const a = Array.isArray(args) ? args.map(String) : [];
			const result = await vscode.commands.executeCommand(id as any, ...a);
			return safeToString(result);
		}
		case 'run_command': {
			const { commandId, args } = parsed as { commandId: string; args?: string[] };
			const id = String(commandId ?? '').trim();
			if (!id) throw new Error('commandId is required.');
			return await executeToolCall(
				'run_vscode_command',
				{ commandId: id, name: `run ${id}`, args: Array.isArray(args) ? args.map(String) : [] },
				runtime
			);
		}
		case 'create_new_workspace': {
			await ensureSandboxDir();
			if (isAskStudy) throw new Error('ask&study 不允许创建新 workspace（create_new_workspace）。');
			const { query } = parsed as { query: string };
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) throw new Error('No workspace folder opened.');
			const q = String(query ?? '').trim();
			const base = slugifyFileBase(q.slice(0, 80));
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const rootRel = `.tripilot/workspaces/${base}-${stamp}`;
			const files: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }> = [];

			const readmeRel = `${rootRel}/README.md`;
			const readmeUri = resolveWorkspaceUri(readmeRel);
			const readme = `# ${q || 'New Workspace'}\n\nGenerated by Tripilot.\n\n## Next steps\n- Review files\n- Install deps (if any)\n`;
			files.push({ relativePath: readmeRel, uri: readmeUri, original: '', updated: readme, editCount: 1 });

			// Simple heuristic: Node/TS project skeleton.
			const looksNode = /node|npm|typescript|ts|vite|react|next/i.test(q);
			if (looksNode) {
				const pkgRel = `${rootRel}/package.json`;
				const pkgUri = resolveWorkspaceUri(pkgRel);
				const pkg = {
					name: base,
					private: true,
					version: '0.0.0',
					scripts: {
						build: 'tsc -p tsconfig.json',
						start: 'node dist/index.js'
					}
				};
				files.push({ relativePath: pkgRel, uri: pkgUri, original: '', updated: JSON.stringify(pkg, null, 2) + '\n', editCount: 1 });
				const tsRel = `${rootRel}/tsconfig.json`;
				const tsUri = resolveWorkspaceUri(tsRel);
				const tsconfig = {
					compilerOptions: {
						target: 'ES2020',
						module: 'CommonJS',
						outDir: 'dist',
						strict: true
					},
					include: ['src']
				};
				files.push({ relativePath: tsRel, uri: tsUri, original: '', updated: JSON.stringify(tsconfig, null, 2) + '\n', editCount: 1 });
				const idxRel = `${rootRel}/src/index.ts`;
				const idxUri = resolveWorkspaceUri(idxRel);
				files.push({ relativePath: idxRel, uri: idxUri, original: '', updated: `console.log('hello from ${base}');\n`, editCount: 1 });
			}

			runtime?.abortSignal?.throwIfAborted?.();
			if (runtime?.requestEditsApproval) {
				const decision = await runtime.requestEditsApproval({
					previews: files,
					summary: { editCount: files.reduce((n, f) => n + f.editCount, 0), fileCount: files.length },
					canPreview: true
				});
				if (decision !== 'apply') {
					return JSON.stringify({ created: false, cancelled: true, root: rootRel }, null, 2);
				}
			} else {
				return JSON.stringify({ created: false, cancelled: true, reason: 'no-approval-channel' }, null, 2);
			}

			for (const f of files) {
				await ensureParentDir(f.uri);
				await vscode.workspace.fs.writeFile(f.uri, Buffer.from(f.updated, 'utf8'));
			}
			return JSON.stringify({ created: true, root: rootRel }, null, 2);
		}
		case 'new_workspace': {
			await ensureSandboxDir();
			if (isAskStudy) throw new Error('ask&study 不允许创建新 workspace（new_workspace）。');
			const { name: rawName, directory: rawDir, template: rawTemplate } = parsed as {
				name: string;
				directory?: string;
				template?: string;
				openInNewWindow?: boolean;
			};
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) throw new Error('No workspace folder opened.');
			const nameStr = String(rawName ?? '').trim();
			if (!nameStr) throw new Error('name is required.');
			const templateStr = String(rawTemplate ?? '').trim();
			const dirStr = String(rawDir ?? '').trim();

			const base = slugifyFileBase(nameStr.slice(0, 80));
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const safeDir = slugifyFileBase(dirStr.replace(/[/\\]+/g, '-').replace(/\.+/g, '').slice(0, 40));
			const rootRel = safeDir ? `.tripilot/workspaces/${safeDir}/${base}-${stamp}` : `.tripilot/workspaces/${base}-${stamp}`;
			const files: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }> = [];

			const readmeRel = `${rootRel}/README.md`;
			const readmeUri = resolveWorkspaceUri(readmeRel);
			const readme = `# ${nameStr}\n\nGenerated by Tripilot.\n\n## Template\n${templateStr || 'unknown'}\n`;
			files.push({ relativePath: readmeRel, uri: readmeUri, original: '', updated: readme, editCount: 1 });

			const looksNode = /node|npm|typescript|ts|vite|react|next/i.test(`${templateStr} ${nameStr}`);
			if (looksNode) {
				const pkgRel = `${rootRel}/package.json`;
				const pkgUri = resolveWorkspaceUri(pkgRel);
				const pkg = {
					name: base,
					private: true,
					version: '0.0.0',
					scripts: {
						build: 'tsc -p tsconfig.json',
						start: 'node dist/index.js'
					}
				};
				files.push({ relativePath: pkgRel, uri: pkgUri, original: '', updated: JSON.stringify(pkg, null, 2) + '\n', editCount: 1 });
				const tsRel = `${rootRel}/tsconfig.json`;
				const tsUri = resolveWorkspaceUri(tsRel);
				const tsconfig = {
					compilerOptions: {
						target: 'ES2020',
						module: 'CommonJS',
						outDir: 'dist',
						strict: true
					},
					include: ['src']
				};
				files.push({ relativePath: tsRel, uri: tsUri, original: '', updated: JSON.stringify(tsconfig, null, 2) + '\n', editCount: 1 });
				const idxRel = `${rootRel}/src/index.ts`;
				const idxUri = resolveWorkspaceUri(idxRel);
				files.push({ relativePath: idxRel, uri: idxUri, original: '', updated: `console.log('hello from ${base}');\n`, editCount: 1 });
			}

			runtime?.abortSignal?.throwIfAborted?.();
			if (runtime?.requestEditsApproval) {
				const decision = await runtime.requestEditsApproval({
					previews: files,
					summary: { editCount: files.reduce((n, f) => n + f.editCount, 0), fileCount: files.length },
					canPreview: true
				});
				if (decision !== 'apply') {
					return JSON.stringify({ created: false, cancelled: true, root: rootRel }, null, 2);
				}
			} else {
				return JSON.stringify({ created: false, cancelled: true, reason: 'no-approval-channel' }, null, 2);
			}

			for (const f of files) {
				await ensureParentDir(f.uri);
				await vscode.workspace.fs.writeFile(f.uri, Buffer.from(f.updated, 'utf8'));
			}
			return JSON.stringify({ created: true, root: rootRel }, null, 2);
		}
		case 'get_project_setup_info': {
			const { projectType } = parsed as { projectType: string };
			const t = String(projectType ?? 'other');
			const info: any = { projectType: t, detected: [], install: [], build: [], test: [], run: [], notes: [] };
			if (t === 'python-script') {
				info.install.push('python -m pip install -r requirements.txt');
				info.run.push('python main.py');
				info.test.push('pytest');
			} else if (t === 'python-project') {
				info.install.push('python -m pip install -e .');
				info.test.push('pytest');
			} else if (t === 'vscode-extension') {
				info.install.push('npm install');
				info.build.push('npm run compile');
				info.run.push('Press F5 to launch Extension Development Host');
			} else if (t === 'vite') {
				info.install.push('npm install');
				info.run.push('npm run dev');
				info.build.push('npm run build');
			} else if (t === 'next-js') {
				info.install.push('npm install');
				info.run.push('npm run dev');
				info.build.push('npm run build');
			} else {
				info.notes.push('Unknown projectType; provide manual setup instructions.');
			}
			return JSON.stringify(info, null, 2);
		}
		case 'get_vscode_api': {
			const { query } = parsed as { query: string };
			const q = String(query ?? '').trim();
			if (!q) throw new Error('query is required.');
			// Best-effort offline search in vscode type defs.
			const candidates = await vscode.workspace.findFiles(
				'**/{node_modules/vscode/vscode.d.ts,node_modules/@types/vscode/index.d.ts}',
				undefined,
				5
			);
			if (!candidates.length) {
				return JSON.stringify({ answer: '', sources: [], note: 'No local vscode.d.ts found. Try open_simple_browser https://code.visualstudio.com/api' }, null, 2);
			}
			const uri = candidates[0];
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(bytes).toString('utf8');
			const tokens = q
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length >= 3)
				.slice(0, 4);
			const re = new RegExp(tokens.map(escapeRegExp).join('|'), 'i');
			const lines = text.split(/\r?\n/);
			const hits: Array<{ line: number; snippet: string }> = [];
			for (let i = 0; i < lines.length; i++) {
				if (re.test(lines[i])) {
					const start = Math.max(0, i - 2);
					const end = Math.min(lines.length, i + 3);
					hits.push({ line: i + 1, snippet: lines.slice(start, end).join('\n') });
					if (hits.length >= 8) break;
				}
			}
			return JSON.stringify(
				{
					answer: hits.length ? 'Found relevant API declarations in local vscode.d.ts.' : 'No direct matches found in local vscode.d.ts.',
					sources: [{ filePath: toWorkspaceRelativePosix(uri) || uri.fsPath, hits }]
				},
				null,
				2
			);
		}
		case 'vscode_api': {
			const { query } = parsed as { query: string; version?: string };
			return await executeToolCall('get_vscode_api', { query }, runtime);
		}
		case 'list_code_usages': {
			const { symbolName, filePaths } = parsed as { symbolName: string; filePaths?: string[] };
			const s = String(symbolName ?? '').trim();
			if (!s) throw new Error('symbolName is required.');
			const includePattern = Array.isArray(filePaths) && filePaths.length ? `{${filePaths.map((p) => String(p).replace(/\\/g, '/')).join(',')}}` : undefined;
			const results = await findInFiles({
				pattern: `\\b${escapeRegExp(s)}\\b`,
				isRegExp: true,
				isCaseSensitive: false,
				isWordMatch: false,
				include: includePattern,
				exclude: '**/node_modules/**',
				maxResults: 80
			});
			return JSON.stringify({ symbolName: s, results }, null, 2);
		}
		case 'semantic_search': {
			const { query } = parsed as { query: string };
			const q = String(query ?? '').trim();
			if (!q) throw new Error('query is required.');
			const tokens = q
				.toLowerCase()
				.split(/[^a-z0-9\u4e00-\u9fff]+/)
				.filter((t) => t.length >= 3)
				.slice(0, 6);
			const merged: any[] = [];
			for (const t of tokens.length ? tokens : [q]) {
				const r = await findInFiles({
					pattern: escapeRegExp(t),
					isRegExp: false,
					isCaseSensitive: false,
					isWordMatch: false,
					exclude: '**/node_modules/**',
					maxResults: 30
				});
				merged.push(...r);
				if (merged.length >= 80) break;
			}
			return JSON.stringify({ query: q, results: merged.slice(0, 80) }, null, 2);
		}

		case 'editor_getActiveDocument': {
			const editor = vscode.window.activeTextEditor;
			if (!editor) throw new Error('No active editor.');
			const doc = editor.document;
			const includeText = Boolean(parsed?.includeText);
			const maxChars = typeof parsed?.maxChars === 'number' ? parsed.maxChars : 20000;
			const startLine = typeof parsed?.startLine === 'number' ? parsed.startLine : undefined;
			const endLine = typeof parsed?.endLine === 'number' ? parsed.endLine : undefined;

			let text: string | undefined;
			if (includeText) {
				if (startLine && endLine && startLine >= 1 && endLine >= startLine) {
					const start = new vscode.Position(startLine - 1, 0);
					const end = new vscode.Position(endLine - 1, doc.lineAt(endLine - 1).text.length);
					text = doc.getText(new vscode.Range(start, end));
				} else {
					text = doc.getText();
				}
				if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
			}

			return JSON.stringify(
				{
					uri: doc.uri.toString(),
					fsPath: doc.uri.fsPath,
					languageId: doc.languageId,
					isDirty: doc.isDirty,
					text
				},
				null,
				2
			);
		}
		case 'editor_getSelection': {
			const editor = vscode.window.activeTextEditor;
			if (!editor) throw new Error('No active editor.');
			const maxChars = typeof parsed?.maxChars === 'number' ? parsed.maxChars : 20000;
			const sel = editor.selection;
			const doc = editor.document;
			let text = doc.getText(sel);
			if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
			return JSON.stringify(
				{
					uri: doc.uri.toString(),
					fsPath: doc.uri.fsPath,
					languageId: doc.languageId,
					range: {
						startLine: sel.start.line + 1,
						startCharacter: sel.start.character + 1,
						endLine: sel.end.line + 1,
						endCharacter: sel.end.character + 1
					},
					text
				},
				null,
				2
			);
		}
		case 'workspace_listFiles': {
			const { relativeDir, recursive } = parsed as { relativeDir: string; recursive?: boolean };
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) throw new Error('No workspace folder opened.');
			const base = vscode.Uri.joinPath(folder.uri, relativeDir);
			const entries: string[] = [];
			await listDir(base, relativeDir, Boolean(recursive), entries);
			return JSON.stringify({ entries }, null, 2);
		}
		case 'workspace_readFile': {
			const { relativePath } = parsed as { relativePath: string };
			const uri = resolveWorkspaceUri(relativePath);
			const bytes = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(bytes).toString('utf8');
		}
		case 'workspace_writeFile': {
			await ensureSandboxDir();
			const { relativePath, content } = parsed as { relativePath: string; content: string };
			assertRelPathInSandbox(relativePath);
			const uri = resolveWorkspaceUri(relativePath);
			await ensureParentDir(uri);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
			return 'ok';
		}
		case 'workspace_findInFiles': {
			const {
				pattern,
				isRegExp,
				isCaseSensitive,
				isWordMatch,
				include,
				exclude,
				maxResults
			} = parsed as {
				pattern: string;
				isRegExp?: boolean;
				isCaseSensitive?: boolean;
				isWordMatch?: boolean;
				include?: string;
				exclude?: string;
				maxResults?: number;
			};

			const results = await findInFiles({
				pattern,
				isRegExp: Boolean(isRegExp),
				isCaseSensitive: Boolean(isCaseSensitive),
				isWordMatch: Boolean(isWordMatch),
				include,
				exclude,
				maxResults: typeof maxResults === 'number' ? maxResults : 50
			});

			return JSON.stringify(results, null, 2);
		}
		case 'workspace_applyEdits': {
			await ensureSandboxDir();
			const { edits, requireConfirmation, allowPreview } = parsed as {
				edits: Array<{
					relativePath: string;
					startLine: number;
					startCharacter: number;
					endLine: number;
					endCharacter: number;
					newText: string;
				}>;
				requireConfirmation?: boolean;
				allowPreview?: boolean;
			};
			if (!Array.isArray(edits) || edits.length === 0) return 'no-edits';
			for (const e of edits) {
				assertRelPathInSandbox(e.relativePath);
			}

			const grouped = groupEditsByFile(edits);
			const requireConfirm = requireConfirmation !== false;
			const canPreview = allowPreview !== false;

			// Build previews (best-effort) so users can inspect changes before applying.
			const previews: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }> = [];
			for (const [relativePath, fileEdits] of grouped) {
				const uri = resolveWorkspaceUri(relativePath);
				let original = '';
				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					original = Buffer.from(bytes).toString('utf8');
				} catch {
					// treat as new file
					original = '';
				}
				const updated = applyTextEditsToString(original, fileEdits);
				previews.push({ relativePath, uri, original, updated, editCount: fileEdits.length });
			}

			if (requireConfirm) {
				const fileCount = previews.length;
				const editCount = edits.length;
				runtime?.abortSignal?.throwIfAborted?.();
				if (runtime?.requestEditsApproval) {
					const decision = await runtime.requestEditsApproval({
						previews,
						summary: { editCount, fileCount },
						canPreview
					});
					if (decision !== 'apply') {
						return JSON.stringify({ applied: false, cancelled: true, editCount, fileCount }, null, 2);
					}
				} else {
					// Fallback if no approval channel.
					return JSON.stringify({ applied: false, cancelled: true, editCount, fileCount }, null, 2);
				}
			}

			const we = new vscode.WorkspaceEdit();
			for (const e of edits) {
				const uri = resolveWorkspaceUri(e.relativePath);
				const range = new vscode.Range(
					new vscode.Position(Math.max(0, e.startLine - 1), Math.max(0, e.startCharacter - 1)),
					new vscode.Position(Math.max(0, e.endLine - 1), Math.max(0, e.endCharacter - 1))
				);
				we.replace(uri, range, e.newText);
			}
			const ok = await vscode.workspace.applyEdit(we);
			return JSON.stringify({ applied: ok, editCount: edits.length, fileCount: grouped.size }, null, 2);
		}
		case 'diagnostics_list': {
			const { relativePath, maxItems } = parsed as { relativePath?: string; maxItems?: number };
			const limit = typeof maxItems === 'number' ? maxItems : 200;

			let tuples: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
			if (relativePath) {
				const uri = resolveWorkspaceUri(relativePath);
				tuples = [[uri, vscode.languages.getDiagnostics(uri)]];
			} else {
				tuples = vscode.languages.getDiagnostics();
			}

			const items: any[] = [];
			for (const [uri, diags] of tuples) {
				for (const d of diags) {
					items.push({
						uri: uri.toString(),
						fsPath: uri.fsPath,
						severity: severityToString(d.severity),
						message: d.message,
						source: d.source ?? null,
						code: typeof d.code === 'string' || typeof d.code === 'number' ? d.code : d.code?.value ?? null,
						range: {
							startLine: d.range.start.line + 1,
							startCharacter: d.range.start.character + 1,
							endLine: d.range.end.line + 1,
							endCharacter: d.range.end.character + 1
						}
					});
					if (items.length >= limit) break;
				}
				if (items.length >= limit) break;
			}

			return JSON.stringify({ count: items.length, items }, null, 2);
		}
		case 'vscode_executeCommand': {
			const { command, args } = parsed as { command: string; args?: any[] };
			if (isAskStudy && !ASK_STUDY_ALLOWED_VSCODE_COMMAND_IDS.has(String(command))) {
				throw new Error(`ask&study 不允许直接执行 VS Code command：${String(command)}`);
			}
			const result = await vscode.commands.executeCommand(command, ...(Array.isArray(args) ? args : []));
			return JSON.stringify({ result: result ?? null }, null, 2);
		}
		case 'terminal_run': {
			await ensureSandboxDir();
			const { command } = parsed as { command: string; shell?: string };
			// VS Code API does not offer reliable output capture from terminals.
			// Best-effort: run as a task-less terminal command; return acknowledgment.
			const term = isAskStudy
				? vscode.window.createTerminal({ name: 'Tripilot (ask&study)', cwd: getAskStudySandbox().uri.fsPath })
				: vscode.window.createTerminal({ name: 'Tripilot' });
			term.show(true);
			term.sendText(command, true);
			return 'sent-to-terminal';
		}
		case 'process_run': {
			const { command, args, cwd, timeoutMs, maxOutputChars } = parsed as {
				command: string;
				args?: string[];
				cwd?: string;
				timeoutMs?: number;
				maxOutputChars?: number;
			};
			const folder = vscode.workspace.workspaceFolders?.[0];
			const execCwd = folder
				? isAskStudy
					? resolveCwdFsPathForAskStudy(cwd)
					: cwd
						? vscode.Uri.joinPath(folder.uri, cwd).fsPath
						: folder.uri.fsPath
				: undefined;

			const execFileAsync = promisify(execFile);
			try {
				const { stdout, stderr } = await execFileAsync(command, Array.isArray(args) ? args : [], {
					cwd: execCwd,
					timeout: typeof timeoutMs === 'number' ? timeoutMs : 60000,
					maxBuffer: 10 * 1024 * 1024
				});
				return JSON.stringify(
					{
						exitCode: 0,
						stdout: truncate(stdout ?? '', typeof maxOutputChars === 'number' ? maxOutputChars : 60000),
						stderr: truncate(stderr ?? '', typeof maxOutputChars === 'number' ? maxOutputChars : 60000)
					},
					null,
					2
				);
			} catch (err: any) {
				// execFile throws on non-zero exit code; capture what we can.
				return JSON.stringify(
					{
						exitCode: typeof err?.code === 'number' ? err.code : err?.code ?? null,
						stdout: truncate(err?.stdout ?? '', typeof maxOutputChars === 'number' ? maxOutputChars : 60000),
						stderr: truncate(err?.stderr ?? String(err), typeof maxOutputChars === 'number' ? maxOutputChars : 60000)
					},
					null,
					2
				);
			}
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

function resolveWorkspaceUri(relativePath: string): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) throw new Error('No workspace folder opened.');
	return vscode.Uri.joinPath(folder.uri, relativePath);
}

function safeOneLine(text: string, maxLen = 300): string {
	const s = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function truncate(text: string, maxChars: number): string {
	const s = String(text ?? '');
	return s.length > maxChars ? s.slice(0, maxChars) + '\n…(truncated)' : s;
}

function severityToString(sev: vscode.DiagnosticSeverity): string {
	switch (sev) {
		case vscode.DiagnosticSeverity.Error:
			return 'Error';
		case vscode.DiagnosticSeverity.Warning:
			return 'Warning';
		case vscode.DiagnosticSeverity.Information:
			return 'Information';
		case vscode.DiagnosticSeverity.Hint:
			return 'Hint';
		default:
			return String(sev);
	}
}

function groupEditsByFile(
	edits: Array<{
		relativePath: string;
		startLine: number;
		startCharacter: number;
		endLine: number;
		endCharacter: number;
		newText: string;
	}>
): Map<string, Array<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }>> {
	const map = new Map<
		string,
		Array<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }>
	>();
	for (const e of edits) {
		const arr = map.get(e.relativePath) ?? [];
		arr.push({
			startLine: e.startLine,
			startCharacter: e.startCharacter,
			endLine: e.endLine,
			endCharacter: e.endCharacter,
			newText: e.newText
		});
		map.set(e.relativePath, arr);
	}
	return map;
}

function applyTextEditsToString(
	original: string,
	edits: Array<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }>
): string {
	// Convert 1-based (line, char) to absolute offsets, then apply from back to front.
	const lineStarts = computeLineStarts(original);
	const normalized = edits
		.map((e) => {
			const start = positionToOffset(lineStarts, e.startLine, e.startCharacter);
			const end = positionToOffset(lineStarts, e.endLine, e.endCharacter);
			return { start, end, newText: e.newText };
		})
		.sort((a, b) => b.start - a.start);

	let text = original;
	for (const e of normalized) {
		if (e.start > e.end || e.start < 0 || e.end < 0 || e.start > text.length || e.end > text.length) {
			continue;
		}
		text = text.slice(0, e.start) + e.newText + text.slice(e.end);
	}
	return text;
}

function computeLineStarts(text: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') starts.push(i + 1);
	}
	return starts;
}

function positionToOffset(lineStarts: number[], line1: number, char1: number): number {
	const line = Math.max(1, line1);
	const ch = Math.max(1, char1);
	const lineIndex = Math.min(lineStarts.length, line) - 1;
	const lineStart = lineStarts[lineIndex] ?? 0;
	return lineStart + (ch - 1);
}

async function previewEditsInDiff(
	previews: Array<{ relativePath: string; uri: vscode.Uri; original: string; updated: string; editCount: number }>
) {
	for (const p of previews) {
		let language = undefined as string | undefined;
		try {
			const doc = await vscode.workspace.openTextDocument(p.uri);
			language = doc.languageId;
		} catch {
			// ignore
		}
		const modified = await vscode.workspace.openTextDocument({ content: p.updated, language });
		await vscode.commands.executeCommand(
			'vscode.diff',
			p.uri,
			modified.uri,
			`Tripilot Preview: ${p.relativePath} (${p.editCount} edit(s))`
		);
	}
}

async function ensureParentDir(uri: vscode.Uri) {
	// vscode.Uri.path is POSIX-style. Compute dirname safely.
	const parentPath = uri.path.replace(/\/[^/]*$/, '') || '/';
	const parent = uri.with({ path: parentPath });
	try {
		await vscode.workspace.fs.createDirectory(parent);
	} catch {
		// ignore
	}
}

async function findInFiles(args: {
	pattern: string;
	isRegExp: boolean;
	isCaseSensitive: boolean;
	isWordMatch: boolean;
	include?: string;
	exclude?: string;
	maxResults: number;
}): Promise<any> {
	const include = args.include && args.include.trim().length > 0 ? args.include : '**/*';
	const exclude = args.exclude && args.exclude.trim().length > 0 ? args.exclude : '**/node_modules/**';
	const uris = await vscode.workspace.findFiles(include, exclude);

	const results: Array<{
		uri: string;
		fsPath: string;
		preview: string;
		ranges: Array<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number }>;
	}> = [];

	const maxResults = Math.max(1, args.maxResults);
	const maxBytesPerFile = 1024 * 1024; // 1MB safety cap

	const needle = args.isCaseSensitive ? args.pattern : args.pattern.toLowerCase();
	let regex: RegExp | undefined;
	if (args.isRegExp) {
		const flags = `${args.isCaseSensitive ? '' : 'i'}g`;
		try {
			regex = new RegExp(args.pattern, flags);
		} catch (e) {
			throw new Error(`Invalid RegExp pattern: ${String(e)}`);
		}
	}

	for (const uri of uris) {
		if (results.length >= maxResults) break;
		let stat: vscode.FileStat;
		try {
			stat = await vscode.workspace.fs.stat(uri);
		} catch {
			continue;
		}
		if (stat.size > maxBytesPerFile) continue;

		let text: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			text = Buffer.from(bytes).toString('utf8');
		} catch {
			continue;
		}

		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			if (results.length >= maxResults) break;
			const line = lines[i];
			const hay = args.isCaseSensitive ? line : line.toLowerCase();

			if (args.isRegExp && regex) {
				regex.lastIndex = 0;
				const ranges: Array<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number }> = [];
				let m: RegExpExecArray | null;
				while ((m = regex.exec(line)) !== null) {
					const start = m.index;
					const end = m.index + (m[0]?.length ?? 0);
					if (args.isWordMatch && !isWordBoundaryMatch(line, start, end)) {
						if (m[0]?.length === 0) regex.lastIndex++;
						continue;
					}
					ranges.push({
						startLine: i + 1,
						startCharacter: start + 1,
						endLine: i + 1,
						endCharacter: end + 1
					});
					if (ranges.length >= 5) break;
					if (m[0]?.length === 0) regex.lastIndex++;
				}
				if (ranges.length > 0) {
					results.push({
						uri: uri.toString(),
						fsPath: uri.fsPath,
						preview: line,
						ranges
					});
				}
				continue;
			}

			// plain string search
			let idx = hay.indexOf(needle);
			if (idx === -1) continue;
			const end = idx + needle.length;
			if (args.isWordMatch && !isWordBoundaryMatch(line, idx, end)) continue;

			results.push({
				uri: uri.toString(),
				fsPath: uri.fsPath,
				preview: line,
				ranges: [
					{
						startLine: i + 1,
						startCharacter: idx + 1,
						endLine: i + 1,
						endCharacter: end + 1
					}
				]
			});
		}
	}

	return { count: results.length, results, scannedFiles: uris.length };
}

function isWordBoundaryMatch(line: string, start: number, end: number): boolean {
	const isWordChar = (ch: string | undefined) => (ch ? /[A-Za-z0-9_]/.test(ch) : false);
	const before = start > 0 ? line[start - 1] : undefined;
	const after = end < line.length ? line[end] : undefined;
	return !isWordChar(before) && !isWordChar(after);
}

async function listDir(dir: vscode.Uri, rel: string, recursive: boolean, out: string[]) {
	let items: [string, vscode.FileType][];
	try {
		items = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return;
	}

	for (const [name, type] of items) {
		const childRel = rel.replace(/\\/g, '/').replace(/\/$/, '') + '/' + name;
		out.push(childRel);
		if (recursive && type === vscode.FileType.Directory) {
			await listDir(vscode.Uri.joinPath(dir, name), childRel, recursive, out);
		}
	}
}


