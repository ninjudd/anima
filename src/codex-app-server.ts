import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CodexAppServerError,
  CodexAppServerRequestTimeoutError,
} from './errors.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const MAX_STDERR_CHARACTERS = 65_536;
const MAX_RESPONSE_BUFFER_CHARACTERS = 4 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const DEFAULT_INJECTION_BATCH_SIZE = 128;
const STDERR_TRUNCATION_MARKER = '\n...[stderr truncated]...\n';

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

export class CodexInjectionError extends CodexAppServerError {
  readonly thread_id: string;
  readonly confirmed_item_count: number;
  readonly attempted_batch_offset: number;
  readonly attempted_batch_count: number;
  readonly total_item_count: number;
  readonly attempted_batch_state = 'indeterminate' as const;
  readonly original_error: unknown;

  constructor(
    threadId: string,
    confirmedItemCount: number,
    attemptedBatchCount: number,
    totalItemCount: number,
    originalError: unknown,
  ) {
    const finalItem = confirmedItemCount + attemptedBatchCount;
    const detail =
      originalError instanceof Error
        ? ` ${originalError.message}`
        : ` ${String(originalError)}`;
    super(
      `Codex history injection failed for items ${String(
        confirmedItemCount + 1,
      )}-${String(finalItem)} of ${String(
        totalItemCount,
      )}; ${String(
        confirmedItemCount,
      )} earlier items were confirmed.${detail} The attempted batch may have been applied; abandon thread ${threadId} instead of retrying it.`,
    );
    this.thread_id = threadId;
    this.confirmed_item_count = confirmedItemCount;
    this.attempted_batch_offset = confirmedItemCount;
    this.attempted_batch_count = attemptedBatchCount;
    this.total_item_count = totalItemCount;
    this.original_error = originalError;
  }
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
  if (
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > MAX_TIMER_DELAY_MS
  ) {
    throw new CodexAppServerError(
      `${label} must be an integer between 1 and ${String(
        MAX_TIMER_DELAY_MS,
      )}.`,
    );
  }
  return selected;
}

function packageVersion(): string {
  try {
    const metadata = objectValue(
      JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ),
    );
    if (metadata !== undefined && typeof metadata.version === 'string') {
      return metadata.version;
    }
  } catch (error) {
    throw new CodexAppServerError(
      `Could not read Anima package version: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  throw new CodexAppServerError(
    'Could not read Anima package version: package.json has no version.',
  );
}

function appendBoundedStderr(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  if (combined.length <= MAX_STDERR_CHARACTERS) return combined;
  const remaining =
    MAX_STDERR_CHARACTERS - STDERR_TRUNCATION_MARKER.length;
  const headLength = Math.floor(remaining / 2);
  const tailLength = remaining - headLength;
  return `${combined.slice(0, headLength)}${STDERR_TRUNCATION_MARKER}${combined.slice(
    -tailLength,
  )}`;
}

function exitDescription(result: ExitResult, stderr: string): string {
  const status =
    result.signal !== null
      ? `signal ${result.signal}`
      : `status ${String(result.code)}`;
  const detail = stderr.trim();
  return detail.length > 0 ? `${status}: ${detail}` : status;
}

/**
 * Bootstrap-only AppServer transport.
 *
 * Anima does not run model turns through this connection. Server-initiated
 * requests are rejected fail-closed because approvals and tools require a
 * full interactive client implementation.
 */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly terminationPromise: Promise<ExitResult>;
  private serverInfo: Readonly<CodexAppServerInfo> | undefined;
  private shutdownError: CodexAppServerError | undefined;
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
  ) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.terminationPromise = new Promise<ExitResult>((resolve) => {
      let settled = false;
      const recordTermination = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
        const result = { code, signal };
        this.closed = true;
        this.disposeStreams();
        if (!this.closing || code !== 0) {
          const error = new CodexAppServerError(
            `Codex AppServer exited with ${exitDescription(
              result,
              this.stderrBuffer,
            )}.`,
          );
          this.shutdownError = error;
          this.fail(error);
        }
        resolve(result);
      };
      child.once('exit', recordTermination);
      child.once('close', recordTermination);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = appendBoundedStderr(this.stderrBuffer, chunk);
    });
    child.once('error', (error) => {
      this.fail(
        new CodexAppServerError(
          `Failed to start Codex AppServer: ${error.message}`,
        ),
      );
    });
  }

  get server_info(): Readonly<CodexAppServerInfo> {
    if (this.serverInfo === undefined) {
      throw new CodexAppServerError(
        'Codex AppServer connection is not initialized.',
      );
    }
    return this.serverInfo;
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

    const client = new CodexAppServerClient(
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
            version: packageVersion(),
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

  private setServerInfo(info: CodexAppServerInfo): void {
    this.serverInfo = Object.freeze({ ...info });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.assertAvailable();
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new CodexAppServerRequestTimeoutError(
            `Codex AppServer request ${method} timed out after ${String(
              this.requestTimeoutMs,
            )}ms; the connection is no longer safe to use.`,
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
    if (this.closed) {
      if (this.shutdownError !== undefined) throw this.shutdownError;
      return;
    }
    if (!this.closing) {
      this.closing = true;
      this.fail(
        new CodexAppServerError('Codex AppServer connection is closing.'),
      );
      this.child.stdin.end();
    }

    let result = await this.waitForTermination();
    if (result === undefined) {
      this.child.kill('SIGTERM');
      result = await this.waitForTermination();
    }
    if (result === undefined) {
      this.child.kill('SIGKILL');
      result = await this.waitForTermination();
    }
    if (result === undefined) {
      const error = new CodexAppServerError(
        `Codex AppServer did not exit within ${String(
          this.closeTimeoutMs,
        )}ms after SIGKILL.`,
      );
      this.shutdownError = error;
      this.fail(error);
      this.disposeStreams();
      this.child.unref();
      this.closed = true;
      throw error;
    }
    if (result.code !== 0) {
      throw (
        this.shutdownError ??
        new CodexAppServerError(
          `Codex AppServer exited with ${exitDescription(
            result,
            this.stderrBuffer,
          )}.`,
        )
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
    const line = `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;
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

  private async waitForTermination(): Promise<ExitResult | undefined> {
    const timedOut = Symbol('timed-out');
    const result = await Promise.race([
      this.terminationPromise,
      delay(this.closeTimeoutMs, timedOut, { ref: false }),
    ]);
    return result === timedOut ? undefined : result;
  }

  private disposeStreams(): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
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
    const batch = items.slice(offset, offset + batchSize);
    try {
      await client.request('thread/inject_items', {
        threadId,
        items: batch,
      });
    } catch (error) {
      // AppServer offers neither an idempotency key nor an atomic multi-batch
      // transaction. A timed-out batch may already be durable. The caller must
      // mark this target incomplete and start a fresh thread on retry.
      throw new CodexInjectionError(
        threadId,
        offset,
        batch.length,
        items.length,
        error,
      );
    }
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
