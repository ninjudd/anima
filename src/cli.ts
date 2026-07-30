#!/usr/bin/env node

import process from 'node:process';

import { readClaudeSession } from './claude.js';
import { readCodexSession } from './codex.js';
import { transferCodexToClaude } from './codex-to-claude.js';
import { AnimaError, UsageError } from './errors.js';

const HELP = `Usage:
  anima --claude <session-id> --dry-run
  anima --codex <session-id> --dry-run
  anima --codex <session-id> [--cwd <path>] [--include-tool-output]

Options:
  --claude <session-id>  Read a Claude Code session and target Codex
  --codex <session-id>   Read a Codex session and target Claude Code
  --dry-run              Print canonical history without creating a target
  --cwd <path>           Override the target working directory
  --include-tool-output  Project up to 64 KiB instead of 8 KiB per tool result
  -h, --help             Show this help

Environment:
  ANIMA_CLAUDE_PROJECTS_DIR  Override Claude's projects root (must end /projects)
  ANIMA_CODEX_SESSIONS_DIR   Override ~/.codex/sessions
  ANIMA_DATA_DIR             Override ~/.local/share/anima
  ANIMA_CLAUDE_COMMAND       Override the target Claude executable
`;

interface Arguments {
  provider: 'claude' | 'codex';
  sessionId: string;
  dryRun: boolean;
  cwd?: string;
  includeToolOutput: boolean;
}

function parseArguments(argv: string[]): Arguments | 'help' {
  let provider: Arguments['provider'] | undefined;
  let sessionId: string | undefined;
  let dryRun = false;
  let cwd: string | undefined;
  let includeToolOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return 'help';
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--include-tool-output') {
      includeToolOutput = true;
      continue;
    }
    if (argument === '--cwd') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError('--cwd requires a path.');
      }
      cwd = value;
      index += 1;
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
  if (provider === 'claude' && !dryRun) {
    throw new UsageError(
      'Claude-to-Codex projection is not enabled yet; use --dry-run.',
    );
  }
  if (dryRun && (cwd !== undefined || includeToolOutput)) {
    throw new UsageError(
      '--cwd and --include-tool-output apply only when creating a target.',
    );
  }
  return {
    provider,
    sessionId,
    dryRun,
    ...(cwd !== undefined ? { cwd } : {}),
    includeToolOutput,
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (args.provider === 'codex' && !args.dryRun) {
    await transferCodexToClaude(args.sessionId, {
      ...(process.env.ANIMA_CODEX_SESSIONS_DIR !== undefined
        ? { codex_sessions_root: process.env.ANIMA_CODEX_SESSIONS_DIR }
        : {}),
      ...(process.env.ANIMA_CLAUDE_PROJECTS_DIR !== undefined
        ? { claude_projects_root: process.env.ANIMA_CLAUDE_PROJECTS_DIR }
        : {}),
      ...(process.env.ANIMA_DATA_DIR !== undefined
        ? { data_root: process.env.ANIMA_DATA_DIR }
        : {}),
      ...(process.env.ANIMA_CLAUDE_COMMAND !== undefined
        ? { claude_command: process.env.ANIMA_CLAUDE_COMMAND }
        : {}),
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      ...(args.includeToolOutput ? { include_tool_output: true } : {}),
    });
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
