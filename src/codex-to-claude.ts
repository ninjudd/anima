import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { readClaudeSession } from './claude.js';
import {
  encodeClaudeTranscript,
  SUPPORTED_CLAUDE_TRANSCRIPT_VERSION,
  type ClaudeTranscriptMessage,
  type EncodedClaudeTranscript,
} from './claude-transcript.js';
import { projectClaudeMessages } from './claude-projection.js';
import { readCodexSession } from './codex.js';
import {
  ClaudeLaunchError,
  ClaudeTranscriptError,
  TransferError,
} from './errors.js';
import {
  commitCanonicalSession,
  createTransferRecord,
  defaultAnimaDataRoot,
  ensurePrivateDirectory,
  publishFileExclusive,
  updateTransferRecord,
  writeProjectionRecord,
  type ProjectionRecord,
  type TransferRecord,
  type TransferState,
} from './storage.js';

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

export interface CodexToClaudeTransferOptions {
  codex_sessions_root?: string;
  claude_projects_root?: string;
  data_root?: string;
  cwd?: string;
  include_tool_output?: boolean;
  claude_command?: string;
  session_id_factory?: () => string;
  now?: () => Date;
  status_writer?: (text: string) => void;
}

export interface CodexToClaudeTransferResult {
  transfer_id: string;
  projection_id: string;
  lineage_id: string;
  source_session_id: string;
  target_session_id: string;
  target_path: string;
  cwd: string;
  manual_resume_command: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function manualResumeCommand(
  command: string,
  sessionId: string,
  cwd: string,
): string {
  return `cd ${shellQuote(cwd)} && ${shellQuote(command)} --resume ${shellQuote(sessionId)}`;
}

function defaultClaudeProjectsRoot(): string {
  const config = process.env.CLAUDE_CONFIG_DIR;
  return path.join(
    config !== undefined && config !== ''
      ? config
      : path.join(homedir(), '.claude'),
    'projects',
  );
}

async function resolveTargetCwd(value: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TransferError(
        `Source working directory ${value} does not exist; pass --cwd <path>.`,
      );
    }
    throw error;
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new TransferError(
      `Target working directory ${resolved} is not a directory; pass --cwd <path>.`,
    );
  }
  return resolved;
}

export async function detectClaudeVersion(
  command = 'claude',
): Promise<string> {
  let output: string;
  try {
    const result = await execFileAsync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    output = result.stdout;
  } catch (error) {
    const detail = errorMessage(error);
    throw new ClaudeTranscriptError(
      `Could not detect Claude Code version with ${command} --version: ${detail}`,
    );
  }
  const version = output.match(VERSION_PATTERN)?.[1];
  if (version === undefined) {
    throw new ClaudeTranscriptError(
      `Could not parse Claude Code version from ${JSON.stringify(output.trim())}.`,
    );
  }
  return version;
}

function verifyClaudeVersion(version: string): void {
  if (version !== SUPPORTED_CLAUDE_TRANSCRIPT_VERSION) {
    throw new ClaudeTranscriptError(
      `Claude Code ${version} is not writable by this Anima build; supported version: ${SUPPORTED_CLAUDE_TRANSCRIPT_VERSION}. No Claude transcript was created.`,
    );
  }
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function claudeSessionIdExists(
  projectsRoot: string,
  sessionId: string,
): Promise<boolean> {
  let projects;
  try {
    projects = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    if (
      await pathExists(
        path.join(projectsRoot, project.name, `${sessionId}.jsonl`),
      )
    ) {
      return true;
    }
  }
  return false;
}

async function chooseTranscript(
  projectsRoot: string,
  cwd: string,
  version: string,
  messages: readonly ClaudeTranscriptMessage[],
  factory: () => string,
  startedAt: string,
): Promise<{ encoded: EncodedClaudeTranscript; target_path: string }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const encoded = encodeClaudeTranscript({
      session_id: factory(),
      cwd,
      cli_version: version,
      messages,
      started_at: startedAt,
    });
    const targetPath = path.join(
      projectsRoot,
      encoded.project_directory,
      `${encoded.session_id}.jsonl`,
    );
    if (!(await claudeSessionIdExists(projectsRoot, encoded.session_id))) {
      return { encoded, target_path: targetPath };
    }
  }
  throw new ClaudeTranscriptError(
    'Could not allocate a unique Claude session ID after 10 attempts.',
  );
}

async function validateInstalledTranscript(
  encoded: EncodedClaudeTranscript,
  projectsRoot: string,
  messages: readonly ClaudeTranscriptMessage[],
  cwd: string,
  version: string,
): Promise<void> {
  const observed = await readClaudeSession(encoded.session_id, {
    projects_root: projectsRoot,
  });
  const observedMessages = observed.events.map((event) => {
    if (event.kind !== 'message') {
      throw new ClaudeTranscriptError(
        `Generated Claude transcript ${encoded.session_id} read back with unexpected ${event.kind} event.`,
      );
    }
    return {
      role: event.role,
      text: event.content.map((block) => block.text).join('\n'),
    };
  });
  if (
    JSON.stringify(observedMessages) !== JSON.stringify(messages) ||
    observed.cwd !== cwd ||
    observed.cli_version !== version
  ) {
    throw new ClaudeTranscriptError(
      `Generated Claude transcript ${encoded.session_id} failed read-back validation.`,
    );
  }
}

function messageFingerprint(message: ClaudeTranscriptMessage): string {
  return createHash('sha256')
    .update(`${message.role}\0${message.text}`)
    .digest('hex');
}

function nearbyFingerprints(
  messages: readonly ClaudeTranscriptMessage[],
): string[] {
  const nearby =
    messages.length <= 4
      ? messages
      : [...messages.slice(0, 2), ...messages.slice(-2)];
  return nearby.map(messageFingerprint);
}

async function launchClaude(
  command: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ['--resume', sessionId], {
      cwd,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      reject(
        new ClaudeLaunchError(
          `Could not launch Claude Code with ${command}: ${error.message}`,
        ),
      );
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new ClaudeLaunchError(
          signal === null
            ? `Claude Code exited with status ${String(code)}.`
            : `Claude Code exited after signal ${signal}.`,
        ),
      );
    });
  });
}

function withState(
  record: TransferRecord,
  state: TransferState,
  now: () => Date,
  fields: Partial<TransferRecord> = {},
): TransferRecord {
  return {
    ...record,
    ...fields,
    state,
    updated_at: timestamp(now),
  };
}

export async function transferCodexToClaude(
  sourceSessionId: string,
  options: CodexToClaudeTransferOptions = {},
): Promise<CodexToClaudeTransferResult> {
  const now = options.now ?? (() => new Date());
  const dataRoot = options.data_root ?? defaultAnimaDataRoot();
  const projectsRoot =
    options.claude_projects_root ?? defaultClaudeProjectsRoot();
  const claudeCommand = options.claude_command ?? 'claude';
  const sessionIdFactory = options.session_id_factory ?? randomUUID;
  const writeStatus =
    options.status_writer ?? ((value: string) => process.stdout.write(value));
  const transferId = `xfr_${randomUUID()}`;
  const createdAt = timestamp(now);
  let transfer: TransferRecord = {
    schema_version: 1,
    transfer_id: transferId,
    source: { provider: 'codex', session_id: sourceSessionId },
    target_provider: 'claude',
    state: 'reading',
    created_at: createdAt,
    updated_at: createdAt,
  };
  await createTransferRecord(dataRoot, transfer);

  try {
    const source = await readCodexSession(sourceSessionId, {
      ...(options.codex_sessions_root !== undefined
        ? { sessions_root: options.codex_sessions_root }
        : {}),
    });
    await commitCanonicalSession(dataRoot, source, timestamp(now));
    transfer = withState(transfer, 'normalized', now, {
      lineage_id: source.lineage_id,
      canonical_event_count: source.events.length,
      canonical_head_event_id: source.events.at(-1)?.event_id ?? null,
    });
    await updateTransferRecord(dataRoot, transfer);

    const cwd = await resolveTargetCwd(options.cwd ?? source.cwd);
    const version = await detectClaudeVersion(claudeCommand);
    verifyClaudeVersion(version);
    const messages = projectClaudeMessages(source, {
      ...(options.include_tool_output === true
        ? { include_tool_output: true }
        : {}),
    });
    if (messages.length === 0) {
      throw new TransferError(
        `Codex session ${sourceSessionId} contains no projectable history.`,
      );
    }

    const selected = await chooseTranscript(
      projectsRoot,
      cwd,
      version,
      messages,
      sessionIdFactory,
      timestamp(now),
    );
    const manualCommand = manualResumeCommand(
      claudeCommand,
      selected.encoded.session_id,
      cwd,
    );
    transfer = withState(transfer, 'target_created', now, {
      target: {
        session_id: selected.encoded.session_id,
        native_log_path: selected.target_path,
        cwd,
        cli_version: version,
        manual_resume_command: manualCommand,
      },
    });
    await updateTransferRecord(dataRoot, transfer);

    await ensurePrivateDirectory(path.dirname(selected.target_path));
    await publishFileExclusive(
      selected.target_path,
      selected.encoded.jsonl,
    );
    await validateInstalledTranscript(
      selected.encoded,
      projectsRoot,
      messages,
      cwd,
      version,
    );

    const projectionId = `prj_${randomUUID()}`;
    const projection: ProjectionRecord = {
      schema_version: 1,
      projection_id: projectionId,
      lineage_id: source.lineage_id,
      provider: 'claude',
      native_session_id: selected.encoded.session_id,
      native_log_path: selected.target_path,
      cwd,
      cli_version: version,
      canonical_head_event_id: source.events.at(-1)?.event_id ?? null,
      canonical_event_count: source.events.length,
      native_cursor: {
        byte_offset: Buffer.byteLength(selected.encoded.jsonl, 'utf8'),
        record_count: selected.encoded.records.length,
        leaf_uuid: selected.encoded.leaf_uuid,
        nearby_event_fingerprints: nearbyFingerprints(messages),
      },
      source: {
        provider: 'codex',
        native_session_id: sourceSessionId,
      },
      status: 'projected',
      created_at: timestamp(now),
    };
    await writeProjectionRecord(dataRoot, projection);
    transfer = withState(transfer, 'projected', now, {
      projection_id: projectionId,
    });
    await updateTransferRecord(dataRoot, transfer);

    writeStatus(
      `Created Claude session ${selected.encoded.session_id}\nResume manually: ${manualCommand}\n`,
    );
    transfer = withState(transfer, 'launching', now);
    await updateTransferRecord(dataRoot, transfer);
    try {
      await launchClaude(claudeCommand, selected.encoded.session_id, cwd);
    } catch (error) {
      transfer = withState(transfer, 'launch_failed', now, {
        error: {
          message: errorMessage(error),
          recorded_at: timestamp(now),
        },
      });
      await updateTransferRecord(dataRoot, transfer);
      throw error;
    }
    transfer = withState(transfer, 'complete', now);
    await updateTransferRecord(dataRoot, transfer);

    return {
      transfer_id: transferId,
      projection_id: projectionId,
      lineage_id: source.lineage_id,
      source_session_id: sourceSessionId,
      target_session_id: selected.encoded.session_id,
      target_path: selected.target_path,
      cwd,
      manual_resume_command: manualCommand,
    };
  } catch (error) {
    if (transfer.state !== 'launch_failed') {
      transfer = {
        ...transfer,
        updated_at: timestamp(now),
        error: {
          message: errorMessage(error),
          recorded_at: timestamp(now),
        },
      };
      await updateTransferRecord(dataRoot, transfer).catch(() => undefined);
    }
    throw error;
  }
}
