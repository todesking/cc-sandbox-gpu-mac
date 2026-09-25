import fs from 'node:fs';
import path from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { RefuseError } from './errors.ts';
import { getBoolean, getNumber, getObject, getObjects, getStrings, isObject, type JsonObject } from './json.ts';
import {
  PathResolveError,
  parseRule,
  resolveAdditionalDirectory,
  resolvePermissionRulePath,
  resolveSandboxPath,
  spellings,
} from './paths.ts';

export type Tier = 'managed' | 'user' | 'project' | 'local';

export interface TierSettings {
  tier: Tier;
  path: string | undefined;
  settings: JsonObject;
}

export interface RuleContext {
  /** H */
  home: string;
  /** P: real path of the project root */
  projectRoot: string;
  /** C */
  configDir: string;
  /** T: real path of Claude Code's temp root */
  tempRoot: string;
}

export type ListName = 'allowWrite' | 'denyWrite' | 'denyRead' | 'allowRead' | 'allowedDomains' | 'deniedDomains' | 'unsetEnv';

export interface TraceEntry {
  list: ListName;
  value: string;
  reason: string;
}

export interface BuildResult {
  config: SandboxRuntimeConfig;
  unsetEnv: string[];
  trace: TraceEntry[];
  warnings: string[];
}

export const MANAGED_SETTINGS_LOCATIONS = [
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  '/Library/Application Support/ClaudeCode/managed-settings.d',
];

const KNOWN_SANDBOX_KEYS: Record<string, readonly string[] | 'leaf'> = {
  enabled: 'leaf',
  failIfUnavailable: 'leaf',
  autoAllowBashIfSandboxed: 'leaf',
  allowUnsandboxedCommands: 'leaf',
  excludedCommands: 'leaf',
  ignoreViolations: 'leaf',
  enableWeakerNestedSandbox: 'leaf',
  enableWeakerNetworkIsolation: 'leaf',
  allowAppleEvents: 'leaf',
  bwrapPath: 'leaf',
  socatPath: 'leaf',
  ripgrep: 'leaf',
  filesystem: ['allowWrite', 'denyWrite', 'denyRead', 'allowRead', 'allowManagedReadPathsOnly', 'disabled'],
  network: [
    'allowedDomains',
    'deniedDomains',
    'deniedDomainReasons',
    'allowManagedDomainsOnly',
    'strictAllowlist',
    'allowUnixSockets',
    'allowAllUnixSockets',
    'allowLocalBinding',
    'allowMachLookup',
    'httpProxyPort',
    'socksProxyPort',
    'tlsTerminate',
  ],
  credentials: ['files', 'envVars', 'awsPairs', 'sigv4', 'allowPlaintextInject'],
};

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function label(t: TierSettings): string {
  return t.path ? `${t.tier} (${t.path})` : t.tier;
}

export function validateSettings(tiers: TierSettings[]): void {
  for (const t of tiers) {
    const sandbox = t.settings['sandbox'];
    if (sandbox !== undefined && !isObject(sandbox)) throw new RefuseError(`${label(t)}: sandbox is not an object`);
    for (const [key, value] of Object.entries(sandbox ?? {})) {
      const known = KNOWN_SANDBOX_KEYS[key];
      if (known === undefined) throw new RefuseError(`${label(t)}: unsupported setting sandbox.${key}`);
      if (known === 'leaf' || value === undefined) continue;
      if (!isObject(value)) throw new RefuseError(`${label(t)}: sandbox.${key} is not an object`);
      for (const sub of Object.keys(value)) {
        if (!known.includes(sub)) throw new RefuseError(`${label(t)}: unsupported setting sandbox.${key}.${sub}`);
      }
    }
    if (getObject(getObject(sandbox, 'network'), 'tlsTerminate') !== undefined) {
      throw new RefuseError(`${label(t)}: sandbox.network.tlsTerminate is not supported`);
    }
    if (getBoolean(t.settings['permissions'], 'blockReadsOutsideWorkingDirectories') === true) {
      throw new RefuseError(`${label(t)}: permissions.blockReadsOutsideWorkingDirectories is not supported`);
    }
  }
}

class Lists {
  private readonly lists = new Map<ListName, Map<string, string>>();
  readonly warnings: string[] = [];

  add(list: ListName, value: string, reason: string): void {
    let m = this.lists.get(list);
    if (!m) {
      m = new Map();
      this.lists.set(list, m);
    }
    if (!m.has(value)) m.set(value, reason);
  }

  addPath(list: ListName, absPath: string, reason: string): void {
    for (const s of spellings(absPath)) this.add(list, s, reason);
  }

  values(list: ListName): string[] {
    return [...(this.lists.get(list)?.keys() ?? [])];
  }

  trace(): TraceEntry[] {
    const out: TraceEntry[] = [];
    for (const [list, m] of this.lists) for (const [value, reason] of m) out.push({ list, value, reason });
    return out;
  }
}

function ancestorsInclusive(p: string): string[] {
  const out = [p];
  for (let cur = p; path.dirname(cur) !== cur; ) {
    cur = path.dirname(cur);
    out.push(cur);
  }
  return out;
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** For a `.git` file (`gitdir: …`), the git dir it points to and that dir's common dir. */
function gitdirTargets(dotGit: string): string[] {
  let content: string;
  try {
    if (!fs.statSync(dotGit).isFile()) return [];
    content = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return [];
  }
  const m = /^gitdir:\s*(.+)$/m.exec(content);
  if (!m || m[1] === undefined) return [];
  const gitdir = path.resolve(path.dirname(dotGit), m[1].trim());
  const out = [gitdir];
  try {
    const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    if (common) out.push(path.resolve(gitdir, common));
  } catch {
    // not a linked worktree
  }
  return out;
}

export function buildConfig(ctx: RuleContext, tiers: TierSettings[], effective: JsonObject): BuildResult {
  validateSettings(tiers);
  const L = new Lists();
  const { home: H, projectRoot: P, configDir: C, tempRoot: T } = ctx;

  const managed = tiers.filter(t => t.tier === 'managed');
  const trusted = tiers.filter(t => t.tier === 'managed' || t.tier === 'user');
  const managedFlag = (section: string, sub: string | undefined, key: string): boolean =>
    managed.some(t => {
      const s = getObject(t.settings, section);
      return getBoolean(sub === undefined ? s : getObject(s, sub), key) === true;
    });
  const managedPermissionRulesOnly = managedFlag('permissions', undefined, 'allowManagedPermissionRulesOnly');
  const managedReadPathsOnly = managedFlag('sandbox', 'filesystem', 'allowManagedReadPathsOnly');
  const managedDomainsOnly = managedFlag('sandbox', 'network', 'allowManagedDomainsOnly');

  const base = (t: TierSettings): string => (t.tier === 'user' ? C : P);
  const permissions = (t: TierSettings): JsonObject | undefined => getObject(t.settings, 'permissions');
  const sandbox = (t: TierSettings): JsonObject | undefined => getObject(t.settings, 'sandbox');
  const fsSettings = (t: TierSettings): JsonObject | undefined => getObject(sandbox(t), 'filesystem');
  const netSettings = (t: TierSettings): JsonObject | undefined => getObject(sandbox(t), 'network');
  const rules = (t: TierSettings, kind: 'allow' | 'deny') =>
    getStrings(permissions(t), kind).flatMap(r => {
      const parsed = parseRule(r);
      return parsed ? [{ ...parsed, raw: r }] : [];
    });

  const resolveAllow = (list: ListName, reason: string, resolve: () => string): void => {
    try {
      L.addPath(list, resolve(), reason);
    } catch (e) {
      if (!(e instanceof PathResolveError)) throw e;
      L.warnings.push(`skipped ${reason}: ${e.message}`);
    }
  };
  const resolveDeny = (list: ListName, reason: string, resolve: () => string): void => {
    try {
      L.addPath(list, resolve(), reason);
    } catch (e) {
      if (e instanceof PathResolveError) throw new RefuseError(`cannot resolve ${reason}: ${e.message}`);
      throw e;
    }
  };

  // D
  const addedDirs: string[] = [];
  for (const t of tiers) {
    for (const d of getStrings(permissions(t), 'additionalDirectories')) {
      try {
        addedDirs.push(resolveAdditionalDirectory(d, P, H));
      } catch (e) {
        if (!(e instanceof PathResolveError)) throw e;
        L.warnings.push(`skipped additionalDirectories entry ${JSON.stringify(d)} from ${label(t)}: ${e.message}`);
      }
    }
  }
  const roots = [P, ...addedDirs];

  // 4.1 allowWrite
  L.addPath('allowWrite', P, 'project root');
  L.addPath('allowWrite', T, 'Claude Code temp root');
  for (const d of addedDirs) L.addPath('allowWrite', d, 'additional directory');
  for (const t of tiers) {
    if (managedPermissionRulesOnly && t.tier !== 'managed') continue;
    for (const r of rules(t, 'allow')) {
      if (r.tool !== 'Edit') continue;
      resolveAllow('allowWrite', `${r.raw} allow rule from ${label(t)}`, () =>
        resolvePermissionRulePath(r.content, base(t), P, H),
      );
    }
  }
  for (const t of tiers) {
    for (const p of getStrings(fsSettings(t), 'allowWrite')) {
      resolveAllow('allowWrite', `sandbox.filesystem.allowWrite ${JSON.stringify(p)} from ${label(t)}`, () =>
        resolveSandboxPath(p, base(t), H),
      );
    }
  }

  // 4.2 denyWrite
  L.addPath('denyWrite', C, 'Claude Code config dir');
  L.addPath('denyWrite', path.join(H, '.claude*'), 'Claude Code files in home');
  for (const t of tiers) if (t.path) L.addPath('denyWrite', t.path, `settings file (${t.tier})`);
  for (const p of MANAGED_SETTINGS_LOCATIONS) L.addPath('denyWrite', p, 'managed settings');
  for (const a of ancestorsInclusive(P)) {
    L.addPath('denyWrite', path.join(a, '.claude'), 'project-level Claude files');
    L.addPath('denyWrite', path.join(a, '.mcp.json'), 'project-level Claude files');
  }
  for (const r of roots) {
    L.addPath('denyWrite', path.join(r, '**', '.claude'), 'project-level Claude files');
    L.addPath('denyWrite', path.join(r, '**', '.mcp.json'), 'project-level Claude files');
    L.addPath('denyWrite', path.join(r, '**', '.git'), 'git metadata');
    for (const name of ['HEAD', 'objects', 'refs']) L.addPath('denyWrite', path.join(r, name), 'bare repository planting');
    for (const name of ['config', 'hooks']) {
      const p = path.join(r, name);
      if (!isDirectory(p)) L.addPath('denyWrite', p, 'bare repository planting');
    }
  }
  const gitTargets: string[] = [...gitdirTargets(path.join(P, '.git'))];
  for (const a of ancestorsInclusive(P).slice(1)) {
    const dotGit = path.join(a, '.git');
    if (lstatOrUndefined(dotGit) === undefined) continue;
    gitTargets.push(dotGit, ...gitdirTargets(dotGit));
    break;
  }
  for (const g of gitTargets) L.addPath('denyWrite', g, 'git metadata of the enclosing repository');
  L.addPath('denyWrite', path.join(T, 'bash-edit-diff'), 'Claude Code runtime file');
  L.addPath('denyWrite', path.join(T, '*', '*', 'tasks'), 'Claude Code background task output');
  for (const t of tiers) {
    for (const r of rules(t, 'deny')) {
      if (!WRITE_TOOLS.has(r.tool)) continue;
      resolveDeny('denyWrite', `${r.raw} deny rule from ${label(t)}`, () =>
        resolvePermissionRulePath(r.content, base(t), P, H),
      );
    }
    for (const p of getStrings(fsSettings(t), 'denyWrite')) {
      resolveDeny('denyWrite', `sandbox.filesystem.denyWrite ${JSON.stringify(p)} from ${label(t)}`, () =>
        resolveSandboxPath(p, base(t), H),
      );
    }
  }

  // 4.3 denyRead
  for (const t of tiers) {
    for (const r of rules(t, 'deny')) {
      if (r.tool !== 'Read') continue;
      resolveDeny('denyRead', `${r.raw} deny rule from ${label(t)}`, () =>
        resolvePermissionRulePath(r.content, base(t), P, H),
      );
    }
    for (const p of getStrings(fsSettings(t), 'denyRead')) {
      resolveDeny('denyRead', `sandbox.filesystem.denyRead ${JSON.stringify(p)} from ${label(t)}`, () =>
        resolveSandboxPath(p, base(t), H),
      );
    }
    for (const f of getObjects(getObject(sandbox(t), 'credentials'), 'files')) {
      const p = f['path'];
      if (typeof p !== 'string') throw new RefuseError(`${label(t)}: sandbox.credentials.files entry without path`);
      resolveDeny('denyRead', `sandbox.credentials.files ${JSON.stringify(p)} from ${label(t)}`, () =>
        resolveSandboxPath(p, base(t), H),
      );
    }
  }
  L.addPath('denyRead', path.join(T, 'bash-edit-diff'), 'Claude Code runtime file');
  L.addPath('denyRead', path.join(C, 'ide'), 'Claude Code runtime file');
  L.addPath('denyRead', path.join(C, 'bridge-spawn'), 'Claude Code runtime file');

  // 4.4 allowRead
  for (const t of managedReadPathsOnly ? managed : trusted) {
    for (const p of getStrings(fsSettings(t), 'allowRead')) {
      resolveAllow('allowRead', `sandbox.filesystem.allowRead ${JSON.stringify(p)} from ${label(t)}`, () =>
        resolveSandboxPath(p, base(t), H),
      );
    }
  }
  for (const t of tiers) {
    if (t.tier !== 'project' && t.tier !== 'local') continue;
    if (getStrings(fsSettings(t), 'allowRead').length > 0) {
      L.warnings.push(`ignored sandbox.filesystem.allowRead from ${label(t)} (repository tiers cannot re-open reads)`);
    }
  }

  // 5. network
  const deniedDomainReasons: Record<string, string> = {};
  for (const t of managedDomainsOnly ? managed : tiers) {
    for (const d of getStrings(netSettings(t), 'allowedDomains')) {
      L.add('allowedDomains', d, `sandbox.network.allowedDomains from ${label(t)}`);
    }
    if (managedPermissionRulesOnly && t.tier !== 'managed') continue;
    for (const r of rules(t, 'allow')) {
      if (r.tool === 'WebFetch' && r.content.startsWith('domain:')) {
        L.add('allowedDomains', r.content.slice('domain:'.length), `${r.raw} allow rule from ${label(t)}`);
      }
    }
  }
  for (const t of tiers) {
    for (const d of getStrings(netSettings(t), 'deniedDomains')) {
      L.add('deniedDomains', d, `sandbox.network.deniedDomains from ${label(t)}`);
    }
    for (const r of rules(t, 'deny')) {
      if (r.tool === 'WebFetch' && r.content.startsWith('domain:')) {
        L.add('deniedDomains', r.content.slice('domain:'.length), `${r.raw} deny rule from ${label(t)}`);
      }
    }
    const reasons = getObject(netSettings(t), 'deniedDomainReasons');
    for (const [k, v] of Object.entries(reasons ?? {})) if (typeof v === 'string') deniedDomainReasons[k] = v;
  }

  // 6. environment
  for (const t of tiers) {
    for (const v of getObjects(getObject(sandbox(t), 'credentials'), 'envVars')) {
      const name = v['name'];
      if (typeof name !== 'string') throw new RefuseError(`${label(t)}: sandbox.credentials.envVars entry without name`);
      L.add('unsetEnv', name, `sandbox.credentials.envVars from ${label(t)}`);
    }
  }

  const effSandbox = getObject(effective, 'sandbox');
  const effNet = getObject(effSandbox, 'network');
  const network: SandboxRuntimeConfig['network'] = {
    allowedDomains: L.values('allowedDomains'),
    deniedDomains: L.values('deniedDomains'),
  };
  if (Object.keys(deniedDomainReasons).length > 0) network.deniedDomainReasons = deniedDomainReasons;
  const unixSockets = getStrings(effNet, 'allowUnixSockets');
  if (unixSockets.length > 0) network.allowUnixSockets = unixSockets;
  const machLookup = getStrings(effNet, 'allowMachLookup');
  if (machLookup.length > 0) network.allowMachLookup = machLookup;
  const allowAllUnixSockets = getBoolean(effNet, 'allowAllUnixSockets');
  if (allowAllUnixSockets !== undefined) network.allowAllUnixSockets = allowAllUnixSockets;
  const allowLocalBinding = getBoolean(effNet, 'allowLocalBinding');
  if (allowLocalBinding !== undefined) network.allowLocalBinding = allowLocalBinding;
  const httpProxyPort = getNumber(effNet, 'httpProxyPort');
  if (httpProxyPort !== undefined) network.httpProxyPort = httpProxyPort;
  const socksProxyPort = getNumber(effNet, 'socksProxyPort');
  if (socksProxyPort !== undefined) network.socksProxyPort = socksProxyPort;

  const config: SandboxRuntimeConfig = {
    network,
    filesystem: {
      denyRead: L.values('denyRead'),
      allowRead: L.values('allowRead'),
      allowWrite: L.values('allowWrite'),
      denyWrite: L.values('denyWrite'),
    },
  };
  const weakerNetworkIsolation = getBoolean(effSandbox, 'enableWeakerNetworkIsolation');
  if (weakerNetworkIsolation !== undefined) config.enableWeakerNetworkIsolation = weakerNetworkIsolation;
  return { config, unsetEnv: L.values('unsetEnv'), trace: L.trace(), warnings: L.warnings };
}
