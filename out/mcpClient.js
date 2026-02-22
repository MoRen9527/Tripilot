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
exports.McpClientManager = void 0;
exports.makeMcpLmToolName = makeMcpLmToolName;
const vscode = __importStar(require("vscode"));
function safeIdPart(s) {
    return String(s).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}
function makeMcpLmToolName(serverId, toolName) {
    return `mcp__${safeIdPart(serverId)}__${safeIdPart(toolName)}`;
}
class McpClientManager {
    output;
    runtimes = new Map();
    disposed = false;
    _onDidChange = new vscode.EventEmitter();
    onDidChange = this._onDidChange.event;
    constructor(output) {
        this.output = output;
    }
    dispose() {
        this.disposed = true;
        this._onDidChange.dispose();
        for (const rt of this.runtimes.values()) {
            void this.disconnect(rt.config.id);
        }
        this.runtimes.clear();
    }
    getStatuses(configs) {
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
            };
        })
            .filter((s) => s.id && s.name);
    }
    getToolsForEnabledServers(enabledServerIds) {
        const out = [];
        for (const [id, rt] of this.runtimes) {
            if (!enabledServerIds.has(id))
                continue;
            out.push(...(rt.tools ?? []));
        }
        return out;
    }
    async refresh(configs) {
        if (this.disposed)
            return;
        const desired = new Map();
        for (const c of configs) {
            if (!c?.id)
                continue;
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
            }
            else {
                existing.config = c;
            }
            if (c.enabled) {
                void this.ensureConnected(c.id);
            }
            else {
                await this.disconnect(c.id);
            }
        }
        this._onDidChange.fire();
    }
    async ensureConnected(serverId) {
        if (this.disposed)
            return;
        const rt = this.runtimes.get(serverId);
        if (!rt)
            return;
        if (rt.status === 'connected' || rt.status === 'connecting')
            return;
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
            rt.tools = tools.map((t) => {
                const toolName = String(t?.name ?? '');
                return {
                    serverId: rt.config.id,
                    serverName: rt.config.name,
                    toolName,
                    description: t?.description ? String(t.description) : undefined,
                    inputSchema: t?.inputSchema,
                    lmToolName: makeMcpLmToolName(rt.config.id, toolName)
                };
            });
            rt.status = 'connected';
            this.output.appendLine(`[mcp] connected ${rt.config.id} (${rt.config.transport}), tools=${rt.tools.length}`);
            this._onDidChange.fire();
        }
        catch (err) {
            rt.status = 'error';
            rt.tools = [];
            rt.lastError = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[mcp] error ${rt.config.id}: ${rt.lastError}`);
            this._onDidChange.fire();
            try {
                await this.disconnect(rt.config.id);
            }
            catch {
                // ignore
            }
        }
    }
    async disconnect(serverId) {
        const rt = this.runtimes.get(serverId);
        if (!rt)
            return;
        try {
            if (rt.client) {
                await rt.client.close?.();
            }
        }
        catch {
            // ignore
        }
        rt.client = undefined;
        rt.transport = undefined;
        rt.tools = [];
        rt.status = 'disconnected';
        this._onDidChange.fire();
    }
    resolveMcpToolByLmName(lmToolName) {
        for (const rt of this.runtimes.values()) {
            const hit = rt.tools.find((t) => t.lmToolName === lmToolName);
            if (hit)
                return hit;
        }
        return undefined;
    }
    async callToolByLmName(lmToolName, args) {
        const info = this.resolveMcpToolByLmName(lmToolName);
        if (!info)
            throw new Error(`Unknown MCP tool: ${lmToolName}`);
        await this.ensureConnected(info.serverId);
        const rt = this.runtimes.get(info.serverId);
        if (!rt?.client)
            throw new Error(`MCP server not connected: ${info.serverId}`);
        return await rt.client.callTool({ name: info.toolName, arguments: args ?? {} });
    }
    async createClientAndTransport(cfg) {
        const { Client } = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/index.js'))));
        const client = new Client({ name: 'tripilot', version: '0.0.1' });
        switch (cfg.transport) {
            case 'stdio': {
                const { StdioClientTransport } = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/stdio.js'))));
                if (!cfg.command)
                    throw new Error('stdio requires command');
                const transport = new StdioClientTransport({
                    command: cfg.command,
                    args: Array.isArray(cfg.args) ? cfg.args : [],
                    cwd: cfg.cwd,
                    env: cfg.env
                });
                return { client, transport };
            }
            case 'websocket': {
                const { WebSocketClientTransport } = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/websocket.js'))));
                if (!cfg.url)
                    throw new Error('websocket requires url');
                const transport = new WebSocketClientTransport(new URL(cfg.url));
                return { client, transport };
            }
            case 'http': {
                const { StreamableHTTPClientTransport } = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/streamableHttp.js'))));
                if (!cfg.url)
                    throw new Error('http requires url');
                const transport = new StreamableHTTPClientTransport(new URL(cfg.url));
                return { client, transport };
            }
            case 'sse': {
                if (!cfg.url)
                    throw new Error('sse requires url');
                // Prefer explicit SSE transport if present; otherwise fall back to Streamable HTTP (which can negotiate / fallback).
                try {
                    const { SSEClientTransport } = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/sse.js'))));
                    const transport = new SSEClientTransport(new URL(cfg.url));
                    return { client, transport };
                }
                catch {
                    const { StreamableHTTPClientTransport } = (await Promise.resolve().then(() => __importStar(require('@modelcontextprotocol/sdk/client/streamableHttp.js'))));
                    const transport = new StreamableHTTPClientTransport(new URL(cfg.url));
                    return { client, transport };
                }
            }
        }
        throw new Error(`Unsupported transport: ${cfg.transport}`);
    }
}
exports.McpClientManager = McpClientManager;
//# sourceMappingURL=mcpClient.js.map