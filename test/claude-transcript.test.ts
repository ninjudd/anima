import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readClaudeSession } from '../src/claude.js';
import {
  claudeProjectDirectoryName,
  encodeClaudeTranscript,
  SUPPORTED_CLAUDE_TRANSCRIPT_VERSION,
} from '../src/claude-transcript.js';
import { ClaudeTranscriptError } from '../src/errors.js';
import { temporaryDirectory } from './helpers.js';

const SESSION_ID = '99999999-9999-4999-8999-999999999999';
const FIXTURE = new URL(
  '../../test/fixtures/claude/2.1.220/generated.jsonl',
  import.meta.url,
);

function uuidFactory(values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    assert(value !== undefined, 'UUID fixture was exhausted');
    index += 1;
    return value;
  };
}

test('encodes the Claude 2.1.220 transcript template', async () => {
  const encoded = encodeClaudeTranscript({
    session_id: SESSION_ID,
    cwd: '/work/anima',
    cli_version: SUPPORTED_CLAUDE_TRANSCRIPT_VERSION,
    messages: [
      { role: 'user', text: 'Imported user context.' },
      { role: 'assistant', text: 'Imported assistant context.' },
    ],
    started_at: '2026-07-29T17:20:00.000Z',
    uuid_factory: uuidFactory([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]),
  });

  assert.equal(encoded.project_directory, '-work-anima');
  assert.equal(
    encoded.leaf_uuid,
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  assert.equal(encoded.jsonl, await readFile(FIXTURE, 'utf8'));
});

test('round-trips an encoded transcript through the Claude reader', async () => {
  const temporary = await temporaryDirectory();
  try {
    const encoded = encodeClaudeTranscript({
      session_id: SESSION_ID,
      cwd: '/work/anima',
      cli_version: SUPPORTED_CLAUDE_TRANSCRIPT_VERSION,
      messages: [
        { role: 'user', text: 'Imported user context.' },
        { role: 'assistant', text: 'Imported assistant context.' },
      ],
      started_at: '2026-07-29T17:20:00.000Z',
    });
    const project = path.join(
      temporary.path,
      encoded.project_directory,
    );
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, `${encoded.session_id}.jsonl`),
      encoded.jsonl,
    );

    const session = await readClaudeSession(SESSION_ID, {
      projects_root: temporary.path,
    });
    assert.equal(session.cli_version, SUPPORTED_CLAUDE_TRANSCRIPT_VERSION);
    assert.deepEqual(
      session.events.map((event) => ({
        kind: event.kind,
        ...(event.kind === 'message' ? { role: event.role } : {}),
        text:
          event.kind === 'message' || event.kind === 'context_note'
            ? event.content[0]?.text
            : undefined,
      })),
      [
        {
          kind: 'message',
          role: 'user',
          text: 'Imported user context.',
        },
        {
          kind: 'message',
          role: 'assistant',
          text: 'Imported assistant context.',
        },
      ],
    );
  } finally {
    await temporary.cleanup();
  }
});

test('preserves a single parent-linked chain across repeated roles', () => {
  const encoded = encodeClaudeTranscript({
    session_id: SESSION_ID,
    cwd: '/work/anima',
    cli_version: SUPPORTED_CLAUDE_TRANSCRIPT_VERSION,
    messages: [
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'two' },
      { role: 'assistant', text: 'three' },
      { role: 'user', text: 'four' },
    ],
    started_at: '2026-07-29T17:20:00.000Z',
  });

  assert.equal(encoded.records[0]?.parentUuid, null);
  for (let index = 1; index < encoded.records.length; index += 1) {
    assert.equal(
      encoded.records[index]?.parentUuid,
      encoded.records[index - 1]?.uuid,
    );
  }
});

test('uses Claude Code project-directory escaping', () => {
  assert.equal(
    claudeProjectDirectoryName('/private/tmp/anima_claude.path-test'),
    '-private-tmp-anima-claude-path-test',
  );
  assert.throws(
    () => claudeProjectDirectoryName('relative/path'),
    ClaudeTranscriptError,
  );
});

test('fails closed for an unvalidated Claude transcript version', () => {
  assert.throws(
    () =>
      encodeClaudeTranscript({
        session_id: SESSION_ID,
        cwd: '/work/anima',
        cli_version: '2.1.221',
        messages: [{ role: 'user', text: 'hello' }],
      }),
    (error: unknown) =>
      error instanceof ClaudeTranscriptError &&
      error.message.includes(
        'version 2.1.221 is not supported; expected 2.1.220',
      ),
  );
});

test('rejects a target session ID that Claude cannot resume', () => {
  assert.throws(
    () =>
      encodeClaudeTranscript({
        session_id: 'not-a-uuid',
        cwd: '/work/anima',
        cli_version: SUPPORTED_CLAUDE_TRANSCRIPT_VERSION,
        messages: [{ role: 'user', text: 'hello' }],
      }),
    (error: unknown) =>
      error instanceof ClaudeTranscriptError &&
      error.message ===
        'Claude transcript session_id must be a UUID: not-a-uuid',
  );
});
