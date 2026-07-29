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
      [
        'message',
        'message',
        'tool_call',
        'tool_result',
        'tool_result',
        'tool_result',
        'message',
        'context_note',
      ],
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
    const imageResult = session.events.find(
      (event) => event.kind === 'tool_result' && event.call_id === 'call-image',
    );
    assert(imageResult?.kind === 'tool_result');
    assert.equal(imageResult.output, '[non-text tool result omitted]');
    assert.equal(JSON.stringify(session).includes('excluded-binary-data'), false);
    const mixedResult = session.events.find(
      (event) => event.kind === 'tool_result' && event.call_id === 'call-mixed',
    );
    assert(mixedResult?.kind === 'tool_result');
    assert.equal(
      mixedResult.output,
      'Screenshot attached.\n[non-text tool result omitted]',
    );
    assert.equal(JSON.stringify(session).includes('excluded-mixed-data'), false);

    const toolCall = session.events.find(
      (event) => event.kind === 'tool_call' && event.call_id === 'call-1',
    );
    assert.equal(toolCall?.origin.native_event_id, 'call-1');
    const toolResult = session.events.find(
      (event) => event.kind === 'tool_result' && event.call_id === 'call-1',
    );
    assert.equal(toolResult?.origin.native_event_id, 'call-1');

    const compaction = session.events.find(
      (event) => event.kind === 'context_note',
    );
    assert(compaction?.kind === 'context_note');
    assert.equal(compaction.label, 'Claude compaction summary');
    assert.equal(compaction.content[0]?.text, 'Earlier work was summarized.');
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === 'message' &&
          event.content[0]?.text === 'Earlier work was summarized.',
      ),
      false,
      'compact summaries must not be live user messages',
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
