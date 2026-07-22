/**
 * TriLC HTTP+SSE Client — W30 Architecture Fix S3
 *
 * Replaces the old `runTrilcDirectRequest()` pattern.
 * TriPilot submits user intent → TriLC daemon executes → SSE events flow back.
 *
 * Protocol:
 *   POST /internal/v1/tasks/submit  → { sessionId, streamEndpoint }
 *   GET  /internal/v1/sessions/{id}/stream → SSE (delta / tool_use / tool_result / task_done / task_error)
 *   GET  /internal/v1/sessions       → session list
 *   POST /internal/v1/sessions/{id}/cancel → cancel
 *   POST /internal/v1/sessions/recover → recover
 *
 * TriPilot holds ZERO API keys — all LLM calls go through TriLC.
 */

import * as http from 'node:http';

// ── Types ──

export interface TriLCConfig {
  baseUrl: string;
  /** Timeout in ms for HTTP requests (default: 10_000). */
  timeout?: number;
}

export interface SubmitTaskRequest {
  message: string;
  conversationId?: string;
  systemPrompt?: string;
  context?: {
    files?: string[];
    workspaceRoot?: string;
  };
}

export interface SubmitTaskResponse {
  sessionId: string;
  streamEndpoint: string;
  status: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  progress?: { step: number; totalSteps: number; description: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SessionListResponse {
  ok: boolean;
  count: number;
  sessions: SessionSummary[];
}

export interface CancelResponse {
  ok: boolean;
  sessionId: string;
  status: string;
}

export interface RecoverResponse {
  ok: boolean;
  session: unknown | null;
  messages: unknown[] | null;
  warnings: string[];
}

// ── TriLC Agent types ──
export interface TriLCAgent {
  id: string;
  displayName: string;
  decisionRights: string;
  tools: string[];
  systemPrompt?: string;
}

export interface TriLCAgentListResponse {
  ok: boolean;
  agents: TriLCAgent[];
}

export interface TriLCAgentPromptResponse {
  ok: boolean;
  systemPrompt: string;
}

// ── SSE Event Types ──

export interface SSEDeltaEvent {
  content: string;
}

export interface SSEToolUseEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface SSEToolResultEvent {
  toolName: string;
  output: string;
  durationMs?: number;
}

export interface SSETaskProgressEvent {
  step: number;
  totalSteps: number;
  description: string;
}

export interface SSETaskDoneEvent {
  status: 'success';
  summary: string;
}

export interface SSETaskErrorEvent {
  status: 'failed';
  error: string;
}

export interface StreamCallbacks {
  onDelta?: (content: string) => void;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, output: string, durationMs?: number) => void;
  onTaskProgress?: (step: number, totalSteps: number, description: string) => void;
  onTaskDone?: (summary: string) => void;
  onTaskError?: (error: string) => void;
}

// ── TriLCClient ──

export class TriLCClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private activeStreams = new Map<string, http.ClientRequest>();

  constructor(config: TriLCConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, ''); // strip trailing slash
    this.timeout = config.timeout ?? 30_000;
  }

  // ── Endpoint ①: POST /internal/v1/tasks/submit ──

  async submitTask(req: SubmitTaskRequest, signal?: AbortSignal): Promise<SubmitTaskResponse> {
    const body = JSON.stringify(req);
    return this.jsonRequest<SubmitTaskResponse>('POST', '/internal/v1/tasks/submit', body, signal);
  }

  // ── Endpoint ②: SSE GET /internal/v1/sessions/{id}/stream ──

  streamSession(sessionId: string, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = new URL(`/internal/v1/sessions/${encodeURIComponent(sessionId)}/stream`, this.baseUrl);
      const req = http.get(
        url.toString(),
        {
          timeout: 0, // no timeout for SSE
          signal,
        },
        (res) => {
          if (res.statusCode !== 200) {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => {
              reject(new Error(`SSE stream error ${res.statusCode}: ${body}`));
            });
            return;
          }

          // Parse SSE stream
          let buffer = '';
          let currentEvent = '';
          let currentData = '';

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();

            // Process complete lines
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? ''; // keep incomplete line in buffer

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                currentData = line.slice(6);
              } else if (line.trim() === '' && currentEvent) {
                // Empty line = end of event
                this.dispatchSSEEvent(currentEvent, currentData, callbacks, resolve, reject);
                currentEvent = '';
                currentData = '';
              }
            }
          });

          res.on('end', () => {
            // Process any remaining event
            if (currentEvent && currentData) {
              this.dispatchSSEEvent(currentEvent, currentData, callbacks, resolve, reject);
            }
            this.activeStreams.delete(sessionId);
            resolve();
          });

          res.on('error', (err) => {
            this.activeStreams.delete(sessionId);
            reject(err);
          });
        },
      );

      req.on('error', (err) => {
        this.activeStreams.delete(sessionId);
        reject(err);
      });

      this.activeStreams.set(sessionId, req);
    });
  }

  // ── Endpoint ③: GET /internal/v1/sessions ──

  async listSessions(status?: string, limit = 20, signal?: AbortSignal): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    params.set('limit', String(limit));
    const path = `/internal/v1/sessions?${params.toString()}`;
    return this.jsonRequest<SessionListResponse>('GET', path, null, signal);
  }

  // ── Endpoint ④: POST /internal/v1/sessions/{id}/cancel ──

  async cancelSession(sessionId: string, signal?: AbortSignal): Promise<CancelResponse> {
    // Also abort the active SSE stream if any
    const activeStream = this.activeStreams.get(sessionId);
    if (activeStream) {
      activeStream.destroy();
      this.activeStreams.delete(sessionId);
    }
    return this.jsonRequest<CancelResponse>(
      'POST',
      `/internal/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
      '{}',
      signal,
    );
  }

  // ── Endpoint ⑤: POST /internal/v1/sessions/recover ──

  async recoverSession(sessionId?: string, signal?: AbortSignal): Promise<RecoverResponse> {
    const body = JSON.stringify(sessionId ? { sessionId } : {});
    return this.jsonRequest<RecoverResponse>('POST', '/internal/v1/sessions/recover', body, signal);
  }

  // ── Connection check ──

  // ── Endpoint ⑥: GET /internal/v1/agents ──

  /** Fetch TriCompany agent list from TriLC. */
  async listAgents(signal?: AbortSignal): Promise<TriLCAgent[]> {
    try {
      const resp = await this.jsonRequest<TriLCAgentListResponse>('GET', '/internal/v1/agents', null, signal);
      return Array.isArray(resp.agents) ? resp.agents : [];
    } catch {
      return [];
    }
  }

  /** Fetch system prompt for a specific TriCompany agent. */
  async getAgentSystemPrompt(agentId: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const resp = await this.jsonRequest<TriLCAgentPromptResponse>(
        'GET',
        `/internal/v1/agents/${encodeURIComponent(agentId)}/system-prompt`,
        null,
        signal
      );
      return resp.systemPrompt ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Check if TriLC daemon is reachable via /healthz. */
  async checkHealth(timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
    try {
      const resp = await this.jsonRequest<{ ok: boolean }>('GET', '/healthz', null, signal);
      return resp.ok === true;
    } catch {
      return false;
    }
  }

  /** Abort all active SSE streams. */
  abortAll(): void {
    for (const [id, req] of this.activeStreams) {
      req.destroy();
      this.activeStreams.delete(id);
    }
  }

  dispose(): void {
    this.abortAll();
  }

  // ── Private helpers ──

  private jsonRequest<T>(method: string, path: string, body: string | null, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: body
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body).toString(),
              }
            : {},
          timeout: this.timeout,
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
              const parsed = JSON.parse(raw) as T;
              resolve(parsed);
            } catch {
              reject(new Error(`Invalid JSON response for ${method} ${path}: ${raw.slice(0, 200)}`));
            }
          });
          res.on('error', reject);
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout for ${method} ${path}`));
      });
      req.on('error', reject);

      if (body) req.write(body);
      req.end();
    });
  }

  private dispatchSSEEvent(
    event: string,
    data: string,
    callbacks: StreamCallbacks,
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    try {
      const parsed = JSON.parse(data);

      switch (event) {
        case 'delta':
          callbacks.onDelta?.(parsed.content ?? '');
          break;
        case 'tool_use':
          callbacks.onToolUse?.(parsed.toolName ?? 'unknown', parsed.input ?? {});
          break;
        case 'tool_result':
          callbacks.onToolResult?.(parsed.toolName ?? 'unknown', parsed.output ?? '', parsed.durationMs);
          break;
        case 'task_progress':
          callbacks.onTaskProgress?.(parsed.step ?? 0, parsed.totalSteps ?? 0, parsed.description ?? '');
          break;
        case 'task_done':
          callbacks.onTaskDone?.(parsed.summary ?? 'Task completed');
          break;
        case 'task_error':
          callbacks.onTaskError?.(parsed.error ?? 'Unknown error');
          break;
        default:
          // Unknown event type — silently ignore
          break;
      }
    } catch (err) {
      reject(new Error(`Failed to parse SSE event: ${(err as Error).message}`));
    }
  }
}
