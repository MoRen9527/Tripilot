import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('tests', 'fixtures', 'generated');
const outFile = path.join(outDir, 'chat-events.sample.json');

function makeEvents(count) {
  const rows = [];
  const base = Date.now();
  for (let i = 0; i < count; i += 1) {
    rows.push({
      eventSeq: i + 1,
      eventId: `evt-${String(i + 1).padStart(4, '0')}`,
      sessionId: 'session-demo',
      traceId: 'trace-demo',
      toolName: i % 5 === 0 ? 'runTests' : 'readFile',
      status: i % 7 === 0 ? 'failed' : i % 3 === 0 ? 'finished' : 'started',
      at: new Date(base + i * 120).toISOString()
    });
  }
  return rows;
}

fs.mkdirSync(outDir, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  total: 120,
  events: makeEvents(120)
};
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
console.log(`Generated fixture: ${outFile}`);
