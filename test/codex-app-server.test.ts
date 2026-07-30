import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import test from 'node:test';

import {
  connectCodexAppServer,
  CodexInjectionError,
  injectCodexItems,
  setCodexThreadName,
  startPersistentCodexThread,
} from '../src/codex-app-server.js';
import {
  CodexAppServerError,
  CodexAppServerRequestTimeoutError,
} from '../src/errors.js';
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
  assert.equal(
    requests.every((request) => request.jsonrpc === '2.0'),
    true,
  );
  const packageMetadata = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(
    (
      (
        requests[0]?.params as {
          clientInfo: { version: string };
        }
      ).clientInfo
    ).version,
    packageMetadata.version,
  );
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

test('rejects pending requests when the client closes', async () => {
  const temporary = await temporaryDirectory();
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [FAKE_APP_SERVER, `${temporary.path}/requests.jsonl`],
    cwd: temporary.path,
  });
  try {
    const rejection = assert.rejects(
      client.request('test/hang'),
      (error: unknown) =>
        error instanceof CodexAppServerError &&
        error.message === 'Codex AppServer connection is closing.',
    );
    await new Promise((resolve) => setImmediate(resolve));
    await client.close();
    await rejection;
  } finally {
    await client.close();
    await temporary.cleanup();
  }
});

test('rejects timeout values that Node would silently clamp', async () => {
  await assert.rejects(
    connectCodexAppServer({ request_timeout_ms: 2 ** 31 }),
    (error: unknown) =>
      error instanceof CodexAppServerError &&
      error.message ===
        'request_timeout_ms must be an integer between 1 and 2147483647.',
  );
});

test('makes the connection unusable after a request timeout', async () => {
  const temporary = await temporaryDirectory();
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [FAKE_APP_SERVER, `${temporary.path}/requests.jsonl`],
    cwd: temporary.path,
    request_timeout_ms: 100,
  });
  try {
    await assert.rejects(
      client.request('test/hang'),
      (error: unknown) =>
        error instanceof CodexAppServerRequestTimeoutError &&
        error.message.includes(
          'timed out after 100ms; the connection is no longer safe to use',
        ),
    );
    await assert.rejects(
      client.request('test/error'),
      CodexAppServerRequestTimeoutError,
    );
  } finally {
    await client.close();
    await temporary.cleanup();
  }
});

test('reports the confirmed prefix when injection partially fails', async () => {
  const temporary = await temporaryDirectory();
  const threadId = '22222222-2222-4222-8222-222222222222';
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [
      FAKE_APP_SERVER,
      `${temporary.path}/requests.jsonl`,
      'fail-second-injection',
    ],
    cwd: temporary.path,
  });
  try {
    const items = Array.from({ length: 5 }, (_, index) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `message ${String(index)}` }],
    }));
    await assert.rejects(
      injectCodexItems(client, threadId, items, 2),
      (error: unknown) => {
        assert(error instanceof CodexInjectionError);
        assert.equal(error.thread_id, threadId);
        assert.equal(error.confirmed_item_count, 2);
        assert.equal(error.attempted_batch_offset, 2);
        assert.equal(error.attempted_batch_count, 2);
        assert.equal(error.total_item_count, 5);
        assert.equal(error.attempted_batch_state, 'indeterminate');
        assert.match(error.message, /abandon thread .* instead of retrying it/);
        return true;
      },
    );
  } finally {
    await client.close();
    await temporary.cleanup();
  }
});

test('rejects server-initiated requests with JSON-RPC method-not-found', async () => {
  const temporary = await temporaryDirectory();
  const logPath = `${temporary.path}/requests.jsonl`;
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [FAKE_APP_SERVER, logPath, 'server-request'],
    cwd: temporary.path,
  });
  try {
    await assert.rejects(client.request('test/error'), CodexAppServerError);
  } finally {
    await client.close();
  }

  const requests = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const response = requests.find(
    (request) => request.id === 'server-request-1',
  );
  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: 'server-request-1',
    error: {
      code: -32601,
      message:
        'Anima does not support server request item/tool/requestUserInput.',
    },
  });
  await temporary.cleanup();
});

test('does not wait for a detached grandchild holding stdout open', async () => {
  const temporary = await temporaryDirectory();
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [
      FAKE_APP_SERVER,
      `${temporary.path}/requests.jsonl`,
      'leak-stdout',
    ],
    cwd: temporary.path,
    close_timeout_ms: 100,
  });
  const startedAt = Date.now();
  try {
    await client.close();
    assert.equal(Date.now() - startedAt < 1_000, true);
  } finally {
    await client.close();
    await temporary.cleanup();
  }
});

test('bounds SIGTERM and SIGKILL shutdown escalation', async () => {
  const temporary = await temporaryDirectory();
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [
      FAKE_APP_SERVER,
      `${temporary.path}/requests.jsonl`,
      'ignore-sigterm',
    ],
    cwd: temporary.path,
    close_timeout_ms: 50,
  });
  const startedAt = Date.now();
  try {
    await assert.rejects(client.close(), CodexAppServerError);
    assert.equal(Date.now() - startedAt < 1_000, true);
  } finally {
    await client.close().catch(() => undefined);
    await temporary.cleanup();
  }
});

test('handles child stdin errors without crashing the process', async () => {
  const temporary = await temporaryDirectory();
  const client = await connectCodexAppServer({
    command: process.execPath,
    arguments: [
      FAKE_APP_SERVER,
      `${temporary.path}/requests.jsonl`,
      'close-stdin',
    ],
    cwd: temporary.path,
    close_timeout_ms: 50,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      client.request('test/error'),
      (error: unknown) => error instanceof CodexAppServerError,
    );
    await assert.rejects(client.request('test/error'), CodexAppServerError);
  } finally {
    await client.close().catch(() => undefined);
    await temporary.cleanup();
  }
});
