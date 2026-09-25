import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RefuseError } from './errors.ts';
import { isUnder } from './paths.ts';

export const CLEAN_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' };

export interface ClaudeProcess {
  pid: number;
  executable: string;
  cwd: string;
  /** `ps -E` output: argv and launch environment joined by spaces (ambiguous, only good for detection). */
  commandLine: string;
}

function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', env: CLEAN_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function parentPids(): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of run('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=']).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

/** First `n` field lsof reports for a descriptor type (`txt` = executable, `cwd`). */
function lsofName(pid: number, fd: string): string | undefined {
  let out: string;
  try {
    out = run('/usr/sbin/lsof', ['-w', '-a', '-p', String(pid), '-d', fd, '-Fn']);
  } catch {
    return undefined;
  }
  const line = out.split('\n').find(l => l.startsWith('n'));
  return line?.slice(1);
}

export function claudeVersionsDir(home: string): string {
  return path.join(home, '.local', 'share', 'claude', 'versions');
}

/** Nearest ancestor process whose executable is a Claude Code native install. */
export function findClaudeProcess(home: string): ClaudeProcess {
  let parents: Map<number, number>;
  try {
    parents = parentPids();
  } catch {
    throw new RefuseError('cannot list processes; gpu-run must run outside the sandbox (add it to sandbox.excludedCommands)');
  }
  const versions = claudeVersionsDir(home);
  let pid = parents.get(process.pid);
  for (let depth = 0; pid !== undefined && pid > 1 && depth < 64; depth++) {
    const exe = lsofName(pid, 'txt');
    let real: string | undefined;
    try {
      real = exe === undefined ? undefined : fs.realpathSync(exe);
    } catch {
      real = undefined;
    }
    if (real !== undefined && isUnder(real, versions)) {
      const cwd = lsofName(pid, 'cwd');
      if (cwd === undefined) throw new RefuseError(`cannot read the working directory of Claude Code (pid ${pid})`);
      let commandLine: string;
      try {
        commandLine = run('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]).trim();
      } catch {
        throw new RefuseError(`cannot read the command line of Claude Code (pid ${pid})`);
      }
      return { pid, executable: real, cwd, commandLine };
    }
    pid = parents.get(pid);
  }
  throw new RefuseError('no Claude Code ancestor process found; gpu-run only runs as a command started by Claude Code');
}

const UNSUPPORTED_FLAGS = /(?:^|\s)--(settings|setting-sources|disallowedTools|disallowed-tools)(?=[=\s]|$)/;
const UNSUPPORTED_ENV = /(?:^|\s)(CLAUDE_CONFIG_DIR|CLAUDE_CODE_TMPDIR|CLAUDE_TMPDIR)=/;

/** Refuse Claude Code launches whose settings gpu-run cannot reproduce. Returns warnings. */
export function checkClaudeLaunch(cc: ClaudeProcess): string[] {
  const flag = UNSUPPORTED_FLAGS.exec(cc.commandLine);
  if (flag) throw new RefuseError(`Claude Code was started with --${flag[1]}, which gpu-run does not support`);
  if (!/(?:^|\s)(HOME|PATH)=/.test(cc.commandLine)) {
    throw new RefuseError(`cannot read the launch environment of Claude Code (pid ${cc.pid})`);
  }
  const env = UNSUPPORTED_ENV.exec(cc.commandLine);
  if (env) throw new RefuseError(`Claude Code was started with ${env[1]} set, which gpu-run does not support`);
  const warnings: string[] = [];
  if (/(?:^|\s)--add-dir(?=[=\s]|$)/.test(cc.commandLine)) {
    warnings.push('directories passed to Claude Code with --add-dir are not writable inside gpu-run');
  }
  return warnings;
}
