import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import test from 'node:test';

import {
  connectCodexAppServer,
  injectCodexItems,
  setCodexThreadName,
  startPersistentCodexThread,
} from '../src/codex-app-server.js';
import { CodexAppServerError } from '../src/errors.js';
import { temporaryDirectory } from './helpers.js';

const FAKE_APP_SERVER = fileURLToPath(
  new URL('../../test/fixtures/codex/fake-app-server.mjs', import.meta.url),
);

test('creates and injects a persistent Codex thread over JSON-RPC', async () => {
  const temporary = await temporaryDirectory();
  const logPath = `${temporary.path}/requests.jsonl`;
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [FAKE_APP_SERVER, logPath],
    cwd: temporary.path,
  });
  try {
    assert.deepEqual(client.server_info, {
      user_agent: 'anima/0.146.0',
      codex_home: '/tmp/codex-home',
      platform_family: 'unix',
      platform_os: 'test',
    });

    const thread = await startPersistentCodexThread(client, {
      cwd: '/work/anima',
      history_mode: 'legacy',
    });
    assert.deepEqual(thread, {
      thread_id: '22222222-2222-4222-8222-222222222222',
      session_id: '22222222-2222-4222-8222-222222222222',
      native_path: '/tmp/codex-home/sessions/rollout.jsonl',
      cwd: '/work/anima',
      cli_version: '0.146.0',
      history_mode: 'legacy',
    });

    const items = Array.from({ length: 5 }, (_, index) => ({
      type: 'message',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'input_text', text: `message ${String(index)}` }],
    }));
    await injectCodexItems(client, thread.thread_id, items, 2);
    await setCodexThreadName(client, thread.thread_id, 'Anima import');
  } finally {
    await client.close();
  }

  const requests = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      'initialize',
      'initialized',
      'thread/start',
      'thread/inject_items',
      'thread/inject_items',
      'thread/inject_items',
      'thread/name/set',
    ],
  );
  const injections = requests.filter(
    (request) => request.method === 'thread/inject_items',
  );
  assert.deepEqual(
    injections.map(
      (request) =>
        (
          request.params as {
            items: unknown[];
          }
        ).items.length,
    ),
    [2, 2, 1],
  );
  await temporary.cleanup();
});

test('surfaces Codex AppServer protocol errors with method context', async () => {
  const temporary = await temporaryDirectory();
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [FAKE_APP_SERVER, `${temporary.path}/requests.jsonl`],
    cwd: temporary.path,
  });
  try {
    await assert.rejects(
      client.request('test/error'),
      (error: unknown) =>
        error instanceof CodexAppServerError &&
        error.message ===
          'Codex AppServer request test/error failed (-32601): expected test error',
    );
  } finally {
    await client.close();
    await temporary.cleanup();
  }
});

test('fails promptly when the Codex executable is unavailable', async () => {
  const temporary = await temporaryDirectory();
  try {
    await assert.rejects(
      connectCodexAppServer({
        command: `${temporary.path}/missing-codex`,
        request_timeout_ms: 1_000,
        close_timeout_ms: 100,
      }),
      (error: unknown) =>
        error instanceof CodexAppServerError &&
        error.message.includes('Failed to start Codex AppServer:'),
    );
  } finally {
    await temporary.cleanup();
  }
});
