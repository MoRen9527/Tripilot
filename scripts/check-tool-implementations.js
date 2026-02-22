/* eslint-disable no-console */
// Built-in tool implementation coverage check.
// Ensures every exposed tool (OPTIONAL_TOOL_NAMES) is handled by executeToolCall(), either:
// - via a direct switch case, or
// - via the COPILOT_TOOL_ALIASES mapping (Copilot-name compatibility layer).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_TS = path.join(ROOT, 'src', 'extension.ts');

function readText(p) {
	return fs.readFileSync(p, 'utf8');
}

function uniqueSorted(arr) {
	return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

function extractOptionalToolNames(extensionTs) {
	const start = extensionTs.indexOf('const OPTIONAL_TOOL_NAMES');
	if (start < 0) return [];
	const slice = extensionTs.slice(start, start + 12000);
	const open = slice.indexOf('new Set([');
	const close = slice.indexOf(']);', open >= 0 ? open : 0);
	if (open < 0 || close < 0) return [];
	const body = slice.slice(open, close);
	const names = [];
	const re = /'([^']+)'/g;
	let m;
	while ((m = re.exec(body))) names.push(m[1]);
	return uniqueSorted(names);
}

function extractCaseNamesFromExecuteToolCall(extensionTs) {
	const slice = extensionTs.slice(extensionTs.indexOf('async function executeToolCall'));
	const names = [];
	const re = /\bcase\s+'([^']+)'\s*:/g;
	let m;
	while ((m = re.exec(slice))) {
		names.push(m[1]);
	}
	return new Set(names);
}

function extractAliasKeysFromExecuteToolCall(extensionTs) {
	const start = extensionTs.indexOf('const COPILOT_TOOL_ALIASES');
	if (start < 0) return new Set();
	const slice = extensionTs.slice(start, start + 12000);
	const names = [];
	const re = /\n\s*([A-Za-z0-9_\.]+)\s*:\s*'[^']*'/g;
	let m;
	while ((m = re.exec(slice))) {
		names.push(m[1]);
	}
	return new Set(names);
}

function extractAliasMapFromExecuteToolCall(extensionTs) {
	const start = extensionTs.indexOf('const COPILOT_TOOL_ALIASES');
	if (start < 0) return new Map();
	const slice = extensionTs.slice(start, start + 12000);
	const re = /\n\s*([A-Za-z0-9_\.]+)\s*:\s*'([^']+)'/g;
	const out = new Map();
	let m;
	while ((m = re.exec(slice))) {
		out.set(m[1], m[2]);
	}
	return out;
}

function main() {
	const ts = readText(EXTENSION_TS);
	const exposed = extractOptionalToolNames(ts);
	const implemented = extractCaseNamesFromExecuteToolCall(ts);
	const aliasKeys = extractAliasKeysFromExecuteToolCall(ts);
	const aliasMap = extractAliasMapFromExecuteToolCall(ts);

	const missing = exposed.filter((n) => !implemented.has(n) && !aliasKeys.has(n));
	const badAliasTargets = exposed
		.filter((n) => aliasMap.has(n))
		.map((n) => ({ from: n, to: aliasMap.get(n) }))
		.filter((m) => Boolean(m.to) && !implemented.has(String(m.to)));

	console.log('Exposed tools (OPTIONAL_TOOL_NAMES):', exposed.length);
	console.log('Tool switch cases implemented:', implemented.size);
	console.log('Tool alias keys detected:', aliasKeys.size);

	if (missing.length) {
		console.log('\nMissing executeToolCall handlers (case or alias):');
		for (const n of missing) console.log(`- ${n}`);
		process.exit(1);
	}

	if (badAliasTargets.length) {
		console.log('\nAlias targets missing executeToolCall switch cases:');
		for (const m of badAliasTargets) console.log(`- ${m.from} -> ${m.to}`);
		process.exit(1);
	}
	console.log('\nOK: All exposed tools are handled by executeToolCall.');
}

main();
