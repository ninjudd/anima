import assert from 'node:assert/strict';
import test from 'node:test';

import { readCodexSession } from '../src/codex.js';
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
        'tool_call',
        'tool_result',
        'message',
        'message',
        'message',
        'context_note',
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
  } finally {
    await temporary.cleanup();
  }
});
