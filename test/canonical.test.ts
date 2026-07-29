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

test('keeps ID-backed event identities stable across transcript rewrites', () => {
  const base = {
    provider: 'claude' as const,
    session_id: 'session-1',
    cwd: '/work/anima',
    native_path: '/native/session.jsonl',
    warnings: [],
  };
  const first = buildCanonicalSession({
    ...base,
    candidates: [
      {
        kind: 'message',
        role: 'assistant',
        text: 'Stable message',
        native_event_id: 'message-1',
        native_position: { record: 4, block: 0 },
        timestamp: '2026-07-29T10:00:00Z',
      },
    ],
  });
  const rewritten = buildCanonicalSession({
    ...base,
    candidates: [
      {
        kind: 'message',
        role: 'assistant',
        text: 'Stable message',
        native_event_id: 'message-1',
        native_position: { record: 40, block: 0 },
        timestamp: '2026-07-30T10:00:00Z',
      },
    ],
  });

  assert.equal(first.events[0]?.event_id, rewritten.events[0]?.event_id);
});

test('uses native positions to distinguish repeated ID-less events', () => {
  const session = buildCanonicalSession({
    provider: 'codex',
    session_id: 'session-1',
    cwd: '/work/anima',
    native_path: '/native/session.jsonl',
    warnings: [],
    candidates: [
      {
        kind: 'message',
        role: 'user',
        text: 'continue',
        native_position: { record: 4, block: 0 },
      },
      {
        kind: 'message',
        role: 'user',
        text: 'continue',
        native_position: { record: 8, block: 0 },
      },
    ],
  });

  assert.notEqual(session.events[0]?.event_id, session.events[1]?.event_id);
});
