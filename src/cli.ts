import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClaudeLaunch, findClaudeProcess } from './context.ts';
import { decodeEnv } from './env.ts';
import { RefuseError } from './errors.ts';
import { buildConfig, type RuleContext } from './rules.ts';
import { runSandboxed } from './run.ts';
import { checkInstallNotWritable } from './selfcheck.ts';
import { loadSettings } from './settings.ts';

const EXIT_REFUSED = 125;

const USAGE = `usage: gpu-run [--explain] [--] <command> [args...]

Run <command> in a Seatbelt sandbox rebuilt from the Claude Code settings,
with Metal GPU access added. Must be started by Claude Code through
sandbox.excludedCommands.

  --explain   print the srt config, the reason for every entry and the final
              profile as JSON; run nothing
`;

function parseArgs(args: string[]): { explain: boolean; help: boolean; command: string[] } {
  let explain = false;
  let help = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--explain') explain = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a !== undefined && a.startsWith('-')) throw new RefuseError(`unknown option ${a}`);
    else break;
  }
  return { explain, help, command: args.slice(i) };
}

function packageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (process.platform !== 'darwin') throw new RefuseError('gpu-run only supports macOS');

  const encodedEnv = process.env['GPU_RUN_ENV'];
  const launcher = process.env['GPU_RUN_LAUNCHER'];
  if (encodedEnv === undefined || launcher === undefined) {
    throw new RefuseError('gpu-run must be started through its launcher (see README: Install)');
  }
  const env = decodeEnv(encodedEnv);

  // Nothing below may depend on the caller's environment.
  const home = os.userInfo().homedir;
  for (const name of Object.keys(process.env)) {
    if (name !== 'PATH' && name !== 'LANG') delete process.env[name];
  }
  process.env['HOME'] = home;

  const cc = findClaudeProcess(home);
  const warnings = checkClaudeLaunch(cc);
  const ctx: RuleContext = {
    home,
    projectRoot: fs.realpathSync(cc.cwd),
    configDir: path.join(home, '.claude'),
    tempRoot: `/tmp/claude-${process.getuid?.() ?? 0}`,
  };
  const { tiers, effective } = await loadSettings(ctx.projectRoot);
  const build = buildConfig(ctx, tiers, effective);
  checkInstallNotWritable(build.config, [launcher, packageRoot(), fs.realpathSync(process.execPath)]);

  for (const w of [...warnings, ...build.warnings]) process.stderr.write(`gpu-run: warning: ${w}\n`);
  return runSandboxed({ ctx, build, cwd: process.cwd(), argv: args.command, env, explain: args.explain });
}

main().then(
  code => process.exit(code),
  (e: unknown) => {
    if (e instanceof RefuseError) {
      process.stderr.write(`gpu-run: refused: ${e.message}\n`);
    } else {
      process.stderr.write(`gpu-run: error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    }
    process.exit(EXIT_REFUSED);
  },
);
