import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { RefuseError } from '../src/errors.ts';
import { buildConfig, type RuleContext, type TierSettings } from '../src/rules.ts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-run-rules-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const H = path.join(tmp, 'home');
const P = path.join(H, 'proj');
fs.mkdirSync(path.join(P, 'config'), { recursive: true });
fs.mkdirSync(path.join(H, '.claude'), { recursive: true });

const ctx: RuleContext = { home: H, projectRoot: P, configDir: path.join(H, '.claude'), tempRoot: path.join(tmp, 'claude-tmp') };

function tier(t: TierSettings['tier'], settings: TierSettings['settings']): TierSettings {
  const file = { managed: undefined, user: path.join(H, '.claude/settings.json'), project: path.join(P, '.claude/settings.json'), local: path.join(P, '.claude/settings.local.json') }[t];
  return { tier: t, path: file, settings };
}

function build(tiers: TierSettings[], effective: TierSettings['settings'] = {}) {
  return buildConfig(ctx, tiers, effective);
}

describe('buildConfig filesystem', () => {
  const r = build([
    tier('user', {
      permissions: {
        allow: ['Edit(~/.cache/**)', 'Edit(/notes)', 'Read(~/anything)', 'WebFetch(domain:pypi.org)'],
        deny: ['Read(~/.ssh/**)', 'Write(./generated/**)'],
        additionalDirectories: ['../data'],
      },
      sandbox: { filesystem: { allowRead: ['~/.ssh/known_hosts'], denyRead: ['~/.aws'] } },
    }),
    tier('project', {
      permissions: { allow: ['Edit(/build/**)'] },
      sandbox: {
        filesystem: { allowWrite: ['out'], allowRead: ['~/.aws/config'] },
        credentials: { files: [{ path: '~/.netrc', mode: 'mask' }], envVars: [{ name: 'HF_TOKEN', mode: 'mask' }] },
      },
    }),
  ]);
  const fsc = r.config.filesystem;
  assert.ok(fsc);

  it('allows writes to P, T, D and allow rules', () => {
    for (const p of [P, ctx.tempRoot, path.join(H, 'data'), path.join(H, '.cache/**'), path.join(H, '.claude/notes'), path.join(P, 'build/**'), path.join(P, 'out')]) {
      assert.ok(fsc.allowWrite.includes(p), p);
    }
  });

  it('protects Claude Code files and git metadata', () => {
    for (const p of [
      path.join(H, '.claude'),
      path.join(H, '.claude*'),
      path.join(P, '.claude'),
      path.join(H, '.claude'),
      path.join(P, '**/.claude'),
      path.join(P, '**/.mcp.json'),
      path.join(P, '**/.git'),
      path.join(H, 'data', '**/.git'),
      path.join(P, 'HEAD'),
      path.join(P, 'hooks'),
      path.join(ctx.tempRoot, 'bash-edit-diff'),
      path.join(ctx.tempRoot, '*/*/tasks'),
      path.join(P, 'generated/**'),
      '/.mcp.json',
    ]) {
      assert.ok(fsc.denyWrite.includes(p), p);
    }
    assert.ok(!fsc.denyWrite.includes(path.join(P, 'config')), 'existing config dir stays writable');
  });

  it('denies reads from rules, settings and credentials', () => {
    for (const p of [path.join(H, '.ssh/**'), path.join(H, '.aws'), path.join(H, '.netrc'), path.join(H, '.claude/ide')]) {
      assert.ok(fsc.denyRead.includes(p), p);
    }
  });

  it('re-opens reads only from trusted tiers', () => {
    assert.deepEqual(fsc.allowRead, [path.join(H, '.ssh/known_hosts')]);
    assert.ok(r.warnings.some(w => w.includes('allowRead')));
  });

  it('collects domains and env vars', () => {
    assert.deepEqual(r.config.network.allowedDomains, ['pypi.org']);
    assert.deepEqual(r.unsetEnv, ['HF_TOKEN']);
  });

  it('explains every entry', () => {
    const t = r.trace.find(e => e.list === 'allowWrite' && e.value === path.join(P, 'build/**'));
    assert.match(t?.reason ?? '', /Edit\(\/build\/\*\*\) allow rule from project/);
  });
});

describe('buildConfig enclosing repository', () => {
  it('denies the .git of a repository above P', () => {
    const repo = path.join(tmp, 'repo');
    const sub = path.join(repo, 'pkg');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    const r = buildConfig({ ...ctx, projectRoot: sub }, [], {});
    assert.ok(r.config.filesystem?.denyWrite.includes(path.join(repo, '.git')));
  });

  it('follows a gitdir file to the main repository', () => {
    const main = path.join(tmp, 'main');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    const r = buildConfig({ ...ctx, projectRoot: wt }, [], {});
    const deny = r.config.filesystem?.denyWrite ?? [];
    assert.ok(deny.includes(path.join(main, '.git', 'worktrees', 'wt')));
    assert.ok(deny.includes(path.join(main, '.git')));
  });
});

describe('buildConfig network and locks', () => {
  it('passes merged network settings through', () => {
    const r = build([], { sandbox: { network: { allowLocalBinding: true, allowMachLookup: ['com.apple.trustd.agent'], httpProxyPort: 8080 }, enableWeakerNetworkIsolation: true } });
    assert.equal(r.config.network.allowLocalBinding, true);
    assert.deepEqual(r.config.network.allowMachLookup, ['com.apple.trustd.agent']);
    assert.equal(r.config.network.httpProxyPort, 8080);
    assert.equal(r.config.enableWeakerNetworkIsolation, true);
    assert.equal(r.config.allowAppleEvents, undefined);
  });

  it('honors managed-only locks', () => {
    const r = build([
      tier('managed', {
        permissions: { allowManagedPermissionRulesOnly: true },
        sandbox: { network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] }, filesystem: { allowManagedReadPathsOnly: true } },
      }),
      tier('user', { permissions: { allow: ['Edit(~/x)', 'WebFetch(domain:pypi.org)'] }, sandbox: { network: { allowedDomains: ['evil.example'] }, filesystem: { allowRead: ['~/y'] } } }),
    ]);
    assert.deepEqual(r.config.network.allowedDomains, ['corp.example']);
    assert.ok(!r.config.filesystem?.allowWrite.includes(path.join(H, 'x')));
    assert.deepEqual(r.config.filesystem?.allowRead, []);
  });
});

describe('buildConfig refusals', () => {
  const refuses = (settings: TierSettings['settings']) => assert.throws(() => build([tier('project', settings)]), RefuseError);

  it('refuses unknown or unsupported settings', () => {
    refuses({ sandbox: { somethingNew: true } });
    refuses({ sandbox: { network: { requestRules: [] } } });
    refuses({ sandbox: { network: { tlsTerminate: {} } } });
    refuses({ permissions: { blockReadsOutsideWorkingDirectories: true } });
  });

  it('refuses deny entries it cannot resolve, skips such allow entries', () => {
    refuses({ permissions: { deny: ['Read(~other/secret)'] } });
    const r = build([tier('project', { permissions: { allow: ['Edit(~other/x)'] } })]);
    assert.ok(r.warnings.some(w => w.includes('~other')));
  });
});
