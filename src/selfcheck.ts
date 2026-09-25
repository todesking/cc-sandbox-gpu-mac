import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { RefuseError } from './errors.ts';
import { hasGlob, isUnder, spellings } from './paths.ts';

/** srt's git-style glob, plus the `(/.*)?` tail its rules use to cover everything below a match. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.^$+{}()|\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${body}(/.*)?$`);
}

function covers(entry: string, p: string): boolean {
  return hasGlob(entry) ? globToRegExp(entry).test(p) : isUnder(p, entry);
}

/** The allowWrite entry that makes `p` writable under `config`, if any. Errs on the side of "writable". */
export function writableVia(config: SandboxRuntimeConfig, p: string): string | undefined {
  const fsConfig = config.filesystem;
  if (!fsConfig) return undefined;
  for (const s of spellings(p)) {
    if (fsConfig.denyWrite.some(d => covers(d, s))) continue;
    const allow = fsConfig.allowWrite.find(a => covers(a, s));
    if (allow !== undefined) return allow;
  }
  return undefined;
}

/**
 * gpu-run's own files must not be writable from the sandbox it builds (or Claude Code's,
 * which has the same allowWrite roots): otherwise a sandboxed command could replace them
 * and have them run outside any sandbox the next time.
 */
export function checkInstallNotWritable(config: SandboxRuntimeConfig, paths: string[]): void {
  for (const p of paths) {
    const via = writableVia(config, p);
    if (via !== undefined) {
      throw new RefuseError(`${p} is writable from the sandbox (via allowWrite ${via}); install gpu-run elsewhere`);
    }
  }
}
