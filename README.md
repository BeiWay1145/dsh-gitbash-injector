# dsh-gitbash-injector

Give Windows sessions on **DeepSeek Harness (DSH)** a real **Git Bash** shell —
**without adding or modifying any agent preset.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

```
model calls bash  ->  jq --version && uname -s
                       jq-1.7.1
                       MINGW64_NT-10.0-26200
```

---

## Why this exists

On Windows, DSH ships only a **PowerShell** shell seam: `dsh-base` sets
`disabled: process.platform === 'win32'` on both `bash-sandbox` and `tool-bash`.

Flipping those two rows back on **does not work**, for two independent reasons:

1. **PTY** — the shipped persistent bash runs over a PTY backend that
   `dsh-subprocess-local` does not implement on win32.
2. **Sandbox** — the Windows ACL sandbox spawns children under a WRITE_RESTRICTED
   token, and the MSYS runtime cannot initialise inside it. It fails to create its
   signal pipe and dies:

   ```
   bash: *** fatal error - couldn't create signal pipe, Win32 error 5
   ```
   (exit `0xC0000142` / `STATUS_DLL_INIT_FAILED`.)

   Measured on this machine against **both** `Git\bin\bash.exe` and
   `Git\usr\bin\bash.exe` — identical failure.

This plugin sidesteps both by providing its own shell service from the host plane,
per agent, behind an isolation realm — the same mechanism the shipped presets use
for their own services.

## How it works

```js
ctx.on('agent/created', ({ agent }) => {
  const scoped = agent.ctx.isolate('shell')        // realm-private service name
  scoped.provide('shell', gitBashExecutor)         // Git Bash instead of pwsh
  scoped.tools.register({ name: 'bash', ... })     // lands in THIS agent's layer
})
```

A few details that matter:

- **`isolate('shell')` takes the service NAME as a string.** DSH allows exactly one
  host `ctx.shell` provider, so running a second one requires isolating the name into
  a child realm. Passing an object instead of a string isolates a property named
  `"[object Object]"`, and the later `provide` dies with
  `service "shell" has been registered at <SandboxPwshExecutor>`.
- **The tool schema must be real JSON Schema.** `tools.register` forwards
  `parameters` verbatim to the provider, so the authoring shape DSH's own tools use
  (a per-property `required: true`) is rejected with
  `Invalid schema for function 'bash'`. That shape is only legal through `defineTool()`,
  which a plugin outside the kernel's `node_modules` cannot import.

## Safety: an honest boundary

The provider **deliberately does not declare `sandboxMode`.** It is not a confining
executor, and claiming otherwise would be a lie the tool layer then acts on.

Instead it **gates**:

| Session policy | Behaviour |
|---|---|
| `danger-full-access` | runs |
| no policy (deployment has no sandbox) | runs |
| `workspace-write` / `read-only` | **refused**, with actionable guidance |

It refuses rather than silently escaping the boundary you asked for. The tool also
advertises `sandbox_permissions` + `justification` so the model can request a
one-shot widening through the normal approval path where approvals exist.

> **On a subagent, approvals are disabled** — escalation is rejected automatically.
> The tool description tells the model to fall back to `pwsh` there, which is
> sandbox-confined and runs under every policy.

## Install

```powershell
cd $env:USERPROFILE\.dsh\profiles\<your-profile>
pnpm add "link:<path-to-this-repo>"
```

Then add `"dsh-gitbash-injector"` to `dsh.profile.bundles` in that profile's
`package.json`, and run `pnpm install`.

Restart DSH.

### Four traps that cost real time (all measured)

**1. A bundle patch must not be an empty array.**
The bundle must **insert its own row**. `[]` satisfies the `declares no dsh.bundle`
check but mounts nothing — no error, the plugin simply never runs.

**2. The package name must be in `dsh.profile.bundles`.**
A `dependencies` entry alone fails the boot with
`profile bundle "..." declares no dsh.bundle`.

**3. Use `link:`, not `file:`.**
pnpm **copies** `file:` local deps instead of linking, so edits to the source
`package.json` don't take effect (it reads back as `null`).

**4. A profile patch may only supply config, never another `insert`.**
The bundle layer already inserted the row; repeating it aborts startup with
`duplicate loader entry id`.

### Do not disable `pwsh-sandbox`

On win32 it is the **only** host `ctx.shell` provider. Disabling it makes
`dsh-permission-presets` wait forever for `shell` and DSH fails to boot:

```
@deepseek-ai/dsh-permission-presets: pending (waiting for service: shell)
dsh: 1 entry did not activate
```

This plugin coexists with it — that is exactly what the isolation realm buys.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `shellPath` | auto-detected | explicit path wins; `GIT_BASH` env var also honoured |
| `timeoutMs` / `maxTimeoutMs` | `120000` / `600000` | per-command timeout and cap |
| `maxOutputBytes` / `maxSpillBytes` | `64000` / `67108864` | retained output, spill file cap |
| `graceMs` | `3000` | termination grace |
| `verbose` | `false` | log each injection decision to the host logger |

**Shell detection order:** `GIT_BASH` → standard install roots under `ProgramFiles`, 
`ProgramFiles(x86)`, `LOCALAPPDATA` → every non-WSL `bash.exe` on `PATH` → bare `bash`.
The `bash.exe` stubs under `System32`/`SysWOW64` are the **WSL launcher**, not a real
bash, and are skipped.

**`workdir`** accepts a native path or a Git Bash drive path: `/d/foo` is converted
to `D:\foo`. MSYS root paths like `/usr/bin` are left alone (they would otherwise
be mangled into `U:\sr\bin`).

## Verification

Everything below was measured on a real DSH instance, not inferred from the source.

| Scenario | Result |
|---|---|
| **PTC preset** (the default) via `run_code` → `tools.bash` | works; the tool appears in the generated SDK declaration |
| PTC + `workspace-write` | gate refuses → model escalates → `jq-1.7.1` / `MINGW64_NT-10.0-26200` |
| PTC + `danger-full-access` | succeeds on the **first** call, no escalation |
| `standard` / `cordis` presets | `bash` present in the catalog |
| `minimal` preset | fills a real gap — that preset disables its persistent shell on win32 |
| 3 concurrent sessions | each injected independently, no collisions |
| second turn of an existing session | re-injected correctly |
| **subagent** under a restricted policy | tool present but escalation is refused (DSH policy) → falls back to `pwsh` |

Four bugs were found only by running real sessions, and all are fixed:

| Symptom | Root cause |
|---|---|
| loaded but never injected | guard asked "does a shell resolve?" — the host PowerShell executor always resolves, so it always refused |
| `service "shell" has been registered` | `isolate()` takes a string, not an object |
| `Invalid schema for function 'bash'` | parameters must be real JSON Schema |
| escalation retry failed identically | executors read the session policy and ignored the per-call `sandbox_permissions` |

## Tests

```sh
node test/executor.test.mjs    # 22 cases: path conversion, WSL skip, detection, config, gate
node test/guard.test.mjs       #  8 cases: injection decision table
node test/schema.test.mjs      #  8 cases: parameters must be real JSON Schema
node test/injection.test.mjs   # real cordis: isolate + provide + register
node test/bash-tool.test.mjs   # end-to-end: real Git Bash + jq + exit codes
```

## Requirements

- DSH (DeepSeek Harness) on **Windows**
- [Git for Windows](https://git-scm.com/download/win) — expected at
  `C:\Program Files\Git`, or point `shellPath`/`GIT_BASH` at it
- Node built-ins only — no runtime dependencies

On POSIX the plugin is inert by design: the shipped bash rows already work there.

## Uninstall

Remove `dsh-gitbash-injector` from `dsh.profile.bundles` and from `dependencies`
in the profile's `package.json`, run `pnpm install`, and restart DSH.

## License

MIT — see [LICENSE](LICENSE).
