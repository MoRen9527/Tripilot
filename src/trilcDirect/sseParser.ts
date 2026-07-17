export type SseEvent = {
	data: string;
	event?: string;
	id?: string;
};

export type SseDebugBuffer = {
	maxLines: number;
	lines: string[];
};

function pushDebugLine(buf: SseDebugBuffer | undefined, line: string): void {
	if (!buf) return;
	const max = Math.max(1, Math.min(500, Number(buf.maxLines) || 0));
	buf.maxLines = max;
	if (!line) return;
	buf.lines.push(line);
	if (buf.lines.length > max) buf.lines.splice(0, buf.lines.length - max);
}

function splitLinesPreserve(text: string): string[] {
	return String(text || '')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n');
}

/**
 * Minimal SSE parser for `text/event-stream`.
 *
 * - Splits on blank-line boundaries.
 * - Supports `data:`, `event:`, `id:` fields.
 * - Concats multiple `data:` lines with `\n`.
 */
export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
	options?: { signal?: AbortSignal; debug?: SseDebugBuffer }
): AsyncIterable<SseEvent> {
	const decoder = new TextDecoder('utf-8');
	const reader = body.getReader();

	let buffer = '';
	while (true) {
		if (options?.signal?.aborted) throw new Error('Canceled.');
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let idx: number;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const rawEvent = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);

			// Keep recent raw SSE lines for diagnostics.
			for (const l of splitLinesPreserve(rawEvent)) {
				pushDebugLine(options?.debug, l);
			}
			pushDebugLine(options?.debug, '');

			const lines = rawEvent.split(/\r?\n/);
			let event: SseEvent = { data: '' };
			const dataParts: string[] = [];

			for (const line of lines) {
				// comment line
				if (!line || line.startsWith(':')) continue;
				const m = /^([a-zA-Z]+):\s?(.*)$/.exec(line);
				if (!m) continue;
				const key = m[1];
				const val = m[2] ?? '';
				switch (key) {
					case 'data':
						dataParts.push(val);
						break;
					case 'event':
						event.event = val;
						break;
					case 'id':
						event.id = val;
						break;
					default:
						break;
				}
			}

			event.data = dataParts.join('\n');
			// spec allows empty data blocks; ignore
			if (event.data.length === 0) continue;
			yield event;
		}
	}
}
