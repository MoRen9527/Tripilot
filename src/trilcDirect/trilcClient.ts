// ── TriLC Direct Client ──
// Talks to the local TriLC server via its Anthropic-compatible /v1/messages endpoint.
// Supports SSE streaming (default) and JSON modes.

import * as http from 'node:http';

// ── Types ──

export interface TrilcClientConfig {
  baseUrl: string;
  /** Optional: used for TriLC auth if protected */
  apiKey?: string;
  /** Additional headers to attach to every request */
  additionalHeaders?: Record<string, string>;
  /** Default model id (compat) */
  defaultModel?: string;
}

export interface TrilcModelInfo {
  id: string;
  displayName?: string;
  createdAt?: string;
  /** Compatibility fields for UI model display */
  maxInputTokens?: number;
  modelTag?: string;
  provider?: string;
  modelExtra?: Record<string, unknown>;
  multiplier?: number;
}

/** OpenAI-compatible chat message type. */
export type OpenAIChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: any;
  };
};

export type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAIChatCompletionsChunk = {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

/** Auto-models session for TriLC. */
export interface TrilcAutoModelsSession {
  sessionToken: string;
  expiresAt?: number;
  selectedModel: string;
  discountedCosts?: Record<string, { low: number; high: number }>;
}

export interface TrilcMessage {
  role: 'user' | 'assistant';
  content: string | TrilcContentBlock[];
}

export interface TrilcContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface TrilcTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface TrilcToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface TrilcStreamEvent {
  type: string;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    content?: TrilcContentBlock[];
    model?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  content_block?: {
    type?: string;
    index?: number;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  usage?: { output_tokens?: number };
  error?: { type: string; message: string };
}

export type TrilcStreamHandler = (event: TrilcStreamEvent) => void;

export interface TrilcResponse {
  id: string;
  type: string;
  role: string;
  content: TrilcContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

// ── Client ──

export class TrilcDirectClient {
  constructor(
    private readonly extensionVersion: string,
    private readonly editorVersion: string,
  ) {}

  /** @deprecated Stub — TriLC does not use GitHub tokens. */
  async getCopilotToken(): Promise<null> {
    return null;
  }

  /** @deprecated Stub — TriLC client has no persistent resources to dispose. */
  dispose(): void { /* no-op */ }

  /** @deprecated Stub — TriLC client state reset is a no-op. */
  reset(): void { /* no-op */ }

  /** @deprecated Stub — TriLC does not use auto-models sessions. */
  async createAutoModelsSession(_args: {
    token: any;
    modelHint: string;
    previousSessionToken?: string;
  }): Promise<TrilcAutoModelsSession | undefined> {
    return undefined;
  }

  /**
   * Fetch available models from TriLC's /v1/models endpoint.
   */
  async listModels(cfg: TrilcClientConfig): Promise<TrilcModelInfo[]> {
    const url = `${cfg.baseUrl}/v1/models`;
    const body = await this.httpGet(url, cfg);
    const parsed = JSON.parse(body);

    // Anthropic-compatible models list response
    if (parsed.data && Array.isArray(parsed.data)) {
      return parsed.data.map((m: any) => ({
        id: String(m.id ?? ''),
        displayName: m.display_name ?? m.displayName ?? undefined,
        createdAt: m.created_at ?? m.createdAt ?? undefined,
      }));
    }

    // Fallback: if response wraps in { models: [...] }
    if (parsed.models && Array.isArray(parsed.models)) {
      return parsed.models.map((m: any) => ({
        id: String(m.id ?? ''),
        displayName: m.displayName ?? m.display_name ?? undefined,
        createdAt: m.createdAt ?? m.created_at ?? undefined,
      }));
    }

    return [];
  }

  /**
   * Send a streaming Anthropic-compatible request to TriLC /v1/messages.
   * Returns the full final text content and collected tool calls.
   */
  async streamChat(args: {
    cfg: TrilcClientConfig;
    model: string;
    system?: string;
    messages: TrilcMessage[];
    tools?: TrilcTool[];
    maxTokens?: number;
    abortSignal: AbortSignal;
    onEvent?: TrilcStreamHandler;
  }): Promise<{ content: string; toolCalls: TrilcToolCall[]; stopReason: string }> {
    const { cfg, model, system, messages, tools, maxTokens, abortSignal, onEvent } = args;

    const body = JSON.stringify({
      model,
      messages,
      system: system || undefined,
      tools: tools?.length ? tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })) : undefined,
      max_tokens: maxTokens ?? 4096,
      stream: true,
    });

    const url = `${cfg.baseUrl}/v1/messages`;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const req = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
            'Accept': 'text/event-stream',
            ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}),
            ...(cfg.additionalHeaders ?? {}),
            'User-Agent': `TriPilot/${this.extensionVersion}`,
          },
          timeout: 120_000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errBody = '';
            res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
            res.on('end', () => {
              reject(new Error(`TriLC returned ${res.statusCode}: ${errBody.slice(0, 500)}`));
            });
            return;
          }

          let buffer = '';
          let fullContent = '';
          const toolCalls: TrilcToolCall[] = [];
          const pendingToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
          let stopReason = 'end_turn';

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;

              try {
                const event: TrilcStreamEvent = JSON.parse(data);
                onEvent?.(event);

                switch (event.type) {
                  case 'content_block_delta': {
                    if (event.delta?.type === 'text_delta' && event.delta.text) {
                      fullContent += event.delta.text;
                    } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json !== undefined) {
                      const idx = event.index ?? 0;
                      const pending = pendingToolCalls.get(idx);
                      if (pending) {
                        pending.arguments += event.delta.partial_json;
                      }
                    }
                    break;
                  }
                  case 'content_block_start': {
                    if (event.content_block?.type === 'tool_use') {
                      const idx = event.index ?? 0;
                      pendingToolCalls.set(idx, {
                        id: event.content_block.id ?? '',
                        name: event.content_block.name ?? '',
                        arguments: '',
                      });
                    }
                    break;
                  }
                  case 'content_block_stop': {
                    const idx = event.index ?? 0;
                    const pending = pendingToolCalls.get(idx);
                    if (pending) {
                      toolCalls.push({
                        id: pending.id,
                        type: 'function',
                        function: {
                          name: pending.name,
                          arguments: pending.arguments || '{}',
                        },
                      });
                      pendingToolCalls.delete(idx);
                    }
                    break;
                  }
                }
              } catch {
                // Skip malformed SSE lines
              }
            }
          });

          res.on('end', () => {
            resolve({ content: fullContent, toolCalls, stopReason });
          });

          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.write(body);
      req.end();

      abortSignal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Request aborted'));
      }, { once: true });
    });
  }

  /**
   * Health check — GET /healthz.
   */
  async healthCheck(baseUrl: string): Promise<boolean> {
    try {
      const url = `${baseUrl}/healthz`;
      await this.httpGet(url, { baseUrl });
      return true;
    } catch {
      return false;
    }
  }

  private httpGet(url: string, cfg: TrilcClientConfig): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const req = http.get(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            'Accept': 'application/json',
            ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}),
            ...(cfg.additionalHeaders ?? {}),
          },
          timeout: 30_000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve(data));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    });
  }
}
