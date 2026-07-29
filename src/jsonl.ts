import { createReadStream } from 'node:fs';

import { SessionFormatError } from './errors.js';
import type { JsonObject, JsonlReadResult } from './types.js';

class JsonSyntaxError extends SessionFormatError {}

function parseObject(line: string, path: string, record: number): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new JsonSyntaxError(
      `Invalid JSONL record ${record} in ${path}: ${detail}`,
    );
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionFormatError(
      `JSONL record ${record} in ${path} must be an object.`,
    );
  }
  return value as JsonObject;
}

export async function readJsonl(path: string): Promise<JsonlReadResult> {
  const records: JsonlReadResult['records'] = [];
  const warnings: JsonlReadResult['warnings'] = [];
  const input = createReadStream(path, { encoding: 'utf8' });

  let pending = '';
  let recordNumber = 0;
  let byteOffset = 0;
  let firstLine = true;

  function normalize(rawLine: string): string {
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (firstLine && line.startsWith('\uFEFF')) line = line.slice(1);
    firstLine = false;
    return line;
  }

  function consume(rawLine: string): void {
    recordNumber += 1;
    const line = normalize(rawLine);

    const lineBytes = Buffer.byteLength(rawLine, 'utf8') + 1;
    if (line.trim() !== '') {
      records.push({
        value: parseObject(line, path, recordNumber),
        position: { record: recordNumber, byte_offset: byteOffset },
      });
    }
    byteOffset += lineBytes;
  }

  for await (const chunk of input) {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }

  if (pending !== '') {
    recordNumber += 1;
    const line = normalize(pending);
    if (line.trim() !== '') {
      try {
        records.push({
          value: parseObject(line, path, recordNumber),
          position: { record: recordNumber, byte_offset: byteOffset },
        });
      } catch (error) {
        if (!(error instanceof JsonSyntaxError)) throw error;
        warnings.push({
          code: 'invalid_final_fragment',
          message: `Ignored invalid final JSON fragment in ${path}.`,
          record: recordNumber,
        });
      }
    }
  }

  return { records, warnings };
}
