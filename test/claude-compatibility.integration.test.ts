import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readClaudeSession } from '../src/claude.js';
import {
  encodeClaudeTranscript,
  SUPPORTED_CLAUDE_TRANSCRIPT_VERSION,
} from '../src/claude-transcript.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.ANIMA_CLAUDE_INTEGRATION === '1';
const OUTPUT_LIMIT = 1024 * 1024;

async function runClaude(
  command: string,
  arguments_: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminalError: Error | undefined;
    const terminate = (error: Error) => {
      if (settled || terminalError !== undefined) return;
      terminalError = error;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > OUTPUT_LIMIT) {
        terminate(new Error('Claude integration output exceeded 1 MiB.'));
      }
      return next;
    };
    const handleAbort = () => {
      terminate(new Error('Claude integration was aborted.'));
    };
    const timer = setTimeout(() => {
      terminate(
        new Error(
          `Claude integration timed out after ${String(timeoutMs)}ms.`,
        ),
      );
    }, timeoutMs);
    timer.unref();
    if (signal.aborted) {
      handleAbort();
    } else {
      signal.addEventListener('abort', handleAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (code, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `Claude exited with ${
            exitSignal === null
              ? `status ${String(code)}`
              : `signal ${exitSignal}`
          }: ${stderr.trim()}`,
        ),
      );
    });
  });
}

test('terminates a hung integration child at its deadline', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runClaude(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)'],
      process.cwd(),
      process.env,
      new AbortController().signal,
      50,
    ),
    /timed out after 50ms/,
  );
  assert.equal(Date.now() - startedAt < 1_000, true);
});

test(
  'resumes an offline-generated Claude transcript',
  { skip: !enabled, timeout: 60_000 },
  async (context) => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'anima-claude-integration-'),
    );
    const configRoot = path.join(root, 'config');
    const workspace = path.join(root, 'workspace');
    const sessionId = randomUUID();
    const userText = `ANIMA_IMPORTED_USER_${randomUUID()}`;
    const assistantText = `ANIMA_IMPORTED_ASSISTANT_${randomUUID()}`;
    const command = process.env.ANIMA_CLAUDE_COMMAND ?? 'claude';

    try {
      await mkdir(workspace, { recursive: true });
      const cwd = await realpath(workspace);
      const { stdout: versionOutput } = await execFileAsync(
        command,
        ['--version'],
        { cwd, signal: context.signal },
      );
      const version = versionOutput.trim().split(' ')[0];
      assert.equal(version, SUPPORTED_CLAUDE_TRANSCRIPT_VERSION);

      const encoded = encodeClaudeTranscript({
        session_id: sessionId,
        cwd,
        cli_version: version,
        messages: [
          { role: 'user', text: userText },
          { role: 'assistant', text: assistantText },
        ],
      });
      const project = path.join(
        configRoot,
        'projects',
        encoded.project_directory,
      );
      await mkdir(project, { recursive: true });
      await writeFile(path.join(configRoot, '.claude.json'), '{}\n', {
        mode: 0o600,
      });
      await writeFile(
        path.join(project, `${sessionId}.jsonl`),
        encoded.jsonl,
        { mode: 0o600 },
      );

      const expected = `${userText}|${assistantText}`;
      const verificationPrompt =
        'Reply with the exact text of the two conversation messages immediately before this one, oldest first, joined by a single |, and nothing else.';
      const stdout = await runClaude(
        command,
        [
          '-p',
          '--safe-mode',
          '--tools',
          '',
          '--resume',
          sessionId,
          '--output-format',
          'json',
          '--max-budget-usd',
          '0.10',
          verificationPrompt,
        ],
        cwd,
        {
          ...process.env,
          CLAUDE_CONFIG_DIR: configRoot,
        },
        context.signal,
        45_000,
      );
      const resultLine = stdout
        .trim()
        .split('\n')
        .reverse()
        .find((line) => line.startsWith('{'));
      assert(resultLine !== undefined);
      const result = JSON.parse(resultLine) as Record<string, unknown>;
      assert.equal(result.is_error, false);
      assert.equal(result.result, expected);

      const session = await readClaudeSession(sessionId, {
        projects_root: path.join(configRoot, 'projects'),
      });
      assert.deepEqual(
        session.events
          .filter((event) => event.kind === 'message')
          .map((event) => ({
            role: event.role,
            text: event.content[0]?.text,
          }))
          .slice(0, 4),
        [
          { role: 'user', text: userText },
          { role: 'assistant', text: assistantText },
          { role: 'user', text: verificationPrompt },
          { role: 'assistant', text: expected },
        ],
      );

      const transcript = await readFile(
        path.join(project, `${sessionId}.jsonl`),
        'utf8',
      );
      const linked = transcript
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => typeof record.uuid === 'string');
      assert.equal(linked[0]?.parentUuid, null);
      for (let index = 1; index < linked.length; index += 1) {
        assert.equal(linked[index]?.parentUuid, linked[index - 1]?.uuid);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
