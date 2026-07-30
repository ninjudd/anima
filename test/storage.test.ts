import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readCodexSession } from '../src/codex.js';
import { StorageError } from '../src/errors.js';
import {
  commitCanonicalSession,
  initializeStore,
  publishFileExclusive,
} from '../src/storage.js';
import {
  CODEX_SESSION_ID,
  installCodexFixture,
  temporaryDirectory,
} from './helpers.js';

test('commits a private, repeatable canonical lineage archive', async () => {
  const temporary = await temporaryDirectory();
  try {
    const sessionsRoot = path.join(temporary.path, 'codex-sessions');
    const dataRoot = path.join(temporary.path, 'data');
    await installCodexFixture(sessionsRoot);
    const session = await readCodexSession(CODEX_SESSION_ID, {
      sessions_root: sessionsRoot,
    });

    await initializeStore(dataRoot);
    const archive = await commitCanonicalSession(
      dataRoot,
      session,
      '2026-07-29T20:00:00.000Z',
    );
    await commitCanonicalSession(
      dataRoot,
      session,
      '2026-07-29T20:00:01.000Z',
    );

    assert.equal((await stat(dataRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(archive.events_path)).mode & 0o777, 0o600);
    assert.equal((await stat(archive.manifest_path)).mode & 0o777, 0o600);
    assert.equal(
      (await readFile(archive.events_path, 'utf8'))
        .trim()
        .split('\n').length,
      session.events.length,
    );
    const manifest = JSON.parse(
      await readFile(archive.manifest_path, 'utf8'),
    ) as { canonical_head_event_id: string; updated_at: string };
    assert.equal(
      manifest.canonical_head_event_id,
      session.events.at(-1)?.event_id,
    );
    assert.equal(manifest.updated_at, '2026-07-29T20:00:01.000Z');
  } finally {
    await temporary.cleanup();
  }
});

test('exclusive publishing never replaces an existing file', async () => {
  const temporary = await temporaryDirectory();
  try {
    const filename = path.join(temporary.path, 'private', 'target.jsonl');
    await publishFileExclusive(filename, 'first\n');
    await assert.rejects(
      publishFileExclusive(filename, 'second\n'),
      StorageError,
    );
    assert.equal(await readFile(filename, 'utf8'), 'first\n');
  } finally {
    await temporary.cleanup();
  }
});
