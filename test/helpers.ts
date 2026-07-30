import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CLAUDE_SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const CODEX_SESSION_ID = '22222222-2222-4222-8222-222222222222';

export async function temporaryDirectory(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'anima-test-'));
  return {
    path: directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function installClaudeFixture(root: string): Promise<string> {
  const project = path.join(root, '-work-anima');
  await mkdir(project, { recursive: true });
  const destination = path.join(project, `${CLAUDE_SESSION_ID}.jsonl`);
  await copyFile(
    path.resolve('test/fixtures/claude/basic.jsonl'),
    destination,
  );
  return destination;
}

export async function installCodexFixture(root: string): Promise<string> {
  const day = path.join(root, '2026', '07', '29');
  await mkdir(day, { recursive: true });
  const destination = path.join(
    day,
    `rollout-2026-07-29T11-00-00-${CODEX_SESSION_ID}.jsonl`,
  );
  await copyFile(path.resolve('test/fixtures/codex/basic.jsonl'), destination);
  return destination;
}

export async function installFakeClaude(
  root: string,
  options: {
    version?: string;
    exit_code?: number;
  } = {},
): Promise<{ command: string; launch_log: string }> {
  const command = path.join(root, 'fake-claude.mjs');
  const launchLog = path.join(root, 'fake-claude-launch.json');
  const version = options.version ?? '2.1.220';
  const exitCode = options.exit_code ?? 0;
  await writeFile(
    command,
    `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

if (process.argv[2] === '--version') {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
if (process.argv[2] === '--resume' && process.argv[3] !== undefined) {
  await writeFile(
    ${JSON.stringify(launchLog)},
    JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      claude_config_dir: process.env.CLAUDE_CONFIG_DIR,
    }),
  );
  process.exit(${String(exitCode)});
}
process.exit(64);
`,
    { mode: 0o700 },
  );
  await chmod(command, 0o700);
  return { command, launch_log: launchLog };
}
