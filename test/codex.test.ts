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
        'message',
        'message',
        'message',
        'tool_call',
        'tool_result',
        'tool_call',
        'tool_result',
        'tool_call',
        'tool_result',
        'tool_call',
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
      'visible user messages should be sourced once from event_msg records',
    );
    assert.equal(
      userMessages.some(
        (event) => event.content[0]?.text === 'Injected AGENTS context.',
      ),
      false,
      'user response items without visible event messages should be excluded',
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
          event.kind === 'message' &&
          event.content[0]?.text === 'First half second half',
      ),
      false,
      'combined agent_message mirrors should be deduplicated',
    );
    assert.equal(
      session.events.filter(
        (event) =>
          event.kind === 'message' &&
          (event.content[0]?.text === 'First half' ||
            event.content[0]?.text === ' second half'),
      ).length,
      2,
      'block-level assistant content should remain canonical',
    );
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === 'tool_result' && event.call_id === 'shell-1',
      ),
      true,
      'local shell outputs should be preserved',
    );
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === 'message' &&
          event.role === 'assistant' &&
          event.content[0]?.text === 'I cannot perform that action.',
      ),
      true,
      'assistant refusal blocks should be preserved',
    );
    const webSearch = session.events.find(
      (event) =>
        event.kind === 'tool_call' && event.tool_name === 'web_search',
    );
    assert(webSearch?.kind === 'tool_call');
    assert.equal(webSearch.call_id, 'web-1');
    assert.deepEqual(webSearch.input, {
      action: {
        type: 'search',
        query: 'anima context transfer',
      },
      status: 'completed',
    });
    const callWithoutItemId = session.events.find(
      (event) => event.kind === 'tool_call' && event.call_id === 'call-3',
    );
    assert.equal(callWithoutItemId?.origin.native_event_id, 'call-3');
    const shellWithoutItemId = session.events.find(
      (event) => event.kind === 'tool_call' && event.call_id === 'shell-1',
    );
    assert.equal(shellWithoutItemId?.origin.native_event_id, 'shell-1');
    const lookalikeOutput = session.events.find(
      (event) => event.kind === 'tool_result' && event.call_id === 'call-1',
    );
    assert(lookalikeOutput?.kind === 'tool_result');
    assert.equal(
      lookalikeOutput.output,
      '{"metadata":{"source":"tool"},"output":"README contents"}',
    );
    assert.equal(lookalikeOutput.is_error, false);
    const customOutput = session.events.find(
      (event) => event.kind === 'tool_result' && event.call_id === 'call-2',
    );
    assert(customOutput?.kind === 'tool_result');
    assert.equal(customOutput.output, 'first result\nsecond result');
    assert.equal(customOutput.is_error, true);
    assert.equal(customOutput.origin.native_event_id, 'call-2');
    assert.equal(
      customOutput.output.includes('data:image'),
      false,
      'non-text output blocks should be excluded',
    );
    const envelopeOutput = session.events.find(
      (event) => event.kind === 'tool_result' && event.call_id === 'call-3',
    );
    assert(envelopeOutput?.kind === 'tool_result');
    assert.equal(envelopeOutput.output, 'command failed');
    assert.equal(envelopeOutput.is_error, true);
    assert.equal(envelopeOutput.output.includes('duration_seconds'), false);
    const contextNotes = session.events.filter(
      (event) => event.kind === 'context_note',
    );
    assert.equal(
      contextNotes.length,
      0,
      'encrypted Codex compaction records should not become context notes',
    );
  } finally {
    await temporary.cleanup();
  }
});

test('accepts distinct Codex rollout and enclosing session IDs', async () => {
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

    const session = await readCodexSession(CODEX_SESSION_ID, {
      sessions_root: temporary.path,
    });

    assert.equal(session.session_id, CODEX_SESSION_ID);
  } finally {
    await temporary.cleanup();
  }
});

test('rejects a mismatched authoritative Codex rollout ID', async () => {
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
          id: '33333333-3333-4333-8333-333333333333',
          session_id: CODEX_SESSION_ID,
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

test('uses the final Codex cwd without contradictory warnings', async () => {
  const temporary = await temporaryDirectory();
  try {
    const directory = path.join(temporary.path, '2026', '07', '29');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `rollout-${CODEX_SESSION_ID}.jsonl`),
      `${[
        {
          timestamp: '2026-07-29T11:00:00Z',
          type: 'session_meta',
          payload: {
            id: CODEX_SESSION_ID,
            cwd: '/work/anima',
          },
        },
        {
          timestamp: '2026-07-29T11:00:01Z',
          type: 'turn_context',
          payload: { cwd: '/work/other' },
        },
        {
          timestamp: '2026-07-29T11:00:02Z',
          type: 'turn_context',
          payload: { cwd: '/work/anima' },
        },
      ].map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const session = await readCodexSession(CODEX_SESSION_ID, {
      sessions_root: temporary.path,
    });

    assert.equal(session.cwd, '/work/anima');
    assert.deepEqual(session.warnings, [
      {
        code: 'cwd_changed',
        message:
          'Codex session recorded working directory changes from /work/anima; final directory is /work/anima.',
      },
    ]);
  } finally {
    await temporary.cleanup();
  }
});
