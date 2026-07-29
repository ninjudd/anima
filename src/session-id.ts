import { UsageError } from './errors.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateSessionId(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new UsageError(
      'Session IDs must be 1–128 characters and contain only letters, numbers, dot, underscore, or hyphen.',
    );
  }
  return sessionId;
}
