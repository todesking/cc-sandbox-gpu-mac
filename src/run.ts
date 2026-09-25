import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { RefuseError } from './errors.ts';
import { parseWrapped, patchProfile } from './profile.ts';
import type { BuildResult, RuleContext } from './rules.ts';

/** Same quoting as srt: bare words where safe, single quotes otherwise. */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

export interface RunOptions {
  ctx: RuleContext;
  build: BuildResult;
  /** W */
  cwd: string;
  argv: string[];
  /** environment cc-gpu-run was started with */
  env: Record<string, string>;
  explain: boolean;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function runSandboxed(opts: RunOptions): Promise<number> {
  const { ctx, build } = opts;
  // srt anchors its built-in deny rules at the cwd and takes the child's TMPDIR from CLAUDE_CODE_TMPDIR.
  process.chdir(ctx.projectRoot);
  if (isDirectory(ctx.tempRoot)) {
    process.env['CLAUDE_CODE_TMPDIR'] = ctx.tempRoot;
    process.env['TMPDIR'] = ctx.tempRoot;
  }

  await SandboxManager.initialize(build.config, undefined, false);
  try {
    const command = `cd ${shellQuote(opts.cwd)} && ${opts.argv.map(shellQuote).join(' ')}`;
    const wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/bash');
    const inv = parseWrapped(wrapped);
    const profile = patchProfile(inv.profile);

    const env: Record<string, string> = { ...opts.env };
    for (const name of [...build.unsetEnv, ...inv.unset]) delete env[name];
    Object.assign(env, inv.env);

    if (opts.explain) {
      const out = {
        config: build.config,
        trace: build.trace,
        unsetEnv: build.unsetEnv,
        envAdded: inv.env,
        command: ['/usr/bin/sandbox-exec', '-p', '<profile>', ...inv.command],
        profile,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }
    return await spawnAndWait('/usr/bin/sandbox-exec', ['-p', profile, ...inv.command], env);
  } finally {
    await SandboxManager.reset();
  }
}

const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

function spawnAndWait(file: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: 'inherit' });
    const forward = (sig: NodeJS.Signals): void => {
      child.kill(sig);
    };
    for (const sig of FORWARDED_SIGNALS) process.on(sig, forward);
    const cleanup = (): void => {
      for (const sig of FORWARDED_SIGNALS) process.off(sig, forward);
    };
    child.on('error', e => {
      cleanup();
      reject(new RefuseError(`cannot start sandbox-exec: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolve(code ?? 128 + (signal ? signalNumber(signal) : 0));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return os.constants.signals[signal];
}
