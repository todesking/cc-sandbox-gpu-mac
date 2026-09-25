import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { RefuseError } from '../src/errors.ts';
import { checkInstallNotWritable, globToRegExp, writableVia } from '../src/selfcheck.ts';

describe('globToRegExp', () => {
  it('follows srt deny-glob semantics', () => {
    const git = globToRegExp('/p/**/.git');
    assert.ok(git.test('/p/.git'));
    assert.ok(git.test('/p/a/b/.git/config'));
    assert.ok(!git.test('/p/.gitignore'));
    const star = globToRegExp('/h/.claude*');
    assert.ok(star.test('/h/.claude.json'));
    assert.ok(star.test('/h/.claude/settings.json'));
    assert.ok(!star.test('/h/x/.claude'));
  });
});

describe('writableVia', () => {
  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: ['/Users/u/proj', '/Users/u/.cache/**'], denyWrite: ['/Users/u/proj/**/.git'] },
  };

  it('reports the allowWrite entry that grants access', () => {
    assert.equal(writableVia(config, '/Users/u/proj/dist/cli.js'), '/Users/u/proj');
    assert.equal(writableVia(config, '/Users/u/.cache/x'), '/Users/u/.cache/**');
    assert.equal(writableVia(config, '/Users/u/proj/.git/hooks/pre-commit'), undefined);
    assert.equal(writableVia(config, '/Users/u/.local/bin/cc-gpu-run'), undefined);
  });

  it('refuses writable install paths', () => {
    assert.throws(() => checkInstallNotWritable(config, ['/Users/u/proj/dist']), RefuseError);
    checkInstallNotWritable(config, ['/Users/u/.local/share/cc-sandbox-gpu-mac']);
  });
});
