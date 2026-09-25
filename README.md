# cc-sandbox-gpu-mac

Run GPU (Metal / MPS) workloads from Claude Code's sandboxed Bash tool on macOS.

Claude Code sandboxes Bash commands with Seatbelt (`sandbox-exec`) through
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) (srt).
The generated profile does not allow the IOKit user client that Metal needs
(`AGXDeviceUserClient`), so PyTorch MPS, MLX and friends see no GPU.
This cannot be fixed from inside the sandbox:

- Seatbelt sandboxes cannot be nested (`sandbox_apply: Operation not permitted`).
- Claude Code runs `/usr/bin/sandbox-exec` by absolute path, so a `sandbox-exec` shim on `PATH` is never used.
- srt has no setting for extra IOKit classes ([sandbox-runtime#560](https://github.com/anthropics/sandbox-runtime/issues/560)).

`gpu-run` is started by Claude Code **outside** its sandbox (via `sandbox.excludedCommands`).
It rebuilds a sandbox from the Claude Code settings that is at least as strict as
Claude Code's own, adds GPU access only, and runs the command inside it.

```
Claude Code ── Bash: ~/.local/bin/gpu-run python train.py
                 │
                 ▼  launcher (hardened binary, outside Claude Code's sandbox)
               gpu-run (node, clean environment)
                                                  1. find the parent Claude Code process
                                                  2. read settings (claude-agent-sdk resolveSettings)
                                                  3. build an srt config            (§ Rule generation)
                                                  4. srt: start proxies, generate the Seatbelt profile
                                                  5. patch in the GPU rules         (§ 8)
                                                  6. sandbox-exec … python train.py
```

> **Status:** working on an Apple M4 with Claude Code 2.1.282: Metal, MLX and PyTorch MPS
> training run from Claude Code's Bash tool, with writes, reads and network confined as specified.

## Install

Requirements: macOS on Apple Silicon, Node.js ≥ 22.18, Xcode Command Line Tools (`cc`, `codesign`),
and Claude Code from the native installer (`~/.local/share/claude/versions/`).

Run **outside** Claude Code's sandbox (a normal terminal):

```sh
npm install
npm run install-local            # or: npm run install-local -- --prefix /some/prefix
```

This copies the package to `~/.local/share/cc-sandbox-gpu-mac`, and compiles and
ad-hoc signs the launcher as `~/.local/bin/gpu-run` with the absolute paths of `node`
and the package baked in. Reinstall after upgrading Node.js.

Then add the launcher, **by absolute path**, to the excluded commands in your user
settings (`~/.claude/settings.json`):

```json
{
  "sandbox": {
    "excludedCommands": ["/Users/you/.local/bin/gpu-run *"]
  }
}
```

and tell Claude to call it by that path (e.g. in `CLAUDE.md`):

```sh
/Users/you/.local/bin/gpu-run python train.py --device mps
/Users/you/.local/bin/gpu-run --explain python train.py   # print config, reasons and profile; run nothing
```

Excluded commands still go through the normal permission flow (prompt or auto mode).
An allow rule such as `Bash(/Users/you/.local/bin/gpu-run *)` removes the prompt; because
the inner command is sandboxed by `gpu-run`, this is comparable to `sandbox.autoAllowBashIfSandboxed`.

Exit status: the command's own status, or 125 when `gpu-run` refuses or fails.

## Security model

**Invariant.** The sandbox built by `gpu-run` is never less restrictive than the one
Claude Code applies to Bash commands in the same session, except for the rules in § 8.
Where Claude Code's behavior cannot be reproduced exactly, `gpu-run` is stricter or refuses to run.

**Untrusted inputs.** The model chooses `gpu-run`'s arguments, working directory and
environment. None of them may widen the sandbox:

- `cd ~/other-repo && gpu-run …` must not make another repository writable,
  so the project root comes from the Claude Code process, not from `gpu-run`'s cwd.
- `HOME=/tmp/x gpu-run …` must not load an attacker-written `settings.json`,
  so `$HOME`, `$CLAUDE_CONFIG_DIR`, `$TMPDIR`, … of `gpu-run` itself are ignored.

**Code that runs outside any sandbox.** Everything between Claude Code and
`sandbox-exec` is hardened against the caller's environment:

- `node` honors `NODE_OPTIONS` and (with its entitlements) `DYLD_INSERT_LIBRARIES`;
  `/bin/sh` runs code from `SHELLOPTS=xtrace PS4='$(…)'`. So the entry point is a small C
  launcher signed with the hardened runtime, which makes dyld ignore `DYLD_*`. It starts
  `node --disable-sigusr1` by absolute path with only `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
  `LANG`, `HOME` (from the user database) and the original environment as opaque data
  (`GPU_RUN_ENV`, base64 of NUL-separated entries).
- The excluded command is registered by absolute path, so `PATH` cannot redirect it.
- `gpu-run` spawns `/usr/bin/sandbox-exec` directly; no shell runs outside the sandbox.
  External tools (`ps`, `lsof`) are called by absolute path with a fixed environment.
- The launcher, the installed package and `node` must not be writable from the sandbox,
  or a sandboxed command could replace them. `gpu-run` checks this against the config it
  builds and refuses otherwise; do not install into a directory Claude Code lets commands write.

**Trusted inputs.**

- Settings files. Claude Code's sandbox does not let commands write them.
- The Claude Code process: its working directory, argv and launch environment.
  It is found by walking up the process tree, which a sandboxed command cannot forge.
- The OS user database (uid, home directory).

**Refusal.** `gpu-run` exits with an error and runs nothing when:

- no Claude Code ancestor process is found (e.g. it was reparented after its parent exited);
- it was not started through the launcher;
- Claude Code was launched with `--settings`, `--setting-sources` or `--disallowedTools`, or with
  `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR` or `CLAUDE_TMPDIR` in its environment, or its launch
  environment cannot be read;
- any tier sets `permissions.blockReadsOutsideWorkingDirectories` or `sandbox.network.tlsTerminate`;
- a key under `sandbox` is not listed in § 7;
- a deny entry cannot be resolved to a path;
- the GPU patch anchor is not found exactly once in the generated profile, or srt's
  command line does not have the expected shape;
- the launcher, the installed package or `node` is writable under the generated config;
- it is already running inside a sandbox, or not on macOS.

## Rule generation

The output is an srt `SandboxRuntimeConfig`. Paths handed to srt are always absolute.

### 1. Context

| Symbol | Meaning | Source |
|---|---|---|
| `CC` | the Claude Code process | nearest ancestor whose executable (`lsof -d txt`) resolves into `H/.local/share/claude/versions/` |
| `H` | home directory | `getpwuid(getuid())` |
| `P` | project root | `realpath` of the working directory of `CC` (`lsof -d cwd`) |
| `C` | Claude config dir | `H/.claude` (a custom `CLAUDE_CONFIG_DIR` is refused) |
| `T` | Claude Code temp root | `/tmp/claude-<uid>` (a custom `CLAUDE_CODE_TMPDIR` is refused) |
| `D` | added directories | `permissions.additionalDirectories` (all tiers). `--add-dir` in `CC`'s argv is ignored with a warning: `ps` output cannot be split reliably, and leaving it out is only stricter |
| `W` | working directory for the command | `gpu-run`'s own cwd; grants nothing |

Every path is canonicalized: `~` expanded, made absolute, and the existing prefix
resolved with `realpath`. Seatbelt matches real paths (`/tmp` is `/private/tmp`),
so when the lexical and real spellings differ, rules are emitted for both.

Settings are read with `resolveSettings({ cwd: P })` from
`@anthropic-ai/claude-agent-sdk`, in a process whose environment holds only `PATH`, `LANG` and `HOME=H`.
The per-source raw settings (`sources`) are used, not `effective`, because the meaning
of a path depends on the file it was written in.

### 2. Tiers

| Tier | Trusted | Base dir `B` for relative paths |
|---|---|---|
| managed (`managed-settings.json`, MDM, remote) | yes | `P` |
| user (`C/settings.json`) | yes | `C` |
| project (`P/.claude/settings.json`) | no | `P` |
| local (`P/.claude/settings.local.json`) | no | `P` |
| flag (`--settings`) | — | unsupported, refuse |

### 3. Path spellings

| Spelling | `Edit(…)` / `Read(…)` rules | `sandbox.filesystem.*`, `sandbox.credentials.files` | `permissions.additionalDirectories` |
|---|---|---|---|
| `//x` | `/x` | `/x` | `/x` |
| `/x` | `B/x` | `/x` | `/x` |
| `~/x` | `H/x` | `H/x` | `H/x` |
| `x`, `./x` | `P/x` | `B/x` | `P/x` |

Git-style globs (`*`, `**`, `?`, `[…]`) are kept as globs after the prefix is resolved.
A trailing `/` or `/**` on `additionalDirectories` is dropped.
An allow entry that cannot be resolved is skipped with a warning; a deny entry that
cannot be resolved makes `gpu-run` refuse.

### 4. Filesystem

#### 4.1 Write allow (`allowWrite`)

Union of:

1. `P`
2. `T`
3. every directory in `D`
4. `Edit(…)` allow rules from all tiers; only managed-tier rules when a managed source sets `permissions.allowManagedPermissionRulesOnly`
5. `sandbox.filesystem.allowWrite` from all tiers
6. srt built-ins: `/dev/{stdout,stderr,null,tty,dtracehelper,autofs_nowait}`, `/tmp/claude`, `/private/tmp/claude`, `H/.npm/_logs`, `H/.claude/debug` (re-denied by 4.2)

Claude Code grants more than this in some sessions; `gpu-run` does not reproduce it:
directories added with `--add-dir` or during the session (`/add-dir`, entered worktrees) and the main
repository's git directory when `P` is a linked worktree.

#### 4.2 Write deny (`denyWrite`)

Takes precedence over 4.1. Claude Code protects about a hundred individual paths,
several of them session-internal. `gpu-run` covers them with broader rules.

1. **Claude Code configuration**
   - `C` entirely, and the glob `H/.claude*` (`~/.claude.json`, its backups, …)
   - every settings file listed in `sources`, and `/Library/Application Support/ClaudeCode/{managed-settings.json,managed-settings.d}`
2. **Project-level Claude files**
   - for `P` and each of its ancestors `A` up to `/`: `A/.claude`, `A/.mcp.json`
   - for each root `R` in `{P} ∪ D`: `R/**/.claude`, `R/**/.mcp.json`
3. **Git**
   - for each root `R` in `{P} ∪ D`: `R/**/.git` (all git metadata; Claude Code only protects hooks, config and similar files)
   - against planting a bare repository in `R`: `R/HEAD`, `R/objects`, `R/refs`, plus `R/config` and `R/hooks` unless they are existing directories
   - the `.git` of the repository enclosing `P` (found by walking up from `P`); if it is a `gitdir:` file, its target and common dir
4. **Claude Code runtime files under `T`**
   - `T/bash-edit-diff`
   - `T/*/*/tasks` (background task output of every session)
5. **srt built-ins.** srt adds these itself. `gpu-run` initializes srt with cwd `P`, so they are anchored at `P` and apply at any depth below it:
   `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`,
   `.profile`, `.ripgreprc`, `.mcp.json`, `.vscode/`, `.idea/`, `.claude/commands/`,
   `.claude/agents/`, `.git/hooks/`, `.git/config`
6. **User rules**: `Edit(…)` deny rules and `sandbox.filesystem.denyWrite`, all tiers.

#### 4.3 Read deny (`denyRead`)

Reads are allowed everywhere else.

1. `Read(…)` deny rules, all tiers
2. `sandbox.filesystem.denyRead`, all tiers
3. `sandbox.credentials.files[].path`, all tiers, both `deny` and `mask`
   (Claude Code turns `mask` into deny on macOS and ignores repo-tier `mask` entries; `gpu-run` denies them all)
4. Claude Code internals: `T/bash-edit-diff`, `C/ide`, `C/bridge-spawn`

#### 4.4 Read allow (`allowRead`)

`sandbox.filesystem.allowRead` from the **trusted tiers only**; only the managed tier
when a managed source sets `sandbox.filesystem.allowManagedReadPathsOnly`.
Claude Code also honors project and local entries; `gpu-run` ignores them so that a
repository cannot re-open paths denied by user or managed settings.
srt semantics apply: a `denyRead` entry more specific than the `allowRead` region
it falls in stays denied.

### 5. Network

`gpu-run` starts its own srt proxies. Claude Code's proxy cannot be reused
because it authenticates each session.

- `allowedDomains` = `sandbox.network.allowedDomains` ∪ `WebFetch(domain:…)` allow rules, all tiers.
  When a managed source sets `sandbox.network.allowManagedDomainsOnly`, managed tier only.
- `deniedDomains` = `sandbox.network.deniedDomains` ∪ `WebFetch(domain:…)` deny rules, all tiers.
  `deniedDomainReasons` is passed through.
- Hosts approved interactively during the session are not included.
- There is no ask callback: requests to hosts that are not allowed are denied without a prompt.
- `allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`,
  `httpProxyPort`, `socksProxyPort`: merged value over all tiers, as Claude Code does.

### 6. Child environment

The child starts from `gpu-run`'s environment, then:

- every `sandbox.credentials.envVars[].name` is removed (Claude Code substitutes a sentinel for `mask`; `gpu-run` removes the variable);
- srt adds the proxy variables, `SANDBOX_RUNTIME=1` and `TMPDIR` (`gpu-run` sets `CLAUDE_CODE_TMPDIR=T` before calling srt).

### 7. Settings keys

`sandbox` keys not listed here make `gpu-run` refuse, so that a restriction added
to Claude Code later is never dropped silently.

| Key | Handling |
|---|---|
| `enabled` | ignored; `gpu-run` always sandboxes |
| `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `excludedCommands`, `ignoreViolations` | not applicable, ignored |
| `enableWeakerNestedSandbox`, `bwrapPath`, `socatPath`, `ripgrep` | Linux or tooling only, ignored |
| `enableWeakerNetworkIsolation` | merged value, all tiers |
| `allowAppleEvents` | ignored; never granted |
| `filesystem.allowWrite`, `denyWrite`, `denyRead`, `allowRead` | § 4 |
| `filesystem.allowManagedReadPathsOnly` | § 4.4 |
| `filesystem.disabled` | ignored; filesystem isolation always on |
| `network.allowedDomains`, `deniedDomains`, `deniedDomainReasons`, `allowManagedDomainsOnly` | § 5 |
| `network.allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`, `httpProxyPort`, `socksProxyPort` | § 5 |
| `network.strictAllowlist` | always in effect |
| `network.tlsTerminate` | refuse |
| `credentials.files`, `credentials.envVars` | § 4.3, § 6 |
| `credentials.awsPairs`, `credentials.sigv4`, `credentials.allowPlaintextInject` | ignored; only used for mask injection, which `gpu-run` does not do |

| `permissions` key | Handling |
|---|---|
| `allow`, `deny` | `Edit(…)`, `Read(…)` and `WebFetch(domain:…)` rules as above; other tools ignored |
| `additionalDirectories` | part of `D` |
| `allowManagedPermissionRulesOnly` (managed) | only managed-tier allow rules count |
| `blockReadsOutsideWorkingDirectories` | refuse |
| others (`ask`, `defaultMode`, …) | ignored |

### 8. GPU rules

The rules are inserted into the srt-generated profile directly after its
`(allow iokit-get-properties)` line. They may only use the operations `iokit-open`,
`mach-lookup` and `sysctl-read`: never `file-*`, `network*`, `process-*` or
`appleevent-*`. Every file and network decision stays with the srt config above,
so its deny rules keep applying.

The rules:

```scheme
(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))
(allow mach-lookup (global-name "com.apple.MTLCompilerService"))
```

Both are required and together they are sufficient. Verified on an Apple M4 with a
Metal compute kernel compiled from source, MLX 0.32.1 (matmul + softmax) and
PyTorch 2.14 MPS (matmul + 50 training steps), under a config without
`/private/var/folders` in `allowWrite`:

| Rules | Metal | MLX | PyTorch MPS |
|---|---|---|---|
| none | no device | no device | `mps` unavailable |
| `AGXDeviceUserClient` only | cannot reach `MTLCompilerService` | cannot load kernels | cannot create pipeline state |
| both | ok | ok | ok |

Denials that remain with both rules are harmless and are deliberately not allowed:

- Metal and MPSGraph cannot write their caches:
  `$(getconf DARWIN_USER_CACHE_DIR)/<bundle id>/com.apple.metal/…` and
  `$(getconf DARWIN_USER_TEMP_DIR)/com.apple.MetalPerformanceShadersGraph/…`
  (PyTorch prints "Error creating directory … com.apple.MetalPerformanceShadersGraph").
  Shaders and graphs are compiled again on every run. The caches are shared with
  unsandboxed processes of the same app (e.g. every Python), so writing them from the
  sandbox would let a command poison them.
- `file-issue-extension` for `…/com.apple.metalfe` and `…/com.apple.gpuarchiver`
  (handing cache access to the compiler service). Allowing it made no measurable difference.
- mach-lookup `com.apple.windowserver.active`, `com.apple.tccd.system`,
  `com.apple.CoreServices.coreservicesd`, `com.apple.DiskArbitration.diskarbitrationd`,
  `com.apple.analyticsd`; sysctl-read `kern.iossupportversion`, `kern.hv_vmm_present`,
  `hw.cpusubfamily`; system-info `vfs.disk-space`; the syslog socket.

### 9. Execution

- `gpu-run <command> [args…]`: the arguments are shell-quoted and joined into
  `cd W && <command> <args…>`, which runs as `/bin/bash -c` inside the sandbox.
  Use `gpu-run bash -c '…'` for pipelines.
- `gpu-run` calls srt with cwd `P`, takes srt's `env … /usr/bin/sandbox-exec -p <profile> …`
  command line apart, patches the profile and spawns `/usr/bin/sandbox-exec` itself.
- The child's environment is the original one minus § 6, plus srt's variables.
- stdio is inherited, the exit status is propagated, SIGINT/SIGTERM/SIGHUP/SIGQUIT are
  forwarded, and the srt proxies are stopped on exit.
- `--explain` prints the resolved srt config, the final profile and the reason for
  every entry, and runs nothing.

## Stricter than Claude Code

In short, compared with a sandboxed Bash command in the same session:

- no writes to git metadata in `P` or `D` (`git commit` fails inside `gpu-run`);
- no writes anywhere in `~/.claude`, or in any `.claude/` / `.mcp.json` in `P`, `D` and the ancestors of `P`;
- no directories or hosts granted during the session;
- project and local `allowRead` entries are ignored;
- Apple Events are never allowed;
- credential masks become read-deny or an unset variable;
- filesystem isolation stays on even when `sandbox.enabled` or `sandbox.filesystem.disabled` would turn it off;
- network requests to hosts that are not listed are denied without a prompt.

## Limitations

- The approximation of Claude Code's rules was derived from Claude Code 2.1.282,
  `@anthropic-ai/claude-agent-sdk` 0.3.282 and `@anthropic-ai/sandbox-runtime` 0.0.77.
  Claude Code changes often; re-check § 4 when upgrading.
- `resolveSettings` is an alpha API and follows Claude Code's release cycle.
- Only Claude Code from the native installer is recognized.
- Directories added with `--add-dir` or during the session are not writable inside `gpu-run`;
  list them in `permissions.additionalDirectories` instead.
- Custom `CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_TMPDIR` are not supported.
- macOS only.

## License

TBD
