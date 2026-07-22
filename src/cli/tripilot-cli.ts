// ── Tripilot CLI ──
// Standalone CLI for TriPilot that talks to TriLC via Anthropic-compatible API.
// Independent of VS Code. Streams SSE responses to stdout. Executes tools locally.
// CTO-008-P P.1 + TWF-002-5: Tool execution loop with TriCode→opencode integration.
// W30: tricodeBridge.ts removed; import directly from @trimetaverse/tricode.

import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { executeCodeTask } from '@trimetaverse/tricode';

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

// ── Tool definitions (Anthropic-compatible) ──

const CLI_TOOLS: AnthropicTool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read.' },
        offset: { type: 'number', description: 'Optional line offset (0-indexed).' },
        limit: { type: 'number', description: 'Optional max number of lines to read.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file at the given path with the provided content.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write.' },
        content: { type: 'string', description: 'Content to write to the file.' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at the given path.',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Absolute path to the directory to list.' },
        depth: { type: 'number', description: 'Optional recursion depth (default 1).' },
      },
      required: ['dir_path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in files within a directory.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
        dir_path: { type: 'string', description: 'Directory to search within.' },
        file_glob: { type: 'string', description: 'Optional glob filter (e.g. "*.ts").' },
      },
      required: ['pattern', 'dir_path'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command and return its output.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Optional working directory.' },
        timeout: { type: 'number', description: 'Optional timeout in ms (default 30000).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'code_task',
    description: 'Execute a complex multi-step code task via TriCode→opencode. Use for refactoring, code generation, or running build/test commands.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Natural language description of the code task.' },
        cwd: { type: 'string', description: 'Optional working directory for the task.' },
      },
      required: ['task'],
    },
  },
];

// ── Tool executor ──

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

async function executeTool(tool: ToolCall, cwd: string): Promise<ToolResult> {
  const args = tool.arguments;
  try {
    switch (tool.name) {
      case 'read_file': {
        const filePath = String(args.file_path ?? '');
        if (!filePath) throw new Error('file_path is required');
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        const content = await fs.readFile(resolved, 'utf-8');
        const lines = content.split('\n');
        const offset = typeof args.offset === 'number' ? args.offset : 0;
        const limit = typeof args.limit === 'number' ? args.limit : lines.length;
        const sliced = lines.slice(offset, offset + limit);
        // Format with line numbers
        const numbered = sliced.map((l, i) => `${offset + i + 1}\t${l}`).join('\n');
        return { tool_use_id: tool.id, content: numbered || '(empty file)' };
      }
      case 'write_file': {
        const filePath = String(args.file_path ?? '');
        const content = String(args.content ?? '');
        if (!filePath) throw new Error('file_path is required');
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf-8');
        return { tool_use_id: tool.id, content: `File written: ${resolved}` };
      }
      case 'list_directory': {
        const dirPath = String(args.dir_path ?? '');
        if (!dirPath) throw new Error('dir_path is required');
        const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
        const depth = typeof args.depth === 'number' ? args.depth : 1;
        const entries = await listDir(resolved, depth);
        return { tool_use_id: tool.id, content: entries.join('\n') || '(empty directory)' };
      }
      case 'search_files': {
        const pattern = String(args.pattern ?? '');
        const dirPath = String(args.dir_path ?? '');
        if (!pattern || !dirPath) throw new Error('pattern and dir_path are required');
        const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
        const results = await searchInDir(resolved, pattern, String(args.file_glob ?? ''));
        return { tool_use_id: tool.id, content: results.join('\n') || '(no matches)' };
      }
      case 'run_command': {
        const command = String(args.command ?? '');
        if (!command) throw new Error('command is required');
        const cmdCwd = args.cwd ? (path.isAbsolute(String(args.cwd)) ? String(args.cwd) : path.resolve(cwd, String(args.cwd))) : cwd;
        const timeout = typeof args.timeout === 'number' ? args.timeout : 30000;
        const output = await runShellCommand(command, cmdCwd, timeout);
        return { tool_use_id: tool.id, content: output };
      }
      case 'code_task': {
        const task = String(args.task ?? '');
        if (!task) throw new Error('task is required');
        const taskCwd = args.cwd ? String(args.cwd) : cwd;
        try {
          const result = await executeCodeTask({ task, cwd: taskCwd });
          return { tool_use_id: tool.id, content: `TriCode result:\n${JSON.stringify(result, null, 2)}` };
        } catch (err) {
          return { tool_use_id: tool.id, content: `TriCode execution failed: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
        }
      }
      default:
        return { tool_use_id: tool.id, content: `Unknown tool: ${tool.name}`, is_error: true };
    }
  } catch (err) {
    return { tool_use_id: tool.id, content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}

async function listDir(dirPath: string, depth: number): Promise<string[]> {
  const entries: string[] = [];
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        entries.push(`[DIR]  ${full}`);
        if (depth > 1) {
          try {
            const sub = await listDir(full, depth - 1);
            entries.push(...sub);
          } catch { /* skip inaccessible */ }
        }
      } else {
        entries.push(`[FILE] ${full}`);
      }
    }
  } catch (err) {
    entries.push(`(error listing ${dirPath}: ${err instanceof Error ? err.message : String(err)})`);
  }
  return entries;
}

async function searchInDir(dirPath: string, pattern: string, glob: string): Promise<string[]> {
  const results: string[] = [];
  const grepArgs: string[] = [];
  const useRegex = pattern.startsWith('/') && pattern.endsWith('/');

  if (useRegex) {
    grepArgs.push('-P', pattern.slice(1, -1));
  } else {
    grepArgs.push('-F', pattern);
  }
  grepArgs.push('-rn', '--include=*');
  // Apply glob filter if provided
  if (glob) {
    // convert simple glob to --include pattern
    grepArgs.length = grepArgs.length - 1; // remove --include=*
    grepArgs.push(`--include=${glob}`);
  }
  grepArgs.push(dirPath);

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('grep', grepArgs, { maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
        if (err && err.code !== 1) reject(err); // code 1 = no matches, not an error
        else resolve(stdout);
      });
    });
    if (stdout.trim()) results.push(stdout.trim());
  } catch {
    // If grep fails, fall back to a simple Node.js search
    results.push('(grep unavailable; try installing grep for faster search)');
  }
  return results;
}

async function runShellCommand(command: string, cwd: string, timeout: number): Promise<string> {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : '/bin/sh';
  const shellArgs = isWindows ? ['-NoProfile', '-Command', command] : ['-c', command];

  return new Promise<string>((resolve, reject) => {
    const proc = execFile(shell, shellArgs, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        resolve(`Exit: ${err.code}\nSTDOUT:\n${stdout || '(none)'}\nSTDERR:\n${stderr || '(none)'}`);
      } else {
        resolve(stdout || stderr || '(no output)');
      }
    });
  });
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

function buildRequest(opts: CliOptions, messages: AnthropicMessage[]): AnthropicRequest {
  return {
    model: opts.model,
    messages,
    system: opts.system,
    tools: CLI_TOOLS,
    max_tokens: opts.maxTokens,
    stream: true,
  };
}

async function sendMessage(opts: CliOptions, messages: AnthropicMessage[]): Promise<{
  content: string;
  toolCalls: ToolCall[];
  stopReason: string;
}> {
  const url = `${TRILC_BASE}:${opts.port}/v1/messages`;

  const request = buildRequest(opts, messages);

  const { stream } = await httpPost(url, JSON.stringify(request));

  let fullContent = '';
  const toolCalls: ToolCall[] = [];
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

// ── Tool execution loop ──

const MAX_TOOL_ROUNDS = 10;

async function conversationLoop(
  opts: CliOptions,
  messages: AnthropicMessage[],
): Promise<void> {
  const cwd = process.cwd();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await sendMessage(opts, messages);

    // Build assistant message with content + tool_use blocks
    const assistantBlocks: AnthropicMessage['content'] = [];
    if (result.content) {
      assistantBlocks.push({ type: 'text', text: result.content });
    }
    for (const tc of result.toolCalls) {
      assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
    }

    if (Array.isArray(assistantBlocks)) {
      messages.push({ role: 'assistant', content: assistantBlocks });
    }

    // If stop reason is end_turn (no more tool calls), exit loop
    if (result.stopReason === 'end_turn' || result.toolCalls.length === 0) {
      return;
    }

    // Execute tool calls
    console.log(); // blank line before tool execution
    const toolResults: ToolResult[] = [];
    for (const tc of result.toolCalls) {
      process.stdout.write(`  ▶ ${tc.name} ... `);
      const res = await executeTool(tc, cwd);
      toolResults.push(res);
      process.stdout.write(res.is_error ? '✗\n' : '✓\n');
    }

    console.log(); // blank line after tools

    // Send tool results back
    const toolResultBlocks: AnthropicMessage['content'] = toolResults.map(r => ({
      type: 'tool_result' as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error,
    }));
    messages.push({ role: 'user', content: toolResultBlocks });

    // Continue loop - TriLC will process tool results
  }

  console.log('[Max tool rounds reached]');
}

// ── Interactive mode ──

async function interactiveMode(opts: CliOptions): Promise<void> {
  console.log(`Tripilot CLI v${VERSION} (model: ${opts.model}, port: ${opts.port})`);
  console.log('Type your message and press Enter. /exit to quit, /clear to reset.\n');

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
      await conversationLoop(opts, messages);
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
    await conversationLoop(opts, messages);
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
