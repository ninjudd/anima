#!/usr/bin/env node

import process from 'node:process';

import { readClaudeSession } from './claude.js';
import { readCodexSession } from './codex.js';
import { AnimaError, UsageError } from './errors.js';

const HELP = `Usage:
  anima --claude <session-id> --dry-run
  anima --codex <session-id> --dry-run

Options:
  --claude <session-id>  Read a Claude Code session and target Codex
  --codex <session-id>   Read a Codex session and target Claude Code
  --dry-run              Print canonical history without creating a target
  -h, --help             Show this help

Environment:
  ANIMA_CLAUDE_PROJECTS_DIR  Override ~/.claude/projects
  ANIMA_CODEX_SESSIONS_DIR   Override ~/.codex/sessions
`;

interface Arguments {
  provider: 'claude' | 'codex';
  sessionId: string;
  dryRun: boolean;
}

function parseArguments(argv: string[]): Arguments | 'help' {
  let provider: Arguments['provider'] | undefined;
  let sessionId: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return 'help';
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--claude' || argument === '--codex') {
      if (provider !== undefined) {
        throw new UsageError('Pass exactly one of --claude or --codex.');
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`${argument} requires a session ID.`);
      }
      provider = argument === '--claude' ? 'claude' : 'codex';
      sessionId = value;
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown argument: ${argument}`);
  }

  if (provider === undefined || sessionId === undefined) {
    throw new UsageError('Pass exactly one of --claude or --codex.');
  }
  if (!dryRun) {
    throw new UsageError(
      'Target history projection is not implemented yet; use --dry-run.',
    );
  }
  return { provider, sessionId, dryRun };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const session =
    args.provider === 'claude'
      ? await readClaudeSession(args.sessionId, {
          ...(process.env.ANIMA_CLAUDE_PROJECTS_DIR !== undefined
            ? { projects_root: process.env.ANIMA_CLAUDE_PROJECTS_DIR }
            : {}),
        })
      : await readCodexSession(args.sessionId, {
          ...(process.env.ANIMA_CODEX_SESSIONS_DIR !== undefined
            ? { sessions_root: process.env.ANIMA_CODEX_SESSIONS_DIR }
            : {}),
        });

  process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof AnimaError || error instanceof Error
      ? error.message
      : String(error);
  process.stderr.write(`anima: ${message}\n`);
  process.exitCode = 1;
});
