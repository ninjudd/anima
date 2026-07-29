import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_TOOL_OUTPUT_LIMIT,
  buildCanonicalSession,
} from '../src/canonical.js';

test('bounds canonical tool output and records a digest and source', () => {
  const output = `€${'x'.repeat(CANONICAL_TOOL_OUTPUT_LIMIT)}`;
  const session = buildCanonicalSession({
    provider: 'claude',
    session_id: 'session-1',
    cwd: '/work/anima',
    native_path: '/native/session.jsonl',
    warnings: [],
    candidates: [
      {
        kind: 'tool_result',
        output,
        is_error: true,
        call_id: 'call-1',
        native_position: { record: 4, block: 0 },
      },
    ],
  });

  const event = session.events[0];
  assert.equal(event?.kind, 'tool_result');
  if (event?.kind !== 'tool_result') return;

  assert.equal(event.truncated, true);
  assert.equal(Buffer.byteLength(event.output, 'utf8'), CANONICAL_TOOL_OUTPUT_LIMIT);
  assert.equal(event.output_bytes, Buffer.byteLength(output, 'utf8'));
  assert.match(event.output_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(event.source, {
    path: '/native/session.jsonl',
    record: 4,
  });
});
