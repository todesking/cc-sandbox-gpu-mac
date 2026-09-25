import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RefuseError } from '../src/errors.ts';
import { GPU_ANCHOR, GPU_RULES, allowedOperations, parseWrapped, patchProfile, splitQuoted } from '../src/profile.ts';
import { shellQuote } from '../src/run.ts';

describe('splitQuoted', () => {
  it('inverts shellQuote', () => {
    const samples = [
      ['env', 'A=1', 'B=two words', "C=it's", '', '=x', "'", "''", 'a\nb', '(allow file-read*)', '$HOME `id` !x'],
      ['/usr/bin/sandbox-exec', '-p', '(version 1)\n(deny default (with message "t"))', '/bin/bash', '-c', "cd '/x y' && python -c 'print(1)'"],
    ];
    for (const words of samples) assert.deepEqual(splitQuoted(words.map(shellQuote).join(' ')), words);
  });

  it('rejects anything shellQuote does not produce', () => {
    for (const bad of ['a  b', 'a"b', 'a\\b', "'open", 'a$b', ' a']) {
      assert.throws(() => splitQuoted(bad), RefuseError, bad);
    }
  });
});

describe('parseWrapped', () => {
  it('takes apart an srt command line', () => {
    const line = ['env', '-u', 'SECRET', 'HTTP_PROXY=http://localhost:1', '/usr/bin/sandbox-exec', '-p', '(version 1)', '/bin/bash', '-c', 'echo hi']
      .map(shellQuote)
      .join(' ');
    assert.deepEqual(parseWrapped(line), {
      env: { HTTP_PROXY: 'http://localhost:1' },
      unset: ['SECRET'],
      profile: '(version 1)',
      command: ['/bin/bash', '-c', 'echo hi'],
    });
  });

  it('refuses other shapes', () => {
    assert.throws(() => parseWrapped('echo hi'), RefuseError);
    assert.throws(() => parseWrapped('env A=1 /usr/bin/true'), RefuseError);
    assert.throws(() => parseWrapped('env A=1 /usr/bin/sandbox-exec -f x /bin/bash'), RefuseError);
  });
});

describe('patchProfile', () => {
  it('inserts the GPU rules after the anchor', () => {
    const out = patchProfile(`(version 1)\n${GPU_ANCHOR}\n(allow file-read*)`);
    assert.ok(out.includes(`${GPU_ANCHOR}\n\n${GPU_RULES}\n\n(allow file-read*)`));
  });

  it('refuses when the anchor is missing or repeated', () => {
    assert.throws(() => patchProfile('(version 1)'), RefuseError);
    assert.throws(() => patchProfile(`${GPU_ANCHOR}\n${GPU_ANCHOR}`), RefuseError);
  });

  it('only lets GPU rules allow iokit-open, mach-lookup and sysctl-read', () => {
    assert.deepEqual(allowedOperations(GPU_RULES), ['iokit-open', 'mach-lookup']);
    assert.throws(() => patchProfile(GPU_ANCHOR, '(allow file-write* (subpath "/"))'), RefuseError);
    assert.throws(() => patchProfile(GPU_ANCHOR, '(deny mach-lookup)'), RefuseError);
  });
});
