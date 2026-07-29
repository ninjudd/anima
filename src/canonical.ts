import { createHash } from 'node:crypto';

import type {
  CanonicalEvent,
  CanonicalSession,
  EventCandidate,
  EventOrigin,
  Provider,
  SessionWarning,
  ToolResultEvent,
} from './types.js';

export const CANONICAL_TOOL_OUTPUT_LIMIT = 64 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);
  return `{${entries.join(',')}}`;
}

function truncateUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;

  let bytes = 0;
  let output = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit) break;
    output += character;
    bytes += size;
  }
  return output;
}

function textFromUnknown(value: unknown): string {
  return typeof value === 'string' ? value : stableStringify(value);
}

function eventOrigin(
  provider: Provider,
  sessionId: string,
  candidate: EventCandidate,
): EventOrigin {
  return {
    provider,
    session_id: sessionId,
    native_position: candidate.native_position,
    ...(candidate.native_event_id !== undefined
      ? { native_event_id: candidate.native_event_id }
      : {}),
    ...(candidate.native_parent_id !== undefined
      ? { native_parent_id: candidate.native_parent_id }
      : {}),
    ...(candidate.timestamp !== undefined ? { timestamp: candidate.timestamp } : {}),
  };
}

function eventIdentity(
  provider: Provider,
  sessionId: string,
  candidate: EventCandidate,
): string {
  const nativeKey =
    candidate.native_event_id === undefined
      ? {
          position: candidate.native_position,
          parent_id: candidate.native_parent_id ?? null,
        }
      : {
          id: candidate.native_event_id,
          ...(candidate.kind === 'message'
            ? { block: candidate.native_position.block }
            : {}),
        };

  let payload: unknown;
  switch (candidate.kind) {
    case 'message':
      payload = {
        kind: candidate.kind,
        role: candidate.role,
        text: candidate.text,
      };
      break;
    case 'tool_call':
      payload = {
        kind: candidate.kind,
        tool_name: candidate.tool_name,
        call_id: candidate.call_id ?? null,
        input: candidate.input,
      };
      break;
    case 'tool_result':
      payload = {
        kind: candidate.kind,
        call_id: candidate.call_id ?? null,
        output: candidate.output,
        is_error: candidate.is_error,
      };
      break;
    case 'context_note':
      payload = {
        kind: candidate.kind,
        label: candidate.label,
        text: candidate.text,
      };
      break;
  }

  return `evt_${sha256(
    stableStringify({
      provider,
      session_id: sessionId,
      native_key: nativeKey,
      payload,
    }),
  )}`;
}

export interface BuildCanonicalSessionInput {
  provider: Provider;
  session_id: string;
  cwd: string;
  native_path: string;
  candidates: EventCandidate[];
  warnings: SessionWarning[];
  cli_version?: string;
  title?: string;
}

export function buildCanonicalSession(
  input: BuildCanonicalSessionInput,
): CanonicalSession {
  const lineageId = `lin_${sha256(`${input.provider}\0${input.session_id}`)}`;
  const events: CanonicalEvent[] = [];
  let parentEventId: string | null = null;

  for (const candidate of input.candidates) {
    const eventId = eventIdentity(input.provider, input.session_id, candidate);
    const base = {
      schema_version: 1 as const,
      event_id: eventId,
      lineage_id: lineageId,
      parent_event_id: parentEventId,
      origin: eventOrigin(input.provider, input.session_id, candidate),
    };

    let event: CanonicalEvent;
    switch (candidate.kind) {
      case 'message':
        event = {
          ...base,
          kind: 'message',
          role: candidate.role,
          content: [{ type: 'text', text: candidate.text }],
        };
        break;
      case 'tool_call':
        event = {
          ...base,
          kind: 'tool_call',
          tool_name: candidate.tool_name,
          input: candidate.input,
          ...(candidate.call_id !== undefined ? { call_id: candidate.call_id } : {}),
        };
        break;
      case 'tool_result': {
        const fullOutput = textFromUnknown(candidate.output);
        const outputBytes = Buffer.byteLength(fullOutput, 'utf8');
        const result: ToolResultEvent = {
          ...base,
          kind: 'tool_result',
          output: truncateUtf8(fullOutput, CANONICAL_TOOL_OUTPUT_LIMIT),
          is_error: candidate.is_error,
          output_bytes: outputBytes,
          output_sha256: sha256(fullOutput),
          truncated: outputBytes > CANONICAL_TOOL_OUTPUT_LIMIT,
          source: {
            path: input.native_path,
            record: candidate.native_position.record,
          },
          ...(candidate.call_id !== undefined ? { call_id: candidate.call_id } : {}),
        };
        event = result;
        break;
      }
      case 'context_note':
        event = {
          ...base,
          kind: 'context_note',
          label: candidate.label,
          content: [{ type: 'text', text: candidate.text }],
        };
        break;
    }

    events.push(event);
    parentEventId = eventId;
  }

  return {
    schema_version: 1,
    provider: input.provider,
    session_id: input.session_id,
    cwd: input.cwd,
    native_path: input.native_path,
    lineage_id: lineageId,
    events,
    warnings: input.warnings,
    ...(input.cli_version !== undefined ? { cli_version: input.cli_version } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
  };
}
