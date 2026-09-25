// Install gpu-run outside every sandbox-writable location. Run outside Claude Code's sandbox:
//   npm run install-local [-- --prefix ~/.local]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const prefixValue = args[args.indexOf('--prefix') + 1];
const prefix = path.resolve(
  args.includes('--prefix') && prefixValue !== undefined
    ? prefixValue.replace(/^~(?=\/|$)/, os.homedir())
    : path.join(os.homedir(), '.local'),
);
const libDir = path.join(prefix, 'share', 'cc-sandbox-gpu-mac');
const binDir = path.join(prefix, 'bin');
const launcher = path.join(binDir, 'gpu-run');
const node = fs.realpathSync(process.execPath);
const cli = path.join(libDir, 'dist', 'cli.js');

function sh(file: string, argv: string[], cwd: string = repo): void {
  execFileSync(file, argv, { cwd, stdio: 'inherit' });
}

for (const p of [node, cli, launcher]) {
  if (/["\\\n]/.test(p)) throw new Error(`unsupported character in path: ${p}`);
}
if (!fs.existsSync(path.join(repo, 'dist', 'cli.js'))) throw new Error('run `npm run build` first');

fs.rmSync(libDir, { recursive: true, force: true });
fs.mkdirSync(libDir, { recursive: true });
fs.cpSync(path.join(repo, 'dist'), path.join(libDir, 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json', '.npmrc']) fs.copyFileSync(path.join(repo, f), path.join(libDir, f));
sh('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], libDir);

fs.mkdirSync(binDir, { recursive: true });
const tmp = `${launcher}.tmp-${process.pid}`;
sh('/usr/bin/cc', [
  '-O2',
  '-Wall',
  '-Werror',
  `-DGPU_RUN_NODE="${node}"`,
  `-DGPU_RUN_CLI="${cli}"`,
  `-DGPU_RUN_SELF="${launcher}"`,
  '-o',
  tmp,
  path.join(repo, 'launcher', 'gpu-run.c'),
]);
sh('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', tmp]);
fs.renameSync(tmp, launcher);

console.log(`
installed:
  launcher  ${launcher}
  package   ${libDir}
  node      ${node}

Add to ~/.claude/settings.json (absolute path, so PATH cannot redirect it):
  "sandbox": { "excludedCommands": ["${launcher} *"] }

Reinstall after upgrading node, since its path is baked into the launcher.`);
