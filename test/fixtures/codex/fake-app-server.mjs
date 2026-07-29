import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.argv[2];
if (logPath === undefined) throw new Error('missing log path');

async function respond(message) {
  const encoded = `${JSON.stringify(message)}\n`;
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
  if (message.method === 'initialized') continue;

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
    message.method === 'thread/inject_items' ||
    message.method === 'thread/name/set'
  ) {
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
