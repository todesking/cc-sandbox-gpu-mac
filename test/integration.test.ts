import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { decodeEnv } from '../src/env.ts';
import { GPU_RULES, parseWrapped, patchProfile } from '../src/profile.ts';
import { buildConfig } from '../src/rules.ts';
import { shellQuote } from '../src/run.ts';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-run-it-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('srt integration', () => {
  it('produces a profile gpu-run can take apart and patch', async () => {
    const P = path.join(tmp, 'proj');
    fs.mkdirSync(P, { recursive: true });
    const ctx = { home: tmp, projectRoot: P, configDir: path.join(tmp, '.claude'), tempRoot: path.join(tmp, 'claude-tmp') };
    // Fixed proxy ports keep srt from starting proxies (listening is not allowed inside Claude Code's sandbox).
    const { config } = buildConfig(ctx, [], { sandbox: { network: { httpProxyPort: 1, socksProxyPort: 1 } } });
    const cwd = process.cwd();
    process.chdir(P);
    try {
      await SandboxManager.initialize(config, undefined, false);
      const command = `cd ${shellQuote("/x y/it's")} && python -c 'print("(allow)")'`;
      const inv = parseWrapped(await SandboxManager.wrapWithSandbox(command, '/bin/bash'));
      assert.deepEqual(inv.command, ['/bin/bash', '-c', command]);
      assert.equal(inv.env['HTTP_PROXY'], 'http://localhost:1');
      const profile = patchProfile(inv.profile);
      assert.ok(profile.includes(GPU_RULES));
      assert.ok(profile.includes(`(subpath "${path.join(P, 'HEAD')}")`));
      assert.ok(profile.includes('iokit-user-client-class "AGXDeviceUserClient"'));
    } finally {
      await SandboxManager.reset();
      process.chdir(cwd);
    }
  });
});

describe('launcher', () => {
  const bin = path.join(tmp, 'gpu-run');
  const cli = path.join(tmp, 'dump.mjs');
  fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n');
  const node = fs.realpathSync(process.execPath);
  execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Werror', `-DGPU_RUN_NODE="${node}"`, `-DGPU_RUN_CLI="${cli}"`, `-DGPU_RUN_SELF="${bin}"`, '-o', bin, path.join(repo, 'launcher/gpu-run.c')]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', bin], { stdio: 'ignore' });

  const evil = path.join(tmp, 'evil.dylib');
  const evilSrc = path.join(tmp, 'evil.c');
  fs.writeFileSync(evilSrc, '#include <stdio.h>\n__attribute__((constructor)) static void f(void) { fputs("PWNED", stderr); }\n');
  execFileSync('/usr/bin/cc', ['-dynamiclib', '-o', evil, evilSrc]);

  it('starts node with a fixed environment and hands the original one over as data', () => {
    const r = spawnSync(bin, ['python', 'a b', ''], {
      encoding: 'utf8',
      env: { PATH: '/tmp/evil:/usr/bin', NODE_OPTIONS: '--require /nonexistent.js', DYLD_INSERT_LIBRARIES: evil, FOO: 'x y\nz=1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes('PWNED'));
    const out: { argv: string[]; env: Record<string, string> } = JSON.parse(r.stdout);
    assert.deepEqual(out.argv, ['python', 'a b', '']);
    // macOS adds __CF_USER_TEXT_ENCODING to every process.
    const keys = Object.keys(out.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort();
    assert.deepEqual(keys, ['GPU_RUN_ENV', 'GPU_RUN_LAUNCHER', 'HOME', 'LANG', 'PATH']);
    assert.equal(out.env['PATH'], '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(out.env['HOME'], os.userInfo().homedir);
    assert.equal(out.env['GPU_RUN_LAUNCHER'], bin);
    const original = decodeEnv(out.env['GPU_RUN_ENV'] ?? '');
    assert.equal(original['FOO'], 'x y\nz=1');
    assert.equal(original['NODE_OPTIONS'], '--require /nonexistent.js');
    assert.equal(original['PATH'], '/tmp/evil:/usr/bin');
  });
});
