/* eslint-disable no-console */
// Copilot built-in-tools alignment check.
// Expected tool names are derived from the optional reference/copilot/built-in-tools folder structure:
// - agent/edit/execute/read/search/vscode/web: tool name == markdown filename (without .md), excluding overview/readme
// - todo: category page; Tripilot aligns via manage_todo_list
// We then compare against:
// - OPTIONAL_TOOL_NAMES in src/extension.ts (the exposed tool surface)
// - tripilot.enabledBuiltinTools default list in package.json

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REF_DIR = path.join(ROOT, 'reference', 'copilot', 'built-in-tools');
const EXTENSION_TS = path.join(ROOT, 'src', 'extension.ts');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

function walkFiles(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full));
		else out.push(full);
	}
	return out;
}

function readText(p) {
	return fs.readFileSync(p, 'utf8');
}

function uniqueSorted(arr) {
	return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

function extractExpectedToolNamesFromReference() {
	const expected = [];
	const categories = ['agent', 'edit', 'execute', 'read', 'search', 'vscode', 'web'];
	for (const cat of categories) {
		const dir = path.join(REF_DIR, cat);
		if (!fs.existsSync(dir)) continue;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith('.md')) continue;
			const lower = entry.name.toLowerCase();
			if (lower === 'overview.md' || lower === 'readme.md') continue;
			expected.push(entry.name.replace(/\.md$/i, ''));
		}
	}
	// todo is a category page (todo.md). Tool alignment is manage_todo_list.
	expected.push('manage_todo_list');
	return uniqueSorted(expected);
}

function extractOptionalToolNamesFromExtension(extensionTs) {
	// Extract string literals inside const OPTIONAL_TOOL_NAMES = new Set([ ... ]);
	const start = extensionTs.indexOf('const OPTIONAL_TOOL_NAMES');
	if (start < 0) return [];
	const slice = extensionTs.slice(start, start + 8000);
	const open = slice.indexOf('new Set([');
	const close = slice.indexOf(']);', open >= 0 ? open : 0);
	if (open < 0 || close < 0) return [];
	const body = slice.slice(open, close);
	const names = [];
	const re = /'([^']+)'/g;
	let m;
	while ((m = re.exec(body))) names.push(m[1]);
	return names;
}

function extractDefaultEnabledToolNames(pkgJsonText) {
	let pkg;
	try {
		pkg = JSON.parse(pkgJsonText);
	} catch (e) {
		throw new Error(`package.json is not valid JSON: ${e && e.message ? e.message : String(e)}`);
	}
	const list =
		pkg &&
		pkg.contributes &&
		pkg.contributes.configuration &&
		pkg.contributes.configuration.properties &&
		pkg.contributes.configuration.properties['tripilot.enabledBuiltinTools'] &&
		pkg.contributes.configuration.properties['tripilot.enabledBuiltinTools'].default;
	if (!Array.isArray(list)) return [];
	return list.map(String);
}

function main() {
	if (!fs.existsSync(REF_DIR)) {
		console.warn(`Reference dir not found, skipping Copilot built-in tool alignment check: ${REF_DIR}`);
		return;
	}
	const expected = extractExpectedToolNamesFromReference();

	const extensionTs = readText(EXTENSION_TS);
	const optional = new Set(extractOptionalToolNamesFromExtension(extensionTs));

	const pkgText = readText(PACKAGE_JSON);
	const enabled = new Set(extractDefaultEnabledToolNames(pkgText));

	const missingOptional = expected.filter((n) => !optional.has(n));
	const extraOptional = uniqueSorted(Array.from(optional)).filter((n) => !expected.includes(n));
	const missingEnabled = expected.filter((n) => !enabled.has(n));
	const extraEnabled = uniqueSorted(Array.from(enabled)).filter((n) => !expected.includes(n));

	console.log('Expected Copilot tool names:', expected.length);
	console.log('OPTIONAL_TOOL_NAMES detected:', optional.size);
	console.log('Enabled default tool names detected:', enabled.size);

	if (missingOptional.length) {
		console.log('\nMissing in OPTIONAL_TOOL_NAMES:');
		for (const n of missingOptional) console.log(`- ${n}`);
	}
	if (extraOptional.length) {
		console.log('\nExtra in OPTIONAL_TOOL_NAMES (should be removed):');
		for (const n of extraOptional) console.log(`- ${n}`);
	}
	if (missingEnabled.length) {
		console.log('\nMissing in tripilot.enabledBuiltinTools default:');
		for (const n of missingEnabled) console.log(`- ${n}`);
	}
	if (extraEnabled.length) {
		console.log('\nExtra in tripilot.enabledBuiltinTools default (should be removed):');
		for (const n of extraEnabled) console.log(`- ${n}`);
	}

	if (missingOptional.length || extraOptional.length || missingEnabled.length || extraEnabled.length) {
		process.exit(1);
	}
	console.log('\nOK: Copilot built-in tool alignment looks complete.');
}

main();
