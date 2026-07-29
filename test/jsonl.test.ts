import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { SessionFormatError } from '../src/errors.js';
import { readJsonl } from '../src/jsonl.js';
import { temporaryDirectory } from './helpers.js';

test('accepts a valid final JSON record without a trailing newline', async () => {
  const temporary = await temporaryDirectory();
  try {
    const transcript = path.join(temporary.path, 'valid.jsonl');
    await writeFile(transcript, '{"type":"first"}\n{"type":"last"}');

    const result = await readJsonl(transcript);

    assert.deepEqual(
      result.records.map((record) => record.value.type),
      ['first', 'last'],
    );
    assert.deepEqual(result.warnings, []);
  } finally {
    await temporary.cleanup();
  }
});

test('accepts a BOM-prefixed first record without a trailing newline', async () => {
  const temporary = await temporaryDirectory();
  try {
    const transcript = path.join(temporary.path, 'bom.jsonl');
    await writeFile(transcript, '\uFEFF{"type":"only"}');

    const result = await readJsonl(transcript);

    assert.equal(result.records[0]?.value.type, 'only');
    assert.deepEqual(result.warnings, []);
  } finally {
    await temporary.cleanup();
  }
});

test('warns and ignores an invalid final fragment', async () => {
  const temporary = await temporaryDirectory();
  try {
    const transcript = path.join(temporary.path, 'partial.jsonl');
    await writeFile(transcript, '{"type":"first"}\n{"type":');

    const result = await readJsonl(transcript);

    assert.equal(result.records.length, 1);
    assert.deepEqual(result.warnings, [
      {
        code: 'invalid_final_fragment',
        message: `Ignored invalid final JSON fragment in ${transcript}.`,
        record: 2,
      },
    ]);
  } finally {
    await temporary.cleanup();
  }
});

test('rejects invalid JSON before the final fragment', async () => {
  const temporary = await temporaryDirectory();
  try {
    const transcript = path.join(temporary.path, 'invalid.jsonl');
    await writeFile(transcript, '{"type":"first"}\nnot-json\n{"type":"last"}\n');

    await assert.rejects(readJsonl(transcript), SessionFormatError);
  } finally {
    await temporary.cleanup();
  }
});

test('rejects a structurally invalid final JSON value', async () => {
  const temporary = await temporaryDirectory();
  try {
    const transcript = path.join(temporary.path, 'invalid-shape.jsonl');
    await writeFile(transcript, '{"type":"first"}\n[]');

    await assert.rejects(readJsonl(transcript), SessionFormatError);
  } finally {
    await temporary.cleanup();
  }
});
