import { RefuseError } from './errors.ts';

export const GPU_ANCHOR = '(allow iokit-get-properties)';

export const GPU_RULES = [
  '; GPU (Metal) - added by gpu-run',
  '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))',
  '(allow mach-lookup (global-name "com.apple.MTLCompilerService"))',
].join('\n');

const ALLOWED_GPU_OPERATIONS = new Set(['iokit-open', 'mach-lookup', 'sysctl-read']);

/** Operations named by `(allow <op> …)` forms in a rule block. */
export function allowedOperations(rules: string): string[] {
  return [...rules.matchAll(/\(allow\s+([^\s()]+)/g)].flatMap(m => (m[1] === undefined ? [] : [m[1]]));
}

export function patchProfile(profile: string, rules: string = GPU_RULES): string {
  for (const op of allowedOperations(rules)) {
    if (!ALLOWED_GPU_OPERATIONS.has(op)) throw new RefuseError(`internal: GPU rules may not allow ${op}`);
  }
  if (/\(deny\b/.test(rules)) throw new RefuseError('internal: GPU rules may not contain deny rules');
  const parts = profile.split(GPU_ANCHOR);
  if (parts.length !== 2) {
    throw new RefuseError(`GPU patch anchor ${GPU_ANCHOR} found ${parts.length - 1} times in the generated profile`);
  }
  return `${parts[0]}${GPU_ANCHOR}\n\n${rules}\n${parts[1]}`;
}

/**
 * Split a command line produced by srt's `quote()`: words separated by single spaces,
 * each made of bare characters, `'…'` segments and `"'"` segments. Anything else is rejected.
 */
export function splitQuoted(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let i = 0;
  const bare = /[A-Za-z0-9_./:=@+,-]/;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      if (!inWord) throw new RefuseError('unexpected srt command format: empty word');
      words.push(word);
      word = '';
      inWord = false;
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new RefuseError('unexpected srt command format: unterminated quote');
      word += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (line.startsWith(`"'"`, i)) {
      word += "'";
      inWord = true;
      i += 3;
    } else if (c !== undefined && bare.test(c)) {
      word += c;
      inWord = true;
      i++;
    } else {
      throw new RefuseError(`unexpected srt command format: character ${JSON.stringify(c)}`);
    }
  }
  if (inWord) words.push(word);
  return words;
}

export interface SandboxExecInvocation {
  env: Record<string, string>;
  unset: string[];
  profile: string;
  command: string[];
}

/** Take apart `env [-u NAME]… [NAME=VALUE]… /usr/bin/sandbox-exec -p PROFILE SHELL -c CMD`. */
export function parseWrapped(wrapped: string): SandboxExecInvocation {
  const words = splitQuoted(wrapped);
  if (words[0] !== 'env') throw new RefuseError('unexpected srt command format: does not start with env');
  const env: Record<string, string> = {};
  const unset: string[] = [];
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === undefined || w === '/usr/bin/sandbox-exec') break;
    if (w === '-u') {
      const name = words[++i];
      if (name === undefined) throw new RefuseError('unexpected srt command format: -u without name');
      unset.push(name);
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new RefuseError(`unexpected srt command format: ${JSON.stringify(w.slice(0, 40))}`);
    }
    env[m[1]] = m[2];
  }
  if (words[i] !== '/usr/bin/sandbox-exec' || words[i + 1] !== '-p') {
    throw new RefuseError('unexpected srt command format: sandbox-exec -p not found');
  }
  const profile = words[i + 2];
  const command = words.slice(i + 3);
  if (profile === undefined || command.length === 0) throw new RefuseError('unexpected srt command format: missing profile or command');
  return { env, unset, profile, command };
}
