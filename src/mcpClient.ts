import * as vscode from 'vscode';

export type McpServerTransport = 'stdio' | 'http' | 'websocket' | 'sse';

export type McpServerConfig = {
	id: string;
	name: string;
	enabled: boolean;
	transport: McpServerTransport;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
};

export type McpServerStatus = {
	id: string;
	name: string;
	enabled: boolean;
	transport: McpServerTransport;
	status: 'disconnected' | 'connecting' | 'connected' | 'error';
	toolCount: number;
	lastError?: string;
};

export type McpToolInfo = {
	serverId: string;
	serverName: string;
	toolName: string;
	description?: string;
	inputSchema?: any;
	lmToolName: string;
};

type McpRuntime = {
	config: McpServerConfig;
	status: McpServerStatus['status'];
	lastError?: string;
	client?: any;
	transport?: any;
	tools: McpToolInfo[];
};

function safeIdPart(s: string): string {
	return String(s).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

export function makeMcpLmToolName(serverId: string, toolName: string): string {
	return `mcp__${safeIdPart(serverId)}__${safeIdPart(toolName)}`;
}

export class McpClientManager implements vscode.Disposable {
	private readonly runtimes = new Map<string, McpRuntime>();
	private disposed = false;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;

	constructor(private readonly output: vscode.OutputChannel) {}

	dispose() {
		this.disposed = true;
		this._onDidChange.dispose();
		for (const rt of this.runtimes.values()) {
			void this.disconnect(rt.config.id);
		}
		this.runtimes.clear();
	}

	public getStatuses(configs: McpServerConfig[]): McpServerStatus[] {
		return configs
			.map((c) => {
				const rt = this.runtimes.get(c.id);
				return {
					id: c.id,
					name: c.name,
					enabled: c.enabled,
					transport: c.transport,
					status: rt?.status ?? 'disconnected',
					toolCount: rt?.tools?.length ?? 0,
					lastError: rt?.lastError
				} as McpServerStatus;
			})
			.filter((s) => s.id && s.name);
	}

	public getToolsForEnabledServers(enabledServerIds: Set<string>): McpToolInfo[] {
		const out: McpToolInfo[] = [];
		for (const [id, rt] of this.runtimes) {
			if (!enabledServerIds.has(id)) continue;
			out.push(...(rt.tools ?? []));
		}
		return out;
	}

	public async refresh(configs: McpServerConfig[]): Promise<void> {
		if (this.disposed) return;
		const desired = new Map<string, McpServerConfig>();
		for (const c of configs) {
			if (!c?.id) continue;
			desired.set(c.id, c);
		}

		// Disconnect removed servers.
		for (const id of Array.from(this.runtimes.keys())) {
			if (!desired.has(id)) {
				await this.disconnect(id);
				this.runtimes.delete(id);
			}
		}

		// Update configs and connect enabled.
		for (const c of desired.values()) {
			const existing = this.runtimes.get(c.id);
			if (!existing) {
				this.runtimes.set(c.id, { config: c, status: 'disconnected', tools: [] });
			} else {
				existing.config = c;
			}
			if (c.enabled) {
				void this.ensureConnected(c.id);
			} else {
				await this.disconnect(c.id);
			}
		}
		this._onDidChange.fire();
	}

	public async ensureConnected(serverId: string): Promise<void> {
		if (this.disposed) return;
		const rt = this.runtimes.get(serverId);
		if (!rt) return;
		if (rt.status === 'connected' || rt.status === 'connecting') return;

		rt.status = 'connecting';
		rt.lastError = undefined;
		this._onDidChange.fire();

		try {
			const { client, transport } = await this.createClientAndTransport(rt.config);
			rt.client = client;
			rt.transport = transport;

			await client.connect(transport);
			const list = await client.listTools();
			const tools = Array.isArray(list?.tools) ? list.tools : [];

			rt.tools = tools.map((t: any) => {
				const toolName = String(t?.name ?? '');
				return {
					serverId: rt.config.id,
					serverName: rt.config.name,
					toolName,
					description: t?.description ? String(t.description) : undefined,
					inputSchema: t?.inputSchema,
					lmToolName: makeMcpLmToolName(rt.config.id, toolName)
				} as McpToolInfo;
			});

			rt.status = 'connected';
			this.output.appendLine(`[mcp] connected ${rt.config.id} (${rt.config.transport}), tools=${rt.tools.length}`);
			this._onDidChange.fire();
		} catch (err) {
			rt.status = 'error';
			rt.tools = [];
			rt.lastError = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`[mcp] error ${rt.config.id}: ${rt.lastError}`);
			this._onDidChange.fire();
			try {
				await this.disconnect(rt.config.id);
			} catch {
				// ignore
			}
		}
	}

	public async disconnect(serverId: string): Promise<void> {
		const rt = this.runtimes.get(serverId);
		if (!rt) return;
		try {
			if (rt.client) {
				await rt.client.close?.();
			}
		} catch {
			// ignore
		}
		rt.client = undefined;
		rt.transport = undefined;
		rt.tools = [];
		rt.status = 'disconnected';
		this._onDidChange.fire();
	}

	public resolveMcpToolByLmName(lmToolName: string): McpToolInfo | undefined {
		for (const rt of this.runtimes.values()) {
			const hit = rt.tools.find((t) => t.lmToolName === lmToolName);
			if (hit) return hit;
		}
		return undefined;
	}

	public async callToolByLmName(lmToolName: string, args: any): Promise<any> {
		const info = this.resolveMcpToolByLmName(lmToolName);
		if (!info) throw new Error(`Unknown MCP tool: ${lmToolName}`);
		await this.ensureConnected(info.serverId);
		const rt = this.runtimes.get(info.serverId);
		if (!rt?.client) throw new Error(`MCP server not connected: ${info.serverId}`);
		return await rt.client.callTool({ name: info.toolName, arguments: args ?? {} });
	}

	private async createClientAndTransport(cfg: McpServerConfig): Promise<{ client: any; transport: any }> {
		const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as any;
		const client = new Client({ name: 'tripilot', version: '0.0.1' });

		switch (cfg.transport) {
			case 'stdio': {
				const { StdioClientTransport } = (await import('@modelcontextprotocol/sdk/client/stdio.js')) as any;
				if (!cfg.command) throw new Error('stdio requires command');
				const transport = new StdioClientTransport({
					command: cfg.command,
					args: Array.isArray(cfg.args) ? cfg.args : [],
					cwd: cfg.cwd,
					env: cfg.env
				});
				return { client, transport };
			}
			case 'websocket': {
				const { WebSocketClientTransport } = (await import('@modelcontextprotocol/sdk/client/websocket.js')) as any;
				if (!cfg.url) throw new Error('websocket requires url');
				const transport = new WebSocketClientTransport(new URL(cfg.url));
				return { client, transport };
			}
			case 'http': {
				const { StreamableHTTPClientTransport } = (await import(
					'@modelcontextprotocol/sdk/client/streamableHttp.js'
				)) as any;
				if (!cfg.url) throw new Error('http requires url');
				const transport = new StreamableHTTPClientTransport(new URL(cfg.url));
				return { client, transport };
			}
			case 'sse': {
				if (!cfg.url) throw new Error('sse requires url');
				// Prefer explicit SSE transport if present; otherwise fall back to Streamable HTTP (which can negotiate / fallback).
				try {
					const { SSEClientTransport } = (await import('@modelcontextprotocol/sdk/client/sse.js')) as any;
					const transport = new SSEClientTransport(new URL(cfg.url));
					return { client, transport };
				} catch {
					const { StreamableHTTPClientTransport } = (await import(
						'@modelcontextprotocol/sdk/client/streamableHttp.js'
					)) as any;
					const transport = new StreamableHTTPClientTransport(new URL(cfg.url));
					return { client, transport };
				}
			}
		}

		throw new Error(`Unsupported transport: ${cfg.transport}`);
	}
}
