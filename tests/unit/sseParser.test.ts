import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../../src/copilotDirect/sseParser';

function toStream(chunks: string[]): ReadableStream<Uint8Array> {
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

describe('parseSseStream', () => {
  it('parses single event payload', async () => {
    const stream = toStream(['data: {"ok":true}\n\n']);
    const events = [] as Array<{ data: string; event?: string; id?: string }>;
    for await (const ev of parseSseStream(stream)) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"ok":true}');
  });

  it('parses event and id fields', async () => {
    const stream = toStream(['event: message\nid: e-1\ndata: hello\n\n']);
    const events = [] as Array<{ data: string; event?: string; id?: string }>;
    for await (const ev of parseSseStream(stream)) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'message', id: 'e-1', data: 'hello' });
  });

  it('concats multiple data lines with newline', async () => {
    const stream = toStream(['data: line-1\ndata: line-2\n\n']);
    const events = [] as Array<{ data: string; event?: string; id?: string }>;
    for await (const ev of parseSseStream(stream)) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line-1\nline-2');
  });
});
