#!/usr/bin/env node
// ── Tripilot CLI ──
// Standalone CLI for TriPilot that talks to TriLC via Anthropic-compatible API.
// Independent of VS Code. Streams SSE responses to stdout.
// CTO-008-P P.1 + COS-005: CLI entry aligned with claude code patterns.

import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

// ── Types ──

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  max_tokens?: number;
  stream?: boolean;
}

interface SSEEvent {
  type: string;
  message?: { id?: string; model?: string; content?: unknown[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; index?: number; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string };
  usage?: { output_tokens?: number };
  error?: { type: string; message: string };
}

// ── Config ──

const VERSION = '0.1.0';
const DEFAULT_PORT = 8711;
const DEFAULT_MODEL = 'deepseek-v4-pro';
const TRILC_BASE = 'http://127.0.0.1';

interface CliOptions {
  port: number;
  model: string;
  maxTokens: number;
  system?: string;
  help: boolean;
  version: boolean;
  prompt: string;
  interactive: boolean;
}

// ── Help ──

function printHelp(): void {
  console.log(`Tripilot CLI v${VERSION} — TriMetaverse AI Assistant

Usage: tripilot [options] [prompt]

Options:
  --port <n>       TriLC daemon port (default: ${DEFAULT_PORT})
  --model <id>     Model ID to use (default: ${DEFAULT_MODEL})
  --max-tokens <n> Max output tokens (default: 4096)
  --system <text>  System prompt override
  --help, -h       Show this help
  --version, -v    Show version

Examples:
  tripilot "Explain this code"
  tripilot --port 8711 --model claude-sonnet-4-20250514 "Refactor this function"
  echo "What is TypeScript?" | tripilot
  tripilot              # interactive mode
`);
}

// ── Argument parsing ──

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    port: DEFAULT_PORT,
    model: DEFAULT_MODEL,
    maxTokens: 4096,
    help: false,
    version: false,
    prompt: '',
    interactive: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        opts.port = parseInt(args[++i] ?? '', 10) || DEFAULT_PORT;
        break;
      case '--model':
        opts.model = args[++i] ?? DEFAULT_MODEL;
        break;
      case '--max-tokens':
        opts.maxTokens = parseInt(args[++i] ?? '', 10) || 4096;
        break;
      case '--system':
        opts.system = args[++i] ?? undefined;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
      case '-v':
        opts.version = true;
        break;
      default:
        if (!args[i].startsWith('-')) {
          positional.push(args[i]);
        }
    }
  }

  opts.prompt = positional.join(' ');

  // If no prompt and not asking for help/version, check if stdin is piped
  if (!opts.prompt && !opts.help && !opts.version) {
    if (process.stdin.isTTY) {
      opts.interactive = true;
    }
  }

  return opts;
}

// ── HTTP helpers ──

function httpPost(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<{ statusCode: number; stream: Readable }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqFn = parsedUrl.protocol === 'https:' ? https.request : http.request;

    const req = reqFn(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          Accept: 'text/event-stream',
          'User-Agent': `TripilotCLI/${VERSION}`,
          ...headers,
        },
        timeout: timeoutMs,
      },
      res => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
          res.on('end', () => reject(new Error(`TriLC returned ${res.statusCode}: ${errBody.slice(0, 500)}`)));
          return;
        }
        resolve({ statusCode: res.statusCode ?? 200, stream: res });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}

// ── SSE Parser ──

async function* parseSSE(stream: Readable): AsyncIterable<SSEEvent> {
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk.toString();

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        yield JSON.parse(data);
      } catch {
        // Skip malformed SSE lines
      }
    }
  }
}

// ── Chat ──

async function sendMessage(opts: CliOptions, messages: AnthropicMessage[]): Promise<{
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: string;
}> {
  const url = `${TRILC_BASE}:${opts.port}/v1/messages`;

  const request: AnthropicRequest = {
    model: opts.model,
    messages,
    system: opts.system,
    max_tokens: opts.maxTokens,
    stream: true,
  };

  const { stream } = await httpPost(url, JSON.stringify(request));

  let fullContent = '';
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const pendingTools: Map<number, { id: string; name: string; argsJson: string }> = new Map();
  let stopReason = 'end_turn';

  for await (const event of parseSSE(stream)) {
    switch (event.type) {
      case 'content_block_start': {
        if (event.content_block?.type === 'tool_use') {
          const idx = event.index ?? 0;
          pendingTools.set(idx, {
            id: event.content_block.id ?? '',
            name: event.content_block.name ?? '',
            argsJson: '',
          });
        }
        break;
      }
      case 'content_block_delta': {
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          fullContent += event.delta.text;
          process.stdout.write(event.delta.text);
        } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json !== undefined) {
          const idx = event.index ?? 0;
          const pending = pendingTools.get(idx);
          if (pending) {
            pending.argsJson += event.delta.partial_json;
          }
        }
        break;
      }
      case 'content_block_stop': {
        const idx = event.index ?? 0;
        const pending = pendingTools.get(idx);
        if (pending) {
          try {
            toolCalls.push({
              id: pending.id,
              name: pending.name,
              arguments: JSON.parse(pending.argsJson || '{}'),
            });
          } catch {
            toolCalls.push({
              id: pending.id,
              name: pending.name,
              arguments: {},
            });
          }
          pendingTools.delete(idx);
        }
        break;
      }
      case 'message_stop': {
        stopReason = 'end_turn';
        break;
      }
      case 'error': {
        throw new Error(`TriLC error: ${event.error?.message ?? 'unknown'}`);
      }
    }
  }

  // Final newline after streaming
  if (fullContent) process.stdout.write('\n');

  return { content: fullContent, toolCalls, stopReason };
}

// ── Interactive mode ──

async function interactiveMode(opts: CliOptions): Promise<void> {
  console.log(`Tripilot CLI v${VERSION} (model: ${opts.model}, port: ${opts.port})`);
  console.log('Type your message and press Enter. Press Ctrl+C to exit.\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const messages: AnthropicMessage[] = [];

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    if (trimmed === '/exit' || trimmed === '/quit') {
      break;
    }

    if (trimmed === '/clear') {
      messages.length = 0;
      console.log('[session cleared]');
      rl.prompt();
      continue;
    }

    messages.push({ role: 'user', content: trimmed });

    try {
      const result = await sendMessage(opts, messages);

      if (result.content) {
        messages.push({ role: 'assistant', content: result.content });
      }

      if (result.toolCalls.length > 0) {
        console.log(`\n[Tool calls: ${result.toolCalls.map(tc => tc.name).join(', ')}]`);
        messages.push({
          role: 'assistant',
          content: `[Used tools: ${result.toolCalls.map(tc => tc.name).join(', ')}]`,
        });
      }
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    }

    rl.prompt();
  }

  rl.close();
  console.log('\nGoodbye.');
}

// ── Single prompt mode ──

async function singlePromptMode(opts: CliOptions): Promise<void> {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: opts.prompt },
  ];

  try {
    await sendMessage(opts, messages);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ── Stdin pipe mode ──

async function stdinMode(opts: CliOptions): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const prompt = Buffer.concat(chunks).toString('utf-8').trim();

  if (!prompt) {
    console.error('Error: no input provided');
    process.exit(1);
  }

  opts.prompt = prompt;
  await singlePromptMode(opts);
}

// ── Health check ──

async function checkTriLC(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: 3000 }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.ok === true || data.service === 'trilc');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ── Entry ──

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.version) {
    console.log(`Tripilot CLI v${VERSION}`);
    return;
  }

  // Check TriLC is running
  const healthy = await checkTriLC(opts.port);
  if (!healthy) {
    console.error(`Error: TriLC daemon not running on port ${opts.port}`);
    console.error('Start it with: trilc start --port ' + opts.port);
    process.exit(1);
  }

  if (opts.interactive) {
    await interactiveMode(opts);
  } else if (opts.prompt) {
    await singlePromptMode(opts);
  } else if (!process.stdin.isTTY) {
    await stdinMode(opts);
  } else {
    // No prompt provided, enter interactive mode
    opts.interactive = true;
    await interactiveMode(opts);
  }
}

main().catch(err => {
  console.error('Tripilot CLI fatal error:', err);
  process.exit(1);
});
