import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { CodexAppServerError } from './errors.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const MAX_STDERR_CHARACTERS = 65_536;
const MAX_RESPONSE_BUFFER_CHARACTERS = 4 * 1024 * 1024;
const DEFAULT_INJECTION_BATCH_SIZE = 128;

type JsonObject = Record<string, unknown>;
export type CodexRawItem = Record<string, unknown>;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CodexAppServerOptions {
  command?: string;
  arguments?: string[];
  cwd?: string;
  request_timeout_ms?: number;
  close_timeout_ms?: number;
}

export interface CodexAppServerInfo {
  user_agent: string;
  codex_home: string;
  platform_family: string;
  platform_os: string;
}

export interface StartCodexThreadOptions {
  cwd: string;
  history_mode?: 'legacy' | 'paginated';
}

export interface CodexThreadReference {
  thread_id: string;
  session_id: string;
  native_path: string;
  cwd: string;
  cli_version: string;
  history_mode: 'legacy' | 'paginated';
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function requiredString(
  object: JsonObject,
  key: string,
  context: string,
): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexAppServerError(
      `${context} did not include a non-empty ${key}.`,
    );
  }
  return value;
}

function positiveTimeout(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) {
    throw new CodexAppServerError(`${label} must be a positive number.`);
  }
  return selected;
}

function exitDescription(result: ExitResult, stderr: string): string {
  const status =
    result.signal !== null
      ? `signal ${result.signal}`
      : `status ${String(result.code)}`;
  const detail = stderr.trim();
  return detail.length > 0 ? `${status}: ${detail}` : status;
}

export class CodexAppServerClient {
  readonly server_info: CodexAppServerInfo;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private exitPromise: Promise<ExitResult>;
  private nextRequestId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private fatalError: CodexAppServerError | undefined;
  private closing = false;
  private closed = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
    closeTimeoutMs: number,
    serverInfo: CodexAppServerInfo,
  ) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.server_info = serverInfo;
    this.exitPromise = Promise.resolve({ code: null, signal: null });
  }

  static async connect(
    options: CodexAppServerOptions = {},
  ): Promise<CodexAppServerClient> {
    const requestTimeoutMs = positiveTimeout(
      options.request_timeout_ms,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'request_timeout_ms',
    );
    const closeTimeoutMs = positiveTimeout(
      options.close_timeout_ms,
      DEFAULT_CLOSE_TIMEOUT_MS,
      'close_timeout_ms',
    );
    const command = options.command ?? 'codex';
    const args = options.arguments ?? ['app-server', '--stdio'];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: 'pipe',
    });

    const client = CodexAppServerClient.attach(
      child,
      requestTimeoutMs,
      closeTimeoutMs,
    );
    try {
      const result = objectValue(
        await client.request('initialize', {
          clientInfo: {
            name: 'anima',
            title: 'Anima',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        }),
      );
      if (result === undefined) {
        throw new CodexAppServerError(
          'Codex AppServer initialize returned an invalid result.',
        );
      }
      client.setServerInfo({
        user_agent: requiredString(
          result,
          'userAgent',
          'Codex AppServer initialize',
        ),
        codex_home: requiredString(
          result,
          'codexHome',
          'Codex AppServer initialize',
        ),
        platform_family: requiredString(
          result,
          'platformFamily',
          'Codex AppServer initialize',
        ),
        platform_os: requiredString(
          result,
          'platformOs',
          'Codex AppServer initialize',
        ),
      });
      await client.notify('initialized');
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private static attach(
    child: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
    closeTimeoutMs: number,
  ): CodexAppServerClient {
    const placeholder: CodexAppServerInfo = {
      user_agent: '',
      codex_home: '',
      platform_family: '',
      platform_os: '',
    };
    const client = new CodexAppServerClient(
      child,
      requestTimeoutMs,
      closeTimeoutMs,
      placeholder,
    );
    const exitPromise = new Promise<ExitResult>((resolve) => {
      child.once('close', (code, signal) => {
        const result = { code, signal };
        client.closed = true;
        if (!client.closing || code !== 0) {
          client.fail(
            new CodexAppServerError(
              `Codex AppServer exited with ${exitDescription(
                result,
                client.stderrBuffer,
              )}.`,
            ),
          );
        }
        resolve(result);
      });
    });
    client.exitPromise = exitPromise;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => client.consumeStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      client.stderrBuffer = `${client.stderrBuffer}${chunk}`.slice(
        -MAX_STDERR_CHARACTERS,
      );
    });
    child.once('error', (error) => {
      client.fail(
        new CodexAppServerError(
          `Failed to start Codex AppServer: ${error.message}`,
        ),
      );
    });
    return client;
  }

  private setServerInfo(info: CodexAppServerInfo): void {
    Object.assign(this.server_info, info);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.assertAvailable();
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexAppServerError(
            `Codex AppServer request ${method} timed out after ${String(
              this.requestTimeoutMs,
            )}ms.`,
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.assertAvailable();
    await this.write({
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = true;
      this.child.stdin.end();
    }

    const timedOut = Symbol('timed-out');
    let result = await Promise.race([
      this.exitPromise,
      delay(this.closeTimeoutMs, timedOut, { ref: false }),
    ]);
    if (result === timedOut) {
      this.child.kill('SIGTERM');
      result = await Promise.race([
        this.exitPromise,
        delay(this.closeTimeoutMs, timedOut, { ref: false }),
      ]);
    }
    if (result === timedOut) {
      this.child.kill('SIGKILL');
      result = await this.exitPromise;
    }
    if (result.code !== 0) {
      throw new CodexAppServerError(
        `Codex AppServer exited with ${exitDescription(
          result,
          this.stderrBuffer,
        )}.`,
      );
    }
  }

  private assertAvailable(): void {
    if (this.fatalError !== undefined) throw this.fatalError;
    if (this.closing || this.closed) {
      throw new CodexAppServerError('Codex AppServer connection is closed.');
    }
  }

  private async write(message: JsonObject): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, (error) => {
        if (error !== null && error !== undefined) {
          reject(
            new CodexAppServerError(
              `Could not write to Codex AppServer: ${error.message}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline === -1) break;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.fail(
          error instanceof CodexAppServerError
            ? error
            : new CodexAppServerError(
                `Codex AppServer returned invalid JSON: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
        );
        this.child.kill('SIGTERM');
        return;
      }
    }
    if (this.stdoutBuffer.length > MAX_RESPONSE_BUFFER_CHARACTERS) {
      this.fail(
        new CodexAppServerError(
          'Codex AppServer produced an oversized unterminated response.',
        ),
      );
      this.child.kill('SIGTERM');
    }
  }

  private handleMessage(value: unknown): void {
    const message = objectValue(value);
    if (message === undefined) {
      throw new CodexAppServerError(
        'Codex AppServer returned a non-object message.',
      );
    }

    if (typeof message.method === 'string') {
      if (
        typeof message.id === 'number' ||
        typeof message.id === 'string'
      ) {
        void this.write({
          id: message.id,
          error: {
            code: -32601,
            message: `Anima does not support server request ${message.method}.`,
          },
        }).catch((error: unknown) => {
          this.fail(
            error instanceof CodexAppServerError
              ? error
              : new CodexAppServerError(String(error)),
          );
        });
      }
      return;
    }

    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    const protocolError = objectValue(message.error);
    if (protocolError !== undefined) {
      const code =
        typeof protocolError.code === 'number'
          ? ` (${String(protocolError.code)})`
          : '';
      const detail =
        typeof protocolError.message === 'string'
          ? protocolError.message
          : 'unknown protocol error';
      pending.reject(
        new CodexAppServerError(
          `Codex AppServer request ${pending.method} failed${code}: ${detail}`,
        ),
      );
      return;
    }
    if (!Object.hasOwn(message, 'result')) {
      pending.reject(
        new CodexAppServerError(
          `Codex AppServer response to ${pending.method} had no result.`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private fail(error: CodexAppServerError): void {
    if (this.fatalError === undefined) this.fatalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.fatalError);
    }
    this.pending.clear();
  }
}

export async function connectCodexAppServer(
  options: CodexAppServerOptions = {},
): Promise<CodexAppServerClient> {
  return CodexAppServerClient.connect(options);
}

export async function startPersistentCodexThread(
  client: CodexAppServerClient,
  options: StartCodexThreadOptions,
): Promise<CodexThreadReference> {
  const historyMode = options.history_mode ?? 'legacy';
  const response = objectValue(
    await client.request('thread/start', {
      cwd: options.cwd,
      ephemeral: false,
      historyMode,
      threadSource: 'anima',
    }),
  );
  const thread = objectValue(response?.thread);
  if (thread === undefined) {
    throw new CodexAppServerError(
      'Codex AppServer thread/start returned an invalid thread.',
    );
  }
  if (thread.ephemeral !== false) {
    throw new CodexAppServerError(
      'Codex AppServer created an ephemeral thread instead of a persistent one.',
    );
  }
  const returnedHistoryMode = requiredString(
    thread,
    'historyMode',
    'Codex AppServer thread/start',
  );
  if (
    returnedHistoryMode !== 'legacy' &&
    returnedHistoryMode !== 'paginated'
  ) {
    throw new CodexAppServerError(
      `Codex AppServer returned unsupported history mode ${returnedHistoryMode}.`,
    );
  }
  if (returnedHistoryMode !== historyMode) {
    throw new CodexAppServerError(
      `Codex AppServer created history mode ${returnedHistoryMode}; expected ${historyMode}.`,
    );
  }
  return {
    thread_id: requiredString(
      thread,
      'id',
      'Codex AppServer thread/start',
    ),
    session_id: requiredString(
      thread,
      'sessionId',
      'Codex AppServer thread/start',
    ),
    native_path: requiredString(
      thread,
      'path',
      'Codex AppServer thread/start',
    ),
    cwd: requiredString(thread, 'cwd', 'Codex AppServer thread/start'),
    cli_version: requiredString(
      thread,
      'cliVersion',
      'Codex AppServer thread/start',
    ),
    history_mode: returnedHistoryMode,
  };
}

export async function injectCodexItems(
  client: CodexAppServerClient,
  threadId: string,
  items: CodexRawItem[],
  batchSize = DEFAULT_INJECTION_BATCH_SIZE,
): Promise<void> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new CodexAppServerError(
      'Codex injection batch size must be a positive integer.',
    );
  }
  for (let offset = 0; offset < items.length; offset += batchSize) {
    await client.request('thread/inject_items', {
      threadId,
      items: items.slice(offset, offset + batchSize),
    });
  }
}

export async function setCodexThreadName(
  client: CodexAppServerClient,
  threadId: string,
  name: string,
): Promise<void> {
  if (name.length === 0) {
    throw new CodexAppServerError('Codex thread name must not be empty.');
  }
  await client.request('thread/name/set', { threadId, name });
}
