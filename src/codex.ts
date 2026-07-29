import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { buildCanonicalSession } from './canonical.js';
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

export interface CodexReaderOptions {
  sessions_root?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function findRollouts(root: string, sessionId: string): Promise<string[]> {
  const matches: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (
        entry.isFile() &&
        (entry.name === `${sessionId}.jsonl` ||
          entry.name.endsWith(`-${sessionId}.jsonl`))
      ) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort();
}

export async function findCodexSession(
  sessionId: string,
  options: CodexReaderOptions = {},
): Promise<string> {
  validateSessionId(sessionId);
  const root = options.sessions_root ?? path.join(homedir(), '.codex', 'sessions');
  const matches = await findRollouts(root, sessionId);

  if (matches.length === 0) {
    throw new SessionNotFoundError(
      `Codex session ${sessionId} was not found under ${root}.`,
    );
  }
  if (matches.length > 1) {
    throw new AmbiguousSessionError(
      `Codex session ${sessionId} has multiple rollouts: ${matches.join(', ')}`,
    );
  }
  return matches[0]!;
}

function metadata(records: JsonlRecord[], nativePath: string) {
  const record = records.find((item) => item.value.type === 'session_meta');
  const payload = objectValue(record?.value.payload);
  if (payload === undefined) {
    throw new SessionFormatError(
      `Codex rollout ${nativePath} has no session_meta record.`,
    );
  }
  const primaryId = stringValue(payload.id);
  const sessionId = stringValue(payload.session_id);
  if (
    primaryId !== undefined &&
    sessionId !== undefined &&
    primaryId !== sessionId
  ) {
    throw new SessionFormatError(
      `Codex rollout ${nativePath} has conflicting metadata IDs ${primaryId} and ${sessionId}.`,
    );
  }
  const id = primaryId ?? sessionId;
  const cwd = stringValue(payload.cwd);
  if (id === undefined || cwd === undefined) {
    throw new SessionFormatError(
      `Codex rollout ${nativePath} has incomplete session metadata.`,
    );
  }
  return {
    id,
    cwd,
    version: stringValue(payload.cli_version),
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function outputText(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? null;

  const text = value
    .map((item) => {
      const block = objectValue(item);
      return (block?.type === 'input_text' ||
        block?.type === 'output_text' ||
        block?.type === 'text') &&
        typeof block.text === 'string'
        ? block.text
        : undefined;
    })
    .filter((item): item is string => item !== undefined);
  return text.length > 0 ? text.join('\n') : '[non-text tool output omitted]';
}

function messageKey(role: 'user' | 'assistant', text: string): string {
  return `${role}\0${text}`;
}

interface ResponseMessageOccurrence {
  key: string;
  record: number;
  timestamp?: string;
  matched: boolean;
}

function responseMessageOccurrences(
  records: JsonlRecord[],
): ResponseMessageOccurrence[] {
  const occurrences: ResponseMessageOccurrence[] = [];
  for (const record of records) {
    if (record.value.type !== 'response_item') continue;
    const payload = objectValue(record.value.payload);
    if (payload?.type !== 'message') continue;
    const role = stringValue(payload.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const expectedType = role === 'user' ? 'input_text' : 'output_text';
    const content = Array.isArray(payload.content) ? payload.content : [];
    for (const item of content) {
      const block = objectValue(item);
      if (block?.type !== expectedType || typeof block.text !== 'string') continue;
      const timestamp = stringValue(record.value.timestamp);
      occurrences.push({
        key: messageKey(role, block.text),
        record: record.position.record,
        matched: false,
        ...(timestamp !== undefined ? { timestamp } : {}),
      });
    }
  }
  return occurrences;
}

function matchesNearbyResponse(
  occurrences: ResponseMessageOccurrence[],
  key: string,
  record: number,
  timestamp: string | undefined,
): boolean {
  const candidates = occurrences
    .filter((occurrence) => {
      if (occurrence.matched || occurrence.key !== key) return false;
      const sameTimestamp =
        timestamp !== undefined && occurrence.timestamp === timestamp;
      return sameTimestamp || Math.abs(occurrence.record - record) <= 2;
    })
    .sort(
      (left, right) =>
        Math.abs(left.record - record) - Math.abs(right.record - record),
    );
  const match = candidates[0];
  if (match === undefined) return false;
  match.matched = true;
  return true;
}

function codexCandidates(records: JsonlRecord[]): EventCandidate[] {
  const candidates: EventCandidate[] = [];
  const responseMessages = responseMessageOccurrences(records);

  for (const record of records) {
    const payload = objectValue(record.value.payload);
    if (payload === undefined) continue;
    const timestamp = stringValue(record.value.timestamp);
    const positionFor = (block: number) => ({
      native_position: { record: record.position.record, block },
      ...(timestamp !== undefined ? { timestamp } : {}),
    });

    if (record.value.type === 'response_item') {
      const payloadType = stringValue(payload.type);
      const nativeEventId = stringValue(payload.id);

      if (payloadType === 'message') {
        const role = stringValue(payload.role);
        if (role !== 'user' && role !== 'assistant') continue;
        const content = Array.isArray(payload.content) ? payload.content : [];
        for (const [blockIndex, item] of content.entries()) {
          const block = objectValue(item);
          if (block === undefined) continue;
          const expectedType = role === 'user' ? 'input_text' : 'output_text';
          if (block.type !== expectedType || typeof block.text !== 'string') continue;
          candidates.push({
            kind: 'message',
            role,
            text: block.text,
            ...positionFor(blockIndex),
            ...(nativeEventId !== undefined
              ? { native_event_id: nativeEventId }
              : {}),
          });
        }
      } else if (
        payloadType === 'function_call' ||
        payloadType === 'custom_tool_call'
      ) {
        const toolName = stringValue(payload.name);
        if (toolName === undefined) continue;
        const callId = stringValue(payload.call_id);
        candidates.push({
          kind: 'tool_call',
          tool_name: toolName,
          input: parseArguments(payload.arguments ?? payload.input),
          ...positionFor(0),
          ...(callId !== undefined ? { call_id: callId } : {}),
          ...(nativeEventId !== undefined
            ? { native_event_id: nativeEventId }
            : {}),
        });
      } else if (
        payloadType === 'function_call_output' ||
        payloadType === 'custom_tool_call_output' ||
        payloadType === 'local_shell_call_output'
      ) {
        const callId = stringValue(payload.call_id);
        const nativeOutputId = nativeEventId ?? callId;
        candidates.push({
          kind: 'tool_result',
          output: outputText(payload.output),
          is_error: false,
          ...positionFor(0),
          ...(callId !== undefined ? { call_id: callId } : {}),
          ...(nativeOutputId !== undefined
            ? { native_event_id: nativeOutputId }
            : {}),
        });
      } else if (payloadType === 'local_shell_call') {
        const callId = stringValue(payload.call_id);
        candidates.push({
          kind: 'tool_call',
          tool_name: 'shell',
          input: payload.action ?? null,
          ...positionFor(0),
          ...(callId !== undefined ? { call_id: callId } : {}),
          ...(nativeEventId !== undefined
            ? { native_event_id: nativeEventId }
            : {}),
        });
      }
      continue;
    }

    if (record.value.type === 'event_msg') {
      const payloadType = stringValue(payload.type);
      if (
        payloadType !== 'user_message' &&
        payloadType !== 'agent_message'
      ) {
        continue;
      }
      const message = stringValue(payload.message);
      if (message === undefined) continue;
      const role = payloadType === 'user_message' ? 'user' : 'assistant';
      const key = messageKey(role, message);
      if (
        matchesNearbyResponse(
          responseMessages,
          key,
          record.position.record,
          timestamp,
        )
      ) continue;
      candidates.push({
        kind: 'message',
        role,
        text: message,
        ...positionFor(0),
      });
    }
  }

  return candidates;
}

function cwdWarnings(records: JsonlRecord[], expected: string): SessionWarning[] {
  const values = records
    .filter((record) => record.value.type === 'turn_context')
    .map((record) => objectValue(record.value.payload))
    .map((payload) => stringValue(payload?.cwd))
    .filter((value): value is string => value !== undefined);
  const changed = values.find((value) => value !== expected);
  return changed === undefined
    ? []
    : [
        {
          code: 'cwd_changed',
          message: `Codex session changed working directory from ${expected} to ${values.at(-1)}.`,
        },
      ];
}

export async function readCodexSession(
  sessionId: string,
  options: CodexReaderOptions = {},
): Promise<CanonicalSession> {
  const nativePath = await findCodexSession(sessionId, options);
  const parsed = await readJsonl(nativePath);
  const meta = metadata(parsed.records, nativePath);
  if (meta.id !== sessionId) {
    throw new SessionFormatError(
      `Codex rollout ${nativePath} contains session ID ${meta.id}, expected ${sessionId}.`,
    );
  }

  const warnings = [
    ...parsed.warnings,
    ...cwdWarnings(parsed.records, meta.cwd),
  ];
  const cwd = warnings.some((warning) => warning.code === 'cwd_changed')
    ? parsed.records
        .filter((record) => record.value.type === 'turn_context')
        .map((record) => objectValue(record.value.payload))
        .map((payload) => stringValue(payload?.cwd))
        .filter((value): value is string => value !== undefined)
        .at(-1) ?? meta.cwd
    : meta.cwd;

  return buildCanonicalSession({
    provider: 'codex',
    session_id: sessionId,
    cwd,
    native_path: nativePath,
    candidates: codexCandidates(parsed.records),
    warnings,
    ...(meta.version !== undefined ? { cli_version: meta.version } : {}),
  });
}
