/**
 * ── TriPilot CLI Bundler ──
 * Bundles the standalone CLI into a single self-contained JS file,
 * following the Claude Code / opencode packaging pattern.
 *
 * Usage: npx tsx script/build-cli.ts
 * Output: dist/tripilot-cli-bundle.js
 */

import * as esbuild from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

async function build() {
  console.log('[build-cli] Bundling Tripilot CLI...');

  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'cli', 'tripilot-cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(root, 'dist', 'tripilot-cli-bundle.js'),
    banner: {
      js: '#!/usr/bin/env node',
    },
    external: [
      // Node built-ins — not bundled
      'node:*',
      'http', 'https', 'fs', 'path', 'os',
      'child_process', 'stream', 'readline',
      'util', 'url', 'crypto', 'events',
      'assert', 'buffer', 'tty',
    ],
    // Resolve @trimetaverse/tricode → ../TriCode/src/index.ts (TS source)
    alias: {
      '@trimetaverse/tricode': path.join(root, '..', 'TriCode', 'src', 'index.ts'),
    },
    // Keep the tricodeBridge require → alias resolves it
    loader: {
      '.ts': 'ts',
    },
    tsconfig: path.join(root, 'tsconfig.json'),
    minify: false,
    sourcemap: false,
    metafile: true,
  });

  const outputs = Object.keys(result.metafile?.outputs ?? {});
  for (const out of outputs) {
    console.log(`  ✓ ${path.relative(root, out)}`);
  }

  // Make executable
  const fs = await import('fs');
  const outfile = path.join(root, 'dist', 'tripilot-cli-bundle.js');
  try {
    fs.chmodSync(outfile, 0o755);
  } catch {
    // Windows — chmod not needed
  }

  console.log('[build-cli] Done.');
}

build().catch((err) => {
  console.error('[build-cli] Build failed:', err);
  process.exit(1);
});
