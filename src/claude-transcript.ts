import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ClaudeTranscriptError } from './errors.js';
import type { JsonObject } from './types.js';

export const SUPPORTED_CLAUDE_TRANSCRIPT_VERSION = '2.1.220';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ClaudeTranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface EncodeClaudeTranscriptOptions {
  session_id: string;
  cwd: string;
  cli_version: string;
  messages: readonly ClaudeTranscriptMessage[];
  started_at?: string;
  uuid_factory?: () => string;
}

export interface EncodedClaudeTranscript {
  session_id: string;
  project_directory: string;
  leaf_uuid: string;
  records: JsonObject[];
  jsonl: string;
}

function nextUuid(factory: () => string, used: Set<string>): string {
  const value = factory();
  if (!UUID.test(value)) {
    throw new ClaudeTranscriptError(
      `Claude transcript UUID factory returned an invalid UUID: ${value}`,
    );
  }
  if (used.has(value)) {
    throw new ClaudeTranscriptError(
      `Claude transcript UUID factory returned duplicate UUID ${value}.`,
    );
  }
  used.add(value);
  return value;
}

function timestampAt(startedAt: number, index: number): string {
  return new Date(startedAt + index).toISOString();
}

function commonRecord(
  options: EncodeClaudeTranscriptOptions,
  parentUuid: string | null,
  uuid: string,
  timestamp: string,
): JsonObject {
  return {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: options.cwd,
    sessionId: options.session_id,
    version: options.cli_version,
    gitBranch: '',
    uuid,
    timestamp,
    entrypoint: 'cli',
  };
}

function userRecord(
  options: EncodeClaudeTranscriptOptions,
  message: ClaudeTranscriptMessage,
  parentUuid: string | null,
  uuid: string,
  promptId: string,
  timestamp: string,
): JsonObject {
  return {
    ...commonRecord(options, parentUuid, uuid, timestamp),
    type: 'user',
    message: {
      role: 'user',
      content: message.text,
    },
    permissionMode: 'dontAsk',
    promptSource: 'typed',
    promptId,
  };
}

function assistantRecord(
  options: EncodeClaudeTranscriptOptions,
  message: ClaudeTranscriptMessage,
  parentUuid: string | null,
  uuid: string,
  timestamp: string,
): JsonObject {
  const identifier = uuid.replaceAll('-', '');
  return {
    ...commonRecord(options, parentUuid, uuid, timestamp),
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      id: `msg_anima_${identifier}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: message.text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: 'not_available',
        iterations: [],
        speed: 'standard',
      },
      diagnostics: null,
    },
    requestId: `req_anima_${identifier}`,
  };
}

export function claudeProjectDirectoryName(cwd: string): string {
  if (!path.isAbsolute(cwd)) {
    throw new ClaudeTranscriptError(
      `Claude transcript cwd must be absolute: ${cwd}`,
    );
  }
  return cwd.replaceAll(/[^A-Za-z0-9-]/g, '-');
}

export function encodeClaudeTranscript(
  options: EncodeClaudeTranscriptOptions,
): EncodedClaudeTranscript {
  if (!UUID.test(options.session_id)) {
    throw new ClaudeTranscriptError(
      `Claude transcript session_id must be a UUID: ${options.session_id}`,
    );
  }
  const projectDirectory = claudeProjectDirectoryName(options.cwd);
  if (options.cli_version !== SUPPORTED_CLAUDE_TRANSCRIPT_VERSION) {
    throw new ClaudeTranscriptError(
      `Claude transcript version ${options.cli_version} is not supported; expected ${SUPPORTED_CLAUDE_TRANSCRIPT_VERSION}.`,
    );
  }
  if (options.messages.length === 0) {
    throw new ClaudeTranscriptError(
      'Claude transcript must contain at least one message.',
    );
  }

  const startedAtText = options.started_at ?? new Date().toISOString();
  const startedAt = Date.parse(startedAtText);
  if (!Number.isFinite(startedAt)) {
    throw new ClaudeTranscriptError(
      `Claude transcript started_at is invalid: ${startedAtText}`,
    );
  }

  const factory = options.uuid_factory ?? randomUUID;
  const used = new Set([options.session_id]);
  const records: JsonObject[] = [];
  let parentUuid: string | null = null;

  for (const [index, message] of options.messages.entries()) {
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string' ||
      message.text === ''
    ) {
      throw new ClaudeTranscriptError(
        `Claude transcript message ${String(index)} is invalid.`,
      );
    }

    const uuid = nextUuid(factory, used);
    const timestamp = timestampAt(startedAt, index);
    records.push(
      message.role === 'user'
        ? userRecord(
            options,
            message,
            parentUuid,
            uuid,
            nextUuid(factory, used),
            timestamp,
          )
        : assistantRecord(
            options,
            message,
            parentUuid,
            uuid,
            timestamp,
          ),
    );
    parentUuid = uuid;
  }

  return {
    session_id: options.session_id,
    project_directory: projectDirectory,
    leaf_uuid: parentUuid!,
    records,
    jsonl: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  };
}
