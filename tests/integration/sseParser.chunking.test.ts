import { describe, expect, it } from 'vitest';
import { parseSseStream, type SseDebugBuffer } from '../../src/copilotDirect/sseParser';

function toChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

describe('parseSseStream chunking integration', () => {
  it('parses events split across chunks and keeps debug lines bounded', async () => {
    const debug: SseDebugBuffer = { maxLines: 3, lines: [] };
    const stream = toChunkedStream([
      'event: message\nid: 1\nda',
      'ta: part-A\n\n',
      'data: part-B\n\n'
    ]);

    const payloads: string[] = [];
    for await (const ev of parseSseStream(stream, { debug })) {
      payloads.push(ev.data);
    }

    expect(payloads).toEqual(['part-A', 'part-B']);
    expect(debug.lines.length).toBeLessThanOrEqual(3);
  });
});
