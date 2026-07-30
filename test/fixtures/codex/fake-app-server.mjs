import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.argv[2];
if (logPath === undefined) throw new Error('missing log path');
const mode = process.argv[3] ?? 'normal';
let injectionRequests = 0;
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => undefined);

async function respond(message) {
  const encoded = `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;
  const midpoint = Math.floor(encoded.length / 2);
  process.stdout.write(encoded.slice(0, midpoint));
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write(encoded.slice(midpoint));
}

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.length === 0) continue;
  appendFileSync(logPath, `${line}\n`);
  const message = JSON.parse(line);
  if (message.method === 'initialized') {
    if (mode === 'close-stdin') process.stdin.destroy();
    continue;
  }
  if (message.method === undefined && message.error !== undefined) continue;

  if (message.method === 'initialize') {
    await respond({
      id: message.id,
      result: {
        userAgent: 'anima/0.146.0',
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'test',
      },
    });
    if (mode === 'server-request') {
      await respond({
        id: 'server-request-1',
        method: 'item/tool/requestUserInput',
        params: {},
      });
    }
    continue;
  }
  if (message.method === 'thread/start') {
    await respond({
      id: message.id,
      result: {
        thread: {
          id: '22222222-2222-4222-8222-222222222222',
          sessionId: '22222222-2222-4222-8222-222222222222',
          ephemeral: false,
          historyMode: message.params.historyMode,
          path: '/tmp/codex-home/sessions/rollout.jsonl',
          cwd: message.params.cwd,
          cliVersion: '0.146.0',
        },
      },
    });
    continue;
  }
  if (
    message.method === 'thread/inject_items'
  ) {
    injectionRequests += 1;
    if (mode === 'fail-second-injection' && injectionRequests === 2) {
      await respond({
        id: message.id,
        error: { code: -32000, message: 'second batch failed' },
      });
      continue;
    }
    if (mode === 'hang-second-injection' && injectionRequests === 2) {
      continue;
    }
    await respond({ id: message.id, result: {} });
    continue;
  }
  if (message.method === 'thread/name/set') {
    await respond({ id: message.id, result: {} });
    continue;
  }
  if (message.method === 'test/error') {
    await respond({
      id: message.id,
      error: { code: -32601, message: 'expected test error' },
    });
    continue;
  }
  if (message.method === 'test/hang') continue;
  await respond({
    id: message.id,
    error: { code: -32601, message: `unknown method ${message.method}` },
  });
}

if (mode === 'leak-stdout') {
  const grandchild = spawn(
    process.execPath,
    ['--eval', 'setTimeout(() => {}, 2000)'],
    {
      detached: true,
      stdio: ['ignore', process.stdout, process.stderr],
    },
  );
  grandchild.unref();
}

if (mode === 'ignore-sigterm') {
  await new Promise(() => undefined);
}

if (mode === 'close-stdin') {
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
