import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { buildCanonicalSession, stableStringify } from './canonical.js';
import {
  AmbiguousSessionError,
  SessionFormatError,
  SessionNotFoundError,
} from './errors.js';
import { readJsonl } from './jsonl.js';
import { validateSessionId } from './session-id.js';
import type {
  CanonicalSession,
  EventCandidate,
  JsonlRecord,
  SessionWarning,
} from './types.js';

export interface ClaudeReaderOptions {
  projects_root?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sessionIds(record: JsonlRecord): string[] {
  const values = [
    stringValue(record.value.sessionId),
    stringValue(record.value.session_id),
  ];
  return values.filter((value): value is string => value !== undefined);
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function findClaudeSession(
  sessionId: string,
  options: ClaudeReaderOptions = {},
): Promise<string> {
  validateSessionId(sessionId);
  const root =
    options.projects_root ?? path.join(homedir(), '.claude', 'projects');

  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SessionNotFoundError(
        `Claude session ${sessionId} was not found under ${root}.`,
      );
    }
    throw error;
  }

  const matches: string[] = [];
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(root, project.name, `${sessionId}.jsonl`);
    if (await isFile(candidate)) matches.push(candidate);
  }

  if (matches.length === 0) {
    throw new SessionNotFoundError(
      `Claude session ${sessionId} was not found under ${root}.`,
    );
  }
  if (matches.length > 1) {
    throw new AmbiguousSessionError(
      `Claude session ${sessionId} exists in multiple projects: ${matches.join(', ')}`,
    );
  }
  return matches[0]!;
}

function selectActiveChain(records: JsonlRecord[]): JsonlRecord[] {
  const nodes = new Map<
    string,
    { record: JsonlRecord; parent?: string; ordinal: number }
  >();

  for (const record of records) {
    if (record.value.isSidechain === true) continue;
    const uuid = stringValue(record.value.uuid);
    if (uuid === undefined) continue;
    const parent = stringValue(record.value.parentUuid);
    nodes.set(uuid, {
      record,
      ordinal: record.position.record,
      ...(parent !== undefined ? { parent } : {}),
    });
  }
  if (nodes.size === 0) {
    return records.filter((record) => record.value.isSidechain !== true);
  }

  let leaf: string | undefined;
  for (const record of records) {
    if (record.value.type !== 'last-prompt') continue;
    const candidate = stringValue(record.value.leafUuid);
    if (candidate !== undefined && nodes.has(candidate)) leaf = candidate;
  }

  if (leaf === undefined) {
    const parents = new Set(
      [...nodes.values()]
        .map((node) => node.parent)
        .filter((value): value is string => value !== undefined),
    );
    const leaves = [...nodes.entries()].filter(([uuid]) => !parents.has(uuid));
    leaves.sort((a, b) => a[1].ordinal - b[1].ordinal);
    leaf = leaves.at(-1)?.[0];
  }
  if (leaf === undefined) return [];

  const active = new Set<string>();
  let cursor: string | undefined = leaf;
  while (cursor !== undefined && !active.has(cursor)) {
    active.add(cursor);
    cursor = nodes.get(cursor)?.parent;
  }

  return records.filter((record) => {
    if (record.value.isSidechain === true) return false;
    const uuid = stringValue(record.value.uuid);
    return uuid === undefined || active.has(uuid);
  });
}

function resolveCwd(
  records: JsonlRecord[],
  nativePath: string,
  warnings: SessionWarning[],
): string {
  const values = records
    .map((record) => stringValue(record.value.cwd))
    .filter((value): value is string => value !== undefined);
  if (values.length === 0) {
    throw new SessionFormatError(`Claude session ${nativePath} has no cwd.`);
  }
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    warnings.push({
      code: 'cwd_changed',
      message: `Claude session recorded multiple working directories; using ${values.at(-1)}.`,
    });
  }
  return values.at(-1)!;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[non-text tool result omitted]';
    return value
      .map((item) => {
        const block = objectValue(item);
        return block?.type === 'text' && typeof block.text === 'string'
          ? block.text
          : '[non-text tool result omitted]';
      })
      .join('\n');
  }
  const block = objectValue(value);
  if (block?.type === 'image' || block?.type === 'image_reference') {
    return '[non-text tool result omitted]';
  }
  return stableStringify(value);
}

function imagePlaceholder(block: Record<string, unknown>): string | undefined {
  if (block.type !== 'image' && block.type !== 'image_reference') {
    return undefined;
  }
  return '[image omitted]';
}

function claudeCandidates(records: JsonlRecord[]): EventCandidate[] {
  const candidates: EventCandidate[] = [];

  for (const record of records) {
    const value = record.value;
    if (value.isMeta === true || value.isSidechain === true) continue;
    const type = stringValue(value.type);
    if (type !== 'user' && type !== 'assistant') continue;

    const message = objectValue(value.message);
    if (message === undefined) continue;
    const content = message.content;
    const nativeEventId = stringValue(value.uuid);
    const nativeParentId = stringValue(value.parentUuid);
    const timestamp = stringValue(value.timestamp);
    const origin = {
      ...(nativeEventId !== undefined ? { native_event_id: nativeEventId } : {}),
      ...(nativeParentId !== undefined
        ? { native_parent_id: nativeParentId }
        : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    };

    if (value.isCompactSummary === true) {
      const summary = contentText(content);
      if (summary !== '') {
        candidates.push({
          kind: 'context_note',
          label: 'Claude compaction summary',
          text: summary,
          native_position: { record: record.position.record, block: 0 },
          ...origin,
        });
      }
      continue;
    }

    if (typeof content === 'string') {
      if (content !== '') {
        candidates.push({
          kind: 'message',
          role: type,
          text: content,
          native_position: { record: record.position.record, block: 0 },
          ...origin,
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const [blockIndex, item] of content.entries()) {
      const block = objectValue(item);
      if (block === undefined) continue;
      const position = {
        record: record.position.record,
        block: blockIndex,
      };
      const imageText = imagePlaceholder(block);

      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text === '') continue;
        candidates.push({
          kind: 'message',
          role: type,
          text: block.text,
          native_position: position,
          ...origin,
        });
      } else if (imageText !== undefined) {
        candidates.push({
          kind: 'message',
          role: type,
          text: imageText,
          native_position: position,
          ...origin,
        });
      } else if (type === 'assistant' && block.type === 'tool_use') {
        const toolName = stringValue(block.name);
        if (toolName === undefined) continue;
        const callId = stringValue(block.id);
        candidates.push({
          kind: 'tool_call',
          tool_name: toolName,
          input: block.input ?? null,
          native_position: position,
          ...origin,
          ...(callId !== undefined
            ? {
                call_id: callId,
                native_event_id: callId,
              }
            : {}),
        });
      } else if (type === 'user' && block.type === 'tool_result') {
        const callId = stringValue(block.tool_use_id);
        candidates.push({
          kind: 'tool_result',
          output: contentText(block.content),
          is_error: block.is_error === true,
          native_position: position,
          ...origin,
          ...(callId !== undefined
            ? {
                call_id: callId,
                native_event_id: callId,
              }
            : {}),
        });
      }
    }
  }

  return candidates;
}

export async function readClaudeSession(
  sessionId: string,
  options: ClaudeReaderOptions = {},
): Promise<CanonicalSession> {
  const nativePath = await findClaudeSession(sessionId, options);
  const parsed = await readJsonl(nativePath);

  const observedIds = new Set(parsed.records.flatMap((record) => sessionIds(record)));
  if (observedIds.size === 0) {
    throw new SessionFormatError(
      `Claude transcript ${nativePath} has no embedded session ID.`,
    );
  }
  for (const observed of observedIds) {
    if (observed !== sessionId) {
      throw new SessionFormatError(
        `Claude transcript ${nativePath} contains session ID ${observed}, expected ${sessionId}.`,
      );
    }
  }

  const selected = selectActiveChain(parsed.records);
  const warnings = [...parsed.warnings];
  const cwd = resolveCwd(selected, nativePath, warnings);
  const version = selected
    .map((record) => stringValue(record.value.version))
    .filter((value): value is string => value !== undefined)
    .at(-1);
  const title = parsed.records
    .filter((record) => record.value.type === 'ai-title')
    .map((record) => stringValue(record.value.aiTitle))
    .filter((value): value is string => value !== undefined)
    .at(-1);

  return buildCanonicalSession({
    provider: 'claude',
    session_id: sessionId,
    cwd,
    native_path: nativePath,
    candidates: claudeCandidates(selected),
    warnings,
    ...(version !== undefined ? { cli_version: version } : {}),
    ...(title !== undefined ? { title } : {}),
  });
}
