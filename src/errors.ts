export class AnimaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UsageError extends AnimaError {}

export class SessionNotFoundError extends AnimaError {}

export class AmbiguousSessionError extends AnimaError {}

export class SessionFormatError extends AnimaError {}

export class ClaudeTranscriptError extends AnimaError {}

export class ClaudeLaunchError extends AnimaError {}

export class StorageError extends AnimaError {}

export class TransferError extends AnimaError {}

export class CodexAppServerError extends AnimaError {}

export class CodexAppServerRequestTimeoutError extends CodexAppServerError {}
