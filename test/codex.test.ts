import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readCodexSession } from '../src/codex.js';
import { SessionFormatError } from '../src/errors.js';
import type { MessageEvent } from '../src/types.js';
import {
  CODEX_SESSION_ID,
  installCodexFixture,
  temporaryDirectory,
} from './helpers.js';

test('discovers and normalizes canonical Codex response items', async () => {
  const temporary = await temporaryDirectory();
  try {
    const nativePath = await installCodexFixture(temporary.path);

    const session = await readCodexSession(CODEX_SESSION_ID, {
      sessions_root: temporary.path,
    });

    assert.equal(session.provider, 'codex');
    assert.equal(session.session_id, CODEX_SESSION_ID);
    assert.equal(session.cwd, '/work/anima');
    assert.equal(session.native_path, nativePath);
    assert.equal(session.cli_version, '0.146.0');
    assert.deepEqual(
      session.events.map((event) => event.kind),
      [
        'message',
        'message',
        'message',
        'tool_call',
        'tool_result',
        'tool_call',
        'tool_result',
        'tool_call',
        'tool_result',
        'message',
        'message',
        'message',
        'message',
      ],
    );

    const userMessages = session.events.filter(
      (event): event is MessageEvent =>
        event.kind === 'message' && event.role === 'user',
    );
    assert.equal(userMessages.length, 3);
    assert.equal(
      userMessages.filter((event) => event.content[0]?.text === 'Build the reader.')
        .length,
      1,
      'event_msg duplicates should be ignored when response items exist',
    );

    const repeated = userMessages.filter(
      (event) => event.content[0]?.text === 'continue',
    );
    assert.equal(repeated.length, 2);
    assert.notEqual(repeated[0]?.event_id, repeated[1]?.event_id);
    assert.notEqual(
      repeated[0]?.origin.native_position.record,
      repeated[1]?.origin.native_position.record,
    );
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === 'message' &&
          event.content[0]?.text === 'Legacy-only status message.',
      ),
      true,
      'legacy-only event messages should be retained',
    );
    assert.equal(
      session.events.filter(
        (event) =>
          event.kind === 'message' &&
          event.content[0]?.text === 'Repeated status.',
      ).length,
      2,
      'a distant legacy message must not be suppressed by an earlier response item',
    );
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === 'tool_result' && event.call_id === 'shell-1',
      ),
      true,
      'local shell outputs should be preserved',
    );
    const customOutput = session.events.find(
      (event) => event.kind === 'tool_result' && event.call_id === 'call-2',
    );
    assert(customOutput?.kind === 'tool_result');
    assert.equal(customOutput.output, 'first result\nsecond result');
    assert.equal(customOutput.origin.native_event_id, 'call-2');
    assert.equal(
      customOutput.output.includes('data:image'),
      false,
      'non-text output blocks should be excluded',
    );
    assert.equal(
      session.events.some((event) => event.kind === 'context_note'),
      false,
      'turn_context summary modes are not compaction text',
    );
  } finally {
    await temporary.cleanup();
  }
});

test('rejects conflicting Codex metadata IDs', async () => {
  const temporary = await temporaryDirectory();
  try {
    const directory = path.join(temporary.path, '2026', '07', '29');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `rollout-${CODEX_SESSION_ID}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-07-29T11:00:00Z',
        type: 'session_meta',
        payload: {
          id: CODEX_SESSION_ID,
          session_id: '33333333-3333-4333-8333-333333333333',
          cwd: '/work/anima',
        },
      })}\n`,
    );

    await assert.rejects(
      readCodexSession(CODEX_SESSION_ID, {
        sessions_root: temporary.path,
      }),
      SessionFormatError,
    );
  } finally {
    await temporary.cleanup();
  }
});
