export type Provider = 'claude' | 'codex';

export type JsonObject = Record<string, unknown>;

export interface NativePosition {
  record: number;
  block: number;
}

export interface EventOrigin {
  provider: Provider;
  session_id: string;
  native_position: NativePosition;
  native_event_id?: string;
  native_parent_id?: string;
  timestamp?: string;
}

interface BaseEvent {
  schema_version: 1;
  event_id: string;
  lineage_id: string;
  parent_event_id: string | null;
  origin: EventOrigin;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface MessageEvent extends BaseEvent {
  kind: 'message';
  role: 'user' | 'assistant';
  content: TextContent[];
}

export interface ToolCallEvent extends BaseEvent {
  kind: 'tool_call';
  tool_name: string;
  call_id?: string;
  input: unknown;
}

export interface ToolResultEvent extends BaseEvent {
  kind: 'tool_result';
  call_id?: string;
  output: string;
  is_error: boolean;
  output_bytes: number;
  output_sha256: string;
  truncated: boolean;
  source: {
    path: string;
    record: number;
  };
}

export interface ContextNoteEvent extends BaseEvent {
  kind: 'context_note';
  label: string;
  content: TextContent[];
}

export type CanonicalEvent =
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ContextNoteEvent;

export interface SessionWarning {
  code: 'invalid_final_fragment' | 'cwd_changed';
  message: string;
  record?: number;
}

export interface CanonicalSession {
  schema_version: 1;
  provider: Provider;
  session_id: string;
  cwd: string;
  native_path: string;
  lineage_id: string;
  events: CanonicalEvent[];
  warnings: SessionWarning[];
  cli_version?: string;
  title?: string;
}

export interface JsonlRecord {
  value: JsonObject;
  position: {
    record: number;
    byte_offset: number;
  };
}

export interface JsonlReadResult {
  records: JsonlRecord[];
  warnings: SessionWarning[];
}

export type EventCandidate =
  | {
      kind: 'message';
      role: 'user' | 'assistant';
      text: string;
      native_position: NativePosition;
      native_event_id?: string;
      native_parent_id?: string;
      timestamp?: string;
    }
  | {
      kind: 'tool_call';
      tool_name: string;
      input: unknown;
      native_position: NativePosition;
      call_id?: string;
      native_event_id?: string;
      native_parent_id?: string;
      timestamp?: string;
    }
  | {
      kind: 'tool_result';
      output: unknown;
      is_error: boolean;
      native_position: NativePosition;
      call_id?: string;
      native_event_id?: string;
      native_parent_id?: string;
      timestamp?: string;
    }
  | {
      kind: 'context_note';
      label: string;
      text: string;
      native_position: NativePosition;
      native_event_id?: string;
      native_parent_id?: string;
      timestamp?: string;
    };
