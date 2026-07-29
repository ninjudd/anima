import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readClaudeSession } from '../src/claude.js';
import { SessionFormatError } from '../src/errors.js';
import {
  CLAUDE_SESSION_ID,
  installClaudeFixture,
  temporaryDirectory,
} from './helpers.js';

test('discovers and normalizes the active Claude branch', async () => {
  const temporary = await temporaryDirectory();
  try {
    const nativePath = await installClaudeFixture(temporary.path);

    const session = await readClaudeSession(CLAUDE_SESSION_ID, {
      projects_root: temporary.path,
    });

    assert.equal(session.provider, 'claude');
    assert.equal(session.session_id, CLAUDE_SESSION_ID);
    assert.equal(session.cwd, '/work/anima');
    assert.equal(session.native_path, nativePath);
    assert.equal(session.cli_version, '2.1.220');
    assert.equal(session.title, 'Build offline readers');
    assert.deepEqual(
      session.events.map((event) => event.kind),
      ['message', 'message', 'tool_call', 'tool_result', 'message'],
    );
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === 'message' &&
          event.content.some((block) => block.text.includes('inactive')),
      ),
      false,
    );
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === 'message' &&
          event.content.some((block) => block.text.includes('Sidechain')),
      ),
      false,
    );
    assert.equal(session.events[0]?.parent_event_id, null);
    for (let index = 1; index < session.events.length; index += 1) {
      assert.equal(
        session.events[index]?.parent_event_id,
        session.events[index - 1]?.event_id,
      );
    }
  } finally {
    await temporary.cleanup();
  }
});

test('rejects a Claude transcript with no embedded session ID', async () => {
  const temporary = await temporaryDirectory();
  try {
    const project = path.join(temporary.path, '-work-anima');
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, `${CLAUDE_SESSION_ID}.jsonl`),
      '{"type":"user","uuid":"u1","parentUuid":null,"cwd":"/work/anima","message":{"role":"user","content":"hello"}}\n',
    );

    await assert.rejects(
      readClaudeSession(CLAUDE_SESSION_ID, {
        projects_root: temporary.path,
      }),
      SessionFormatError,
    );
  } finally {
    await temporary.cleanup();
  }
});
