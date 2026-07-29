import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  CLAUDE_SESSION_ID,
  installClaudeFixture,
  temporaryDirectory,
} from './helpers.js';

const execFile = promisify(execFileCallback);
const cli = path.resolve('dist/src/cli.js');

test('prints canonical history for a dry-run', async () => {
  const temporary = await temporaryDirectory();
  try {
    await installClaudeFixture(temporary.path);

    const result = await execFile(
      process.execPath,
      [cli, '--claude', CLAUDE_SESSION_ID, '--dry-run'],
      {
        env: {
          ...process.env,
          ANIMA_CLAUDE_PROJECTS_DIR: temporary.path,
        },
      },
    );
    const session = JSON.parse(result.stdout) as {
      provider: string;
      session_id: string;
      events: unknown[];
    };

    assert.equal(session.provider, 'claude');
    assert.equal(session.session_id, CLAUDE_SESSION_ID);
    assert.equal(session.events.length, 9);
  } finally {
    await temporary.cleanup();
  }
});

test('fails closed when target projection is requested', async () => {
  await assert.rejects(
    execFile(process.execPath, [cli, '--claude', CLAUDE_SESSION_ID]),
    (error: unknown) => {
      const failure = error as { stderr?: string; code?: number };
      assert.equal(failure.code, 1);
      assert.match(
        failure.stderr ?? '',
        /Target history projection is not implemented yet/,
      );
      return true;
    },
  );
});
