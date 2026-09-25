import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PathResolveError,
  parseRule,
  resolveAdditionalDirectory,
  resolvePermissionRulePath,
  resolveSandboxPath,
  spellings,
} from '../src/paths.ts';

const H = '/Users/u';
const P = '/Users/u/proj';
const C = '/Users/u/.claude';

describe('resolvePermissionRulePath', () => {
  it('follows permission rule spellings', () => {
    assert.equal(resolvePermissionRulePath('//etc/x', P, P, H), '/etc/x');
    assert.equal(resolvePermissionRulePath('/build/**', P, P, H), '/Users/u/proj/build/**');
    assert.equal(resolvePermissionRulePath('/notes', C, P, H), '/Users/u/.claude/notes');
    assert.equal(resolvePermissionRulePath('~/.cache/**', C, P, H), '/Users/u/.cache/**');
    assert.equal(resolvePermissionRulePath('./secrets/**', C, P, H), '/Users/u/proj/secrets/**');
    assert.equal(resolvePermissionRulePath('**/.env', C, P, H), '/Users/u/proj/**/.env');
    assert.equal(resolvePermissionRulePath('~', C, P, H), H);
  });

  it('rejects what it cannot resolve', () => {
    assert.throws(() => resolvePermissionRulePath('~other/x', P, P, H), PathResolveError);
    assert.throws(() => resolvePermissionRulePath('', P, P, H), PathResolveError);
  });
});

describe('resolveSandboxPath', () => {
  it('treats /x as absolute and x as relative to the base', () => {
    assert.equal(resolveSandboxPath('/tmp/build', C, H), '/tmp/build');
    assert.equal(resolveSandboxPath('//tmp/build', C, H), '/tmp/build');
    assert.equal(resolveSandboxPath('./cache', C, H), '/Users/u/.claude/cache');
    assert.equal(resolveSandboxPath('cache', P, H), '/Users/u/proj/cache');
    assert.equal(resolveSandboxPath('~/.aws', P, H), '/Users/u/.aws');
    assert.equal(resolveSandboxPath('/data/', P, H), '/data');
  });
});

describe('resolveAdditionalDirectory', () => {
  it('drops trailing globs and resolves against the project root', () => {
    assert.equal(resolveAdditionalDirectory('../data/**', P, H), '/Users/u/data');
    assert.equal(resolveAdditionalDirectory('~/datasets/', P, H), '/Users/u/datasets');
    assert.equal(resolveAdditionalDirectory('/', P, H), '/');
    assert.throws(() => resolveAdditionalDirectory('/data/*/x', P, H), PathResolveError);
  });
});

describe('parseRule', () => {
  it('parses Tool(content) and unescapes parentheses', () => {
    assert.deepEqual(parseRule('Edit(~/.cache/**)'), { tool: 'Edit', content: '~/.cache/**' });
    assert.deepEqual(parseRule('Read(a\\(1\\).txt)'), { tool: 'Read', content: 'a(1).txt' });
    assert.deepEqual(parseRule('WebFetch(domain:pypi.org)'), { tool: 'WebFetch', content: 'domain:pypi.org' });
    assert.equal(parseRule('Edit'), undefined);
    assert.equal(parseRule('Edit()'), undefined);
  });
});

describe('spellings', () => {
  it('adds the real path when a symlink is involved', () => {
    assert.deepEqual(spellings('/tmp/does-not-exist/x'), ['/tmp/does-not-exist/x', '/private/tmp/does-not-exist/x']);
    assert.deepEqual(spellings('/tmp/**/.git'), ['/tmp/**/.git', '/private/tmp/**/.git']);
    assert.deepEqual(spellings('/usr/bin'), ['/usr/bin']);
  });
});
