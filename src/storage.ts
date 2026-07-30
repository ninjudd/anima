import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { stableStringify } from './canonical.js';
import { StorageError } from './errors.js';
import type {
  CanonicalEvent,
  CanonicalSession,
  Provider,
  SessionWarning,
} from './types.js';

const STORE_SCHEMA_VERSION = '1\n';
const LINEAGE_LOCK_RETRY_MS = 25;
const LINEAGE_LOCK_TIMEOUT_MS = 10_000;

export type TransferState =
  | 'reading'
  | 'normalized'
  | 'target_created'
  | 'projected'
  | 'launching'
  | 'complete'
  | 'launch_failed';

export interface TransferRecord {
  schema_version: 1;
  transfer_id: string;
  source: {
    provider: Provider;
    session_id: string;
  };
  target_provider: Provider;
  state: TransferState;
  created_at: string;
  updated_at: string;
  lineage_id?: string;
  canonical_event_count?: number;
  canonical_head_event_id?: string | null;
  target?: {
    session_id: string;
    native_log_path: string;
    cwd: string;
    cli_version: string;
    manual_resume_command: string;
  };
  projection_id?: string;
  error?: {
    message: string;
    recorded_at: string;
  };
}

export interface ProjectionRecord {
  schema_version: 1;
  projection_id: string;
  lineage_id: string;
  provider: Provider;
  native_session_id: string;
  native_log_path: string;
  cwd: string;
  cli_version: string;
  canonical_head_event_id: string | null;
  canonical_event_count: number;
  native_cursor: {
    byte_offset: number;
    record_count: number;
    leaf_uuid: string;
    nearby_event_fingerprints: string[];
  };
  source: {
    provider: Provider;
    native_session_id: string;
  };
  status: 'projected';
  created_at: string;
}

interface LineageManifest {
  schema_version: 1;
  lineage_id: string;
  source: {
    provider: Provider;
    native_session_id: string;
    native_log_path: string;
    cwd: string;
    cli_version?: string;
  };
  title?: string;
  warnings: SessionWarning[];
  canonical_event_count: number;
  canonical_head_event_id: string | null;
  updated_at: string;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function readIfExists(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function acquireLineageLock(
  directory: string,
): Promise<() => Promise<void>> {
  const filename = path.join(directory, '.archive.lock');
  const deadline = Date.now() + LINEAGE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            acquired_at: new Date().toISOString(),
          })}\n`,
          'utf8',
        );
        await handle.sync();
      } catch (error) {
        await handle.close();
        await unlink(filename).catch(() => undefined);
        throw error;
      }

      return async () => {
        await handle.close();
        await unlink(filename).catch((error: unknown) => {
          if (!isErrno(error, 'ENOENT')) throw error;
        });
        await fsyncDirectory(directory);
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      if (Date.now() >= deadline) {
        throw new StorageError(
          `Timed out waiting for canonical archive lock ${filename}; if no Anima transfer is running, inspect and remove that lock file before retrying.`,
        );
      }
      await wait(LINEAGE_LOCK_RETRY_MS);
    }
  }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writeTemporaryFile(
  filename: string,
  content: string,
): Promise<string> {
  const directory = path.dirname(filename);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
}

export async function writeFileAtomic(
  filename: string,
  content: string,
): Promise<void> {
  const temporary = await writeTemporaryFile(filename, content);
  try {
    await rename(temporary, filename);
    await chmod(filename, 0o600);
    await fsyncDirectory(path.dirname(filename));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function publishFileExclusive(
  filename: string,
  content: string,
): Promise<void> {
  const temporary = await writeTemporaryFile(filename, content);
  const directory = path.dirname(filename);
  try {
    // A same-filesystem hard link publishes the fully fsynced file atomically
    // and, unlike rename(2), fails instead of replacing an existing transcript.
    await link(temporary, filename);
    await fsyncDirectory(directory);
    await unlink(temporary);
    await fsyncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (isErrno(error, 'EEXIST')) {
      throw new StorageError(
        `Refusing to overwrite existing file ${filename}.`,
      );
    }
    throw error;
  }
}

export function defaultAnimaDataRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const xdgDataHome = environment.XDG_DATA_HOME;
  return xdgDataHome !== undefined && xdgDataHome !== ''
    ? path.join(xdgDataHome, 'anima')
    : path.join(homedir(), '.local', 'share', 'anima');
}

export async function initializeStore(dataRoot: string): Promise<void> {
  await ensurePrivateDirectory(dataRoot);
  const schemaPath = path.join(dataRoot, 'schema-version');
  const observed = await readIfExists(schemaPath);
  if (observed === undefined) {
    try {
      await publishFileExclusive(schemaPath, STORE_SCHEMA_VERSION);
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
    }
  }
  const schema = await readFile(schemaPath, 'utf8');
  if (schema !== STORE_SCHEMA_VERSION) {
    throw new StorageError(
      `Anima data store ${dataRoot} uses unsupported schema ${JSON.stringify(schema.trim())}; expected 1.`,
    );
  }
}

function parseEventStream(filename: string, value: string): CanonicalEvent[] {
  const lines = value.split('\n').filter((line) => line !== '');
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as CanonicalEvent;
    } catch {
      throw new StorageError(
        `Canonical archive ${filename} has invalid JSON at record ${String(index + 1)}.`,
      );
    }
  });
}

function assertExistingPrefix(
  filename: string,
  existing: readonly CanonicalEvent[],
  current: readonly CanonicalEvent[],
): void {
  if (existing.length > current.length) {
    throw new StorageError(
      `Canonical archive ${filename} is ahead of the source session; refusing to discard events.`,
    );
  }
  for (const [index, event] of existing.entries()) {
    if (stableStringify(event) !== stableStringify(current[index])) {
      throw new StorageError(
        `Canonical archive ${filename} diverges from the source at event ${String(index + 1)}.`,
      );
    }
  }
}

export async function commitCanonicalSession(
  dataRoot: string,
  session: CanonicalSession,
  updatedAt: string,
): Promise<{ manifest_path: string; events_path: string }> {
  await initializeStore(dataRoot);
  const directory = path.join(dataRoot, 'lineages', session.lineage_id);
  await ensurePrivateDirectory(directory);
  const eventsPath = path.join(directory, 'events.jsonl');
  const manifestPath = path.join(directory, 'manifest.json');
  const release = await acquireLineageLock(directory);
  try {
    const eventsJsonl = `${session.events
      .map((event) => JSON.stringify(event))
      .join('\n')}${session.events.length === 0 ? '' : '\n'}`;
    const existingText = await readIfExists(eventsPath);
    if (existingText !== undefined) {
      assertExistingPrefix(
        eventsPath,
        parseEventStream(eventsPath, existingText),
        session.events,
      );
    }
    if (existingText !== eventsJsonl) {
      await writeFileAtomic(eventsPath, eventsJsonl);
    }

    const manifest: LineageManifest = {
      schema_version: 1,
      lineage_id: session.lineage_id,
      source: {
        provider: session.provider,
        native_session_id: session.session_id,
        native_log_path: session.native_path,
        cwd: session.cwd,
        ...(session.cli_version !== undefined
          ? { cli_version: session.cli_version }
          : {}),
      },
      ...(session.title !== undefined ? { title: session.title } : {}),
      warnings: session.warnings,
      canonical_event_count: session.events.length,
      canonical_head_event_id: session.events.at(-1)?.event_id ?? null,
      updated_at: updatedAt,
    };
    await writeFileAtomic(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } finally {
    await release();
  }
  return { manifest_path: manifestPath, events_path: eventsPath };
}

export async function createTransferRecord(
  dataRoot: string,
  record: TransferRecord,
): Promise<string> {
  await initializeStore(dataRoot);
  const filename = path.join(
    dataRoot,
    'transfers',
    `${record.transfer_id}.json`,
  );
  await publishFileExclusive(filename, `${JSON.stringify(record, null, 2)}\n`);
  return filename;
}

export async function updateTransferRecord(
  dataRoot: string,
  record: TransferRecord,
): Promise<void> {
  const filename = path.join(
    dataRoot,
    'transfers',
    `${record.transfer_id}.json`,
  );
  if ((await readIfExists(filename)) === undefined) {
    throw new StorageError(
      `Cannot update missing transfer record ${record.transfer_id}.`,
    );
  }
  await writeFileAtomic(filename, `${JSON.stringify(record, null, 2)}\n`);
}

export async function writeProjectionRecord(
  dataRoot: string,
  record: ProjectionRecord,
): Promise<string> {
  await initializeStore(dataRoot);
  const filename = path.join(
    dataRoot,
    'projections',
    record.provider,
    `${record.native_session_id}.json`,
  );
  await publishFileExclusive(filename, `${JSON.stringify(record, null, 2)}\n`);
  return filename;
}
