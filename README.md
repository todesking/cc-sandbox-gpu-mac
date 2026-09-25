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
Claude Code ── Bash: gpu-run python train.py ──▶ gpu-run  (outside Claude Code's sandbox)
                                                  1. find the parent Claude Code process
                                                  2. read settings (claude-agent-sdk resolveSettings)
                                                  3. build an srt config            (§ Rule generation)
                                                  4. srt: start proxies, generate the Seatbelt profile
                                                  5. patch in the GPU rules         (§ 8)
                                                  6. sandbox-exec … python train.py
```

> **Status:** design. Nothing is implemented yet and the GPU rule set is not verified.

## Setup (planned)

Add the command to the excluded commands in your **user** settings (`~/.claude/settings.json`):

```json
{
  "sandbox": {
    "excludedCommands": ["gpu-run *"]
  }
}
```

Excluded commands still go through the normal permission flow (prompt or auto mode).
An allow rule such as `Bash(gpu-run *)` removes the prompt; because the inner command
is sandboxed by `gpu-run`, this is comparable to `sandbox.autoAllowBashIfSandboxed`.

```sh
gpu-run python train.py --device mps
gpu-run --explain python train.py   # print the resolved srt config and the final profile, run nothing
```

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

**Trusted inputs.**

- Settings files. Claude Code's sandbox does not let commands write them.
- The Claude Code process: its working directory, argv and launch environment.
  It is found by walking up the process tree, which a sandboxed command cannot forge.
- The OS user database (uid, home directory).

**Refusal.** `gpu-run` exits with an error and runs nothing when:

- no Claude Code ancestor process is found (e.g. it was reparented after its parent exited);
- Claude Code was launched with `--settings`, `--setting-sources` or `--disallowedTools`;
- any tier sets `permissions.blockReadsOutsideWorkingDirectories` or `sandbox.network.tlsTerminate`;
- a key under `sandbox` is not listed in § 7;
- a deny entry cannot be resolved to a path;
- the GPU patch anchor is not found exactly once in the generated profile;
- it is already running inside a sandbox, or not on macOS.

## Rule generation

The output is an srt `SandboxRuntimeConfig`. Paths handed to srt are always absolute.

### 1. Context

| Symbol | Meaning | Source |
|---|---|---|
| `CC` | the Claude Code process | nearest ancestor whose executable is a Claude Code install (`~/.local/share/claude/versions/*`) |
| `H` | home directory | `getpwuid(getuid())` |
| `P` | project root | working directory of `CC` |
| `C` | Claude config dir | `CLAUDE_CONFIG_DIR` in `CC`'s environment, else `H/.claude` |
| `T` | Claude Code temp root | `CLAUDE_CODE_TMPDIR` in `CC`'s environment, else `/tmp/claude-<uid>` |
| `D` | added directories | `permissions.additionalDirectories` (all tiers) and `--add-dir` in `CC`'s argv |
| `W` | working directory for the command | `gpu-run`'s own cwd; grants nothing |

Every path is canonicalized: `~` expanded, made absolute, and the existing prefix
resolved with `realpath`. Seatbelt matches real paths (`/tmp` is `/private/tmp`),
so when the lexical and real spellings differ, rules are emitted for both.

Settings are read with `resolveSettings({ cwd: P })` from
`@anthropic-ai/claude-agent-sdk`, with `HOME=H` and `CLAUDE_CONFIG_DIR` taken from `CC`.
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
directories added during the session (`/add-dir`, entered worktrees) and the main
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

Current candidate (Apple Silicon; `AGXDeviceUserClient` confirmed on an M4 via `ioreg`):

```scheme
(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))
(allow mach-lookup (global-name "com.apple.MTLCompilerService"))
```

To be settled by running a Metal compute probe and PyTorch MPS under the generated
profile and reading the Sandbox denials from the unified log. Candidates under evaluation:

- mach-lookup: `com.apple.gpumemd.source`, `com.apple.windowserver.active`, `com.apple.tccd.system`
- sysctl-read: `hw.l1dcachesize`, `hw.l2cachesize`, `hw.cachelinesize`, `hw.optional.neon`, `machdep.cpu.core_count`, `machdep.cpu.thread_count`

If Metal needs to write its shader cache (`$(getconf DARWIN_USER_CACHE_DIR)/com.apple.metal`),
that directory is added to § 4.1 rather than to the profile patch.

### 9. Execution

- `gpu-run <command> [args…]`: the arguments are shell-quoted and joined, and srt runs them with `bash -c`.
- `gpu-run` calls srt with cwd `P`; the child runs `cd W && exec <command>`.
- stdio is inherited, the exit status is propagated, SIGINT/SIGTERM are forwarded,
  and the srt proxies are stopped on exit.
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
- Custom `CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_TMPDIR` are read from the Claude Code process's
  launch environment; changes Claude Code makes to its own environment later are not seen.
- macOS only.

## License

TBD
