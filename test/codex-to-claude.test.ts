import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readClaudeSession } from '../src/claude.js';
import { transferCodexToClaude } from '../src/codex-to-claude.js';
import { ClaudeLaunchError, ClaudeTranscriptError } from '../src/errors.js';
import {
  CODEX_SESSION_ID,
  installCodexFixture,
  installFakeClaude,
  temporaryDirectory,
} from './helpers.js';

async function onlyTransferRecord(dataRoot: string): Promise<{
  state: string;
  lineage_id?: string;
  projection_id?: string;
  error?: { message: string };
}> {
  const directory = path.join(dataRoot, 'transfers');
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  return JSON.parse(
    await readFile(path.join(directory, files[0]!), 'utf8'),
  ) as {
    state: string;
    lineage_id?: string;
    projection_id?: string;
    error?: { message: string };
  };
}

test('creates, validates, records, and launches a Claude session', async () => {
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
    let status = '';

    const result = await transferCodexToClaude(CODEX_SESSION_ID, {
      codex_sessions_root: sessionsRoot,
      claude_projects_root: projectsRoot,
      data_root: dataRoot,
      cwd: workspace,
      claude_command: path.relative(process.cwd(), fake.command),
      status_writer: (text) => {
        status += text;
      },
    });

    assert.match(status, new RegExp(result.target_session_id));
    assert.match(status, /Resume manually:/);
    const launch = JSON.parse(await readFile(fake.launch_log, 'utf8')) as {
      args: string[];
      cwd: string;
      claude_config_dir: string;
    };
    assert.deepEqual(launch.args, ['--resume', result.target_session_id]);
    assert.equal(launch.cwd, await realpath(workspace));
    assert.equal(launch.claude_config_dir, path.dirname(projectsRoot));
    assert.match(result.manual_resume_command, /CLAUDE_CONFIG_DIR=/);
    assert.match(result.manual_resume_command, new RegExp(fake.command));

    const target = await readClaudeSession(result.target_session_id, {
      projects_root: projectsRoot,
    });
    assert.equal(target.cwd, await realpath(workspace));
    assert.equal(target.cli_version, '2.1.220');
    assert.equal(target.events.length > 0, true);
    assert.equal(target.events.every((event) => event.kind === 'message'), true);

    const transfer = await onlyTransferRecord(dataRoot);
    assert.equal(transfer.state, 'complete');
    assert.equal(transfer.lineage_id, result.lineage_id);
    assert.equal(transfer.projection_id, result.projection_id);
    assert.equal(transfer.error, undefined);

    const projectionPath = path.join(
      dataRoot,
      'projections',
      'claude',
      `${result.target_session_id}.json`,
    );
    const projection = JSON.parse(
      await readFile(projectionPath, 'utf8'),
    ) as {
      native_cursor: {
        byte_offset: number;
        record_count: number;
        nearby_event_fingerprints: string[];
      };
    };
    assert.equal(projection.native_cursor.byte_offset, (await stat(result.target_path)).size);
    assert.equal(
      projection.native_cursor.record_count,
      target.events.length,
    );
    assert.equal(
      projection.native_cursor.nearby_event_fingerprints.length,
      4,
    );
    assert.equal((await stat(result.target_path)).mode & 0o777, 0o600);
    assert.equal((await stat(projectionPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dataRoot)).mode & 0o777, 0o700);
  } finally {
    await temporary.cleanup();
  }
});

test('archives canonical history but creates no target for an unknown Claude version', async () => {
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
    const fake = await installFakeClaude(temporary.path, {
      version: '2.1.221',
    });

    await assert.rejects(
      transferCodexToClaude(CODEX_SESSION_ID, {
        codex_sessions_root: sessionsRoot,
        claude_projects_root: projectsRoot,
        data_root: dataRoot,
        cwd: workspace,
        claude_command: fake.command,
        status_writer: () => undefined,
      }),
      (error: unknown) =>
        error instanceof ClaudeTranscriptError &&
        error.message.includes('No Claude transcript was created'),
    );

    const transfer = await onlyTransferRecord(dataRoot);
    assert.equal(transfer.state, 'normalized');
    assert.match(transfer.error?.message ?? '', /2\.1\.221/);
    assert.equal(
      (
        await readdir(path.join(dataRoot, 'lineages', transfer.lineage_id!))
      ).includes('events.jsonl'),
      true,
    );
    await assert.rejects(stat(projectsRoot), { code: 'ENOENT' });
  } finally {
    await temporary.cleanup();
  }
});

test('regenerates a colliding Claude session ID without overwriting it', async () => {
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
    const existingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const selectedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const project = path.join(projectsRoot, '-another-project');
    await mkdir(project, { recursive: true });
    const existingPath = path.join(project, `${existingId}.jsonl`);
    await writeFile(existingPath, 'existing transcript\n');
    const fake = await installFakeClaude(temporary.path);
    const ids = [existingId, selectedId];

    const result = await transferCodexToClaude(CODEX_SESSION_ID, {
      codex_sessions_root: sessionsRoot,
      claude_projects_root: projectsRoot,
      data_root: dataRoot,
      cwd: workspace,
      claude_command: fake.command,
      session_id_factory: () => {
        const value = ids.shift();
        assert(value !== undefined);
        return value;
      },
      status_writer: () => undefined,
    });

    assert.equal(result.target_session_id, selectedId);
    assert.equal(await readFile(existingPath, 'utf8'), 'existing transcript\n');
  } finally {
    await temporary.cleanup();
  }
});

test('retains the durable target and records launch failure', async () => {
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
    const fake = await installFakeClaude(temporary.path, { exit_code: 7 });

    await assert.rejects(
      transferCodexToClaude(CODEX_SESSION_ID, {
        codex_sessions_root: sessionsRoot,
        claude_projects_root: projectsRoot,
        data_root: dataRoot,
        cwd: workspace,
        claude_command: fake.command,
        status_writer: () => undefined,
      }),
      ClaudeLaunchError,
    );

    const transfer = await onlyTransferRecord(dataRoot);
    assert.equal(transfer.state, 'launch_failed');
    assert.match(transfer.error?.message ?? '', /status 7/);
    const projectionFiles = await readdir(
      path.join(dataRoot, 'projections', 'claude'),
    );
    assert.equal(projectionFiles.length, 1);
    const projection = JSON.parse(
      await readFile(
        path.join(dataRoot, 'projections', 'claude', projectionFiles[0]!),
        'utf8',
      ),
    ) as { native_log_path: string };
    assert.equal((await stat(projection.native_log_path)).isFile(), true);
  } finally {
    await temporary.cleanup();
  }
});
