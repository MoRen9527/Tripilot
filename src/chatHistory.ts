import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';

export type ChatHistoryEvent =
	| {
			kind: 'session_start';
			ts: string;
			sessionId: string;
			workspace?: { name: string; pathHash: string };
			profileId: string;
			modelId?: string;
	  }
	| {
			kind: 'session_title';
			ts: string;
			sessionId: string;
			title: string;
			source: 'ai' | 'heuristic';
			profileId: string;
			modelId?: string;
	  }
	| {
			kind: 'user_message';
			ts: string;
			sessionId: string;
			text: string;
			profileId: string;
			modelId?: string;
	  }
	| {
			kind: 'assistant_message';
			ts: string;
			sessionId: string;
			text: string;
			profileId: string;
			modelId?: string;
	  }
	| {
			kind: 'tool_trace';
			ts: string;
			sessionId: string;
			text: string;
			profileId: string;
			modelId?: string;
	  }
	| {
			kind: 'approval_request';
			ts: string;
			sessionId: string;
			requestId: string;
			summary: { editCount: number; fileCount: number };
			files: Array<{ relativePath: string; editCount: number }>;
			profileId: string;
			modelId?: string;
	  }
	| {
			kind: 'approval_decision';
			ts: string;
			sessionId: string;
			requestId: string;
			decision: 'apply' | 'cancel';
			profileId: string;
			modelId?: string;
	  }
	| {
			kind: 'error';
			ts: string;
			sessionId: string;
			message: string;
			profileId: string;
			modelId?: string;
	  };

export type ChatSessionMeta = {
	profileId: string;
	modelId?: string;
	workspaceFolder?: vscode.WorkspaceFolder;
};

export interface ChatHistoryStore {
	startSession(meta: ChatSessionMeta): Promise<string>;
	append(event: ChatHistoryEvent): Promise<void>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function hashText(value: string): string {
	return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function getWorkspaceInfo(folder?: vscode.WorkspaceFolder): { name: string; pathHash: string } | undefined {
	if (!folder) return undefined;
	const name = folder.name;
	// Store only a hash of the local path to avoid leaking absolute paths.
	const pathHash = hashText(folder.uri.fsPath);
	return { name, pathHash };
}

export class JsonlChatHistoryStore implements ChatHistoryStore {
	private readonly dirFsPath: string;
	private currentSessionId?: string;
	private currentFileFsPath?: string;

	constructor(storageBaseUri: vscode.Uri) {
		this.dirFsPath = storageBaseUri.fsPath;
	}

	public async startSession(meta: ChatSessionMeta): Promise<string> {
		await mkdir(this.dirFsPath, { recursive: true });
		const sessionId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
		this.currentSessionId = sessionId;
		this.currentFileFsPath = path.join(this.dirFsPath, `${sessionId}.jsonl`);

		await this.append({
			kind: 'session_start',
			ts: nowIso(),
			sessionId,
			workspace: getWorkspaceInfo(meta.workspaceFolder),
			profileId: meta.profileId,
			modelId: meta.modelId
		});

		return sessionId;
	}

	public async resumeSession(sessionId: string): Promise<void> {
		await mkdir(this.dirFsPath, { recursive: true });
		const normalized = String(sessionId || '').trim();
		if (!normalized) return;
		this.currentSessionId = normalized;
		this.currentFileFsPath = path.join(this.dirFsPath, `${normalized}.jsonl`);
	}

	public async append(event: ChatHistoryEvent): Promise<void> {
		if (!this.currentSessionId || !this.currentFileFsPath) {
			// If a consumer forgot to start a session, ignore safely.
			return;
		}
		const line = JSON.stringify(event) + '\n';
		await appendFile(this.currentFileFsPath, line, { encoding: 'utf8' });
	}
}
