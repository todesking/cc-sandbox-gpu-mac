import fs from 'node:fs';
import path from 'node:path';
import { RefuseError } from './errors.ts';

const GLOB = /[*?[\]]/;

export function hasGlob(p: string): boolean {
  return GLOB.test(p);
}

export class PathResolveError extends Error {
  override name = 'PathResolveError';
}

function expandHome(spec: string, home: string): string | undefined {
  if (spec === '~') return home;
  if (spec.startsWith('~/')) return path.join(home, spec.slice(2));
  if (spec.startsWith('~')) throw new PathResolveError(`unsupported home reference: ${spec}`);
  return undefined;
}

function normalize(p: string): string {
  const n = path.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

function checkSpec(spec: string): void {
  if (spec === '') throw new PathResolveError('empty path');
  if (spec.includes('\0')) throw new PathResolveError('path contains NUL');
}

/**
 * Path inside an `Edit(...)` / `Read(...)` permission rule.
 * `//x` is absolute, `/x` is relative to the settings source's base dir,
 * `~/x` is under home, anything else is relative to the project root.
 */
export function resolvePermissionRulePath(spec: string, base: string, projectRoot: string, home: string): string {
  checkSpec(spec);
  if (spec.startsWith('//')) return normalize(spec.slice(1));
  if (spec.startsWith('/')) return normalize(path.join(base, spec.slice(1)));
  const expanded = expandHome(spec, home);
  if (expanded !== undefined) return normalize(expanded);
  return normalize(path.resolve(projectRoot, spec));
}

/** Path in `sandbox.filesystem.*` / `sandbox.credentials.files`: standard POSIX spelling, relative to `base`. */
export function resolveSandboxPath(spec: string, base: string, home: string): string {
  checkSpec(spec);
  if (spec.startsWith('//')) return normalize(spec.slice(1));
  const expanded = expandHome(spec, home);
  if (expanded !== undefined) return normalize(expanded);
  return normalize(path.resolve(base, spec));
}

/** Entry of `permissions.additionalDirectories`: relative to the project root, trailing `/` or `/**` dropped. */
export function resolveAdditionalDirectory(spec: string, projectRoot: string, home: string): string {
  checkSpec(spec);
  const stripped = spec.replace(/(?:\/\*\*|\/)+$/, '') || '/';
  const expanded = expandHome(stripped, home);
  const resolved = normalize(expanded ?? path.resolve(projectRoot, stripped));
  if (hasGlob(resolved)) throw new PathResolveError(`glob in additional directory: ${spec}`);
  return resolved;
}

/** Longest leading run of path components without glob characters. */
function literalPrefix(p: string): { prefix: string; rest: string } {
  const parts = p.split('/');
  const i = parts.findIndex(part => hasGlob(part));
  if (i === -1) return { prefix: p, rest: '' };
  return { prefix: parts.slice(0, i).join('/') || '/', rest: parts.slice(i).join('/') };
}

/** `realpath` of the longest existing ancestor, with the non-existing remainder appended. */
export function realpathPartial(p: string): string {
  let existing = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (e) {
      if (!isNotFound(e)) throw e;
      const parent = path.dirname(existing);
      if (parent === existing) return p;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isNotFound(e: unknown): boolean {
  if (!(e instanceof Error) || !('code' in e)) return false;
  return e.code === 'ENOENT' || e.code === 'ENOTDIR';
}

/**
 * The spellings Seatbelt must see for an absolute path or glob: the lexical one and,
 * when a symlink is involved (e.g. /tmp -> /private/tmp), the real one.
 */
export function spellings(p: string): string[] {
  if (!path.isAbsolute(p)) throw new RefuseError(`internal: non-absolute path ${p}`);
  const { prefix, rest } = literalPrefix(p);
  const real = realpathPartial(prefix);
  const realFull = rest === '' ? real : path.posix.join(real, rest);
  return realFull === p ? [p] : [p, realFull];
}

/** Undo the backslash escaping Claude Code allows inside rule content (`Read(foo\(1\).txt)`). */
export function unescapeRuleContent(content: string): string {
  return content.replace(/\\([()\\])/g, '$1');
}

/** Parse `Tool(content)` permission rules. Rules without content are ignored. */
export function parseRule(rule: string): { tool: string; content: string } | undefined {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s.exec(rule.trim());
  if (!m || m[1] === undefined || m[2] === undefined || m[2] === '') return undefined;
  return { tool: m[1], content: unescapeRuleContent(m[2]) };
}

export function isUnder(child: string, parent: string): boolean {
  if (parent === '/') return child.startsWith('/');
  return child === parent || child.startsWith(parent + '/');
}
