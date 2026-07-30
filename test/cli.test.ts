import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  CLAUDE_SESSION_ID,
  CODEX_SESSION_ID,
  installClaudeFixture,
  installCodexFixture,
  installFakeClaude,
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

test('fails closed when Claude-to-Codex projection is requested', async () => {
  await assert.rejects(
    execFile(process.execPath, [cli, '--claude', CLAUDE_SESSION_ID]),
    (error: unknown) => {
      const failure = error as { stderr?: string; code?: number };
      assert.equal(failure.code, 1);
      assert.match(
        failure.stderr ?? '',
        /Claude-to-Codex projection is not enabled yet/,
      );
      return true;
    },
  );
});

test('transfers a Codex session to Claude and launches the new session', async () => {
  const temporary = await temporaryDirectory();
  try {
    const sessionsRoot = path.join(temporary.path, 'codex-sessions');
    const projectsRoot = path.join(
      temporary.path,
      'claude-config',
      'projects',
    );
    const dataRoot = path.join(temporary.path, 'anima-data');
    const workspace = path.join(temporary.path, 'workspace');
    await installCodexFixture(sessionsRoot);
    await mkdir(workspace, { recursive: true });
    const fake = await installFakeClaude(temporary.path);

    const result = await execFile(
      process.execPath,
      [cli, '--codex', CODEX_SESSION_ID, '--cwd', workspace],
      {
        env: {
          ...process.env,
          ANIMA_CODEX_SESSIONS_DIR: sessionsRoot,
          ANIMA_CLAUDE_PROJECTS_DIR: projectsRoot,
          ANIMA_DATA_DIR: dataRoot,
          ANIMA_CLAUDE_COMMAND: fake.command,
        },
      },
    );

    const targetId = result.stdout.match(
      /Created Claude session ([0-9a-f-]{36})/,
    )?.[1];
    assert(targetId !== undefined);
    const launch = JSON.parse(await readFile(fake.launch_log, 'utf8')) as {
      args: string[];
      cwd: string;
      claude_config_dir: string;
    };
    assert.deepEqual(launch.args, ['--resume', targetId]);
    assert.equal(launch.cwd, await realpath(workspace));
    assert.equal(launch.claude_config_dir, path.dirname(projectsRoot));
  } finally {
    await temporary.cleanup();
  }
});
