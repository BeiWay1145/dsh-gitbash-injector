# Writing DSH plugins: findings from real sessions

These are verified facts about the DSH kernel that were **only discoverable by running a real
instance**. Each one cost real debugging time, and each is the kind of thing that produces a
*silent* failure — no exception, no log line, just a feature that does not work.

They came out of building this plugin and two others, across twelve agent runs. Every claim is
marked **verified** or **unverified**; nothing here is inferred from reading the source alone.

---

## 1. Tool calls have TWO event families, and PTC uses the second one

**Verified** — found independently by two runs that did not know about each other.

If you listen on `session/event` for `tool/call` + `tool/result`, you will **silently miss an
entire class of calls**. Calls made *inside* a `run_code` program never emit those events.

| | Model-direct call | Call inside a `run_code` program |
|---|---|---|
| Events | `tool/call` → `tool/result` | `tool/ptc-dispatch-start` → `tool/ptc-dispatch` |
| Correlation id | `callId` | **`subCallId`** (e.g. `call_x:ptc:1`) |
| `turn` / `step` | present | **always null** |
| Parent | — | `rootCallId` / `parentCallId` |
| Result payload | `message.content[].content` | **`data.content`** |
| Failure flag | `isError` (nested in message) | **`data.isError`** |

Why this bites: **`ptc` is the default preset on Windows.** In PTC mode the model only ever
calls `run_code` directly, so essentially all real tool activity is the nested family. A logger
listening only for `tool/call` looks *nearly empty* — and reports no error at all.

Real sample from a live session:

```
write    nested=true   callId=call_00_EHsP...:ptc:1
read     nested=true   callId=call_00_EHsP...:ptc:2
glob     nested=true   callId=call_00_EHsP...:ptc:3
run_code nested=false  callId=call_00_EHsP...      <- the parent
```

The nested records hang off the parent `run_code` by `rootCallId`.

## 2. `isolate()` takes a service NAME, as a string

**Verified** — this plugin failed with it.

DSH allows exactly one host provider of `ctx.shell`. To run a second one you must isolate the
name into a child realm:

```js
const scoped = agent.ctx.isolate('shell')     // correct
const scoped = agent.ctx.isolate({ shell: true })  // WRONG
```

The object form isolates a property named `"[object Object]"`, leaving `shell` pointing at the
parent's registration. The later `provide` then dies with:

```
service "shell" has been registered at <SandboxPwshExecutor>
```

## 3. `tools.register` does NOT compile your parameter schema

**Verified** — this plugin failed with it.

`ToolRuntime.schemaOf` forwards `parameters` to the model **verbatim**. So it must already be
real JSON Schema.

DSH's own tools appear to use a friendlier authoring shape — `required: true` on each property —
but that is only legal because they go through `defineTool()`, which compiles it. A plugin living
outside the kernel's `node_modules` cannot import `defineTool`, so it must write the schema out
longhand:

```js
// rejected: Invalid schema for function 'bash'
parameters: { command: { type: 'string', required: true, description: '...' } }

// accepted
parameters: {
  type: 'object',
  properties: { command: { type: 'string', description: '...' } },
  required: ['command'],
  additionalProperties: false,
}
```

## 4. An empty `dsh.bundle.patch` mounts nothing, silently

**Verified** — reproduced by several independent runs.

A profile bundle must declare `dsh.bundle.patch` **and** that file must actually insert the
plugin's own row. An empty array satisfies the `declares no dsh.bundle` check but adds no entry,
so the module is never imported. Startup succeeds, nothing is logged, the plugin simply never runs.

## 5. A profile patch may supply config, never a second `insert`

**Verified.**

The bundle layer already inserted the row. Repeating an `insert` with the same id from the
profile's `cordis.patch.yml` aborts startup:

```
duplicate loader entry id
```

Supply config by id instead:

```yaml
- id: your-plugin
  config:
    yourField: value
```

## 6. `--dump-config` cannot see activation-time failures

**Verified** — and a run caught itself making the opposite claim, then disproved it by measurement.

`--dump-config` renders the composed tree without starting anything. That makes it excellent for
static shape checks and useless for activation checks. Disabling `pwsh-sandbox` produces:

```
--dump-config   -> exit 0, zero warnings
real boot       -> @deepseek-ai/dsh-permission-presets: pending (waiting for service: shell)
```

The `disabled` baseline is an unevaluated `!!js` expression, and `pending` is a *cordis
activation-time* diagnostic. Static checks cannot see it; only a real boot can.

This is the most dangerous entry in this document: a skill that tells you to run
`--dump-config` to diagnose a `pending` failure sends you at a diagnostic that can never find it.

## 7. `pwsh-sandbox` is the only host `shell` provider on Windows

**Verified** — this cost a recovery-mode startup failure.

Disabling it breaks the boot, because `dsh-permission-presets` injects `shell` and waits forever:

```
@deepseek-ai/dsh-permission-presets: pending (waiting for service: shell)
dsh: 1 entry did not activate
```

If you need different shell behaviour, **coexist** with it (that is what isolation realms are
for) rather than replacing it.

## 8. On Windows, no signal tells the model which shell to prefer

**Verified** — supplying a signal changed the model's choice.

The two shipped shell tools describe themselves in exactly parallel language
(`Execute a bash command` / `Execute a PowerShell command`), and both of their system-prompt
sections discuss only exit codes. With no preference stated anywhere, the model defaults to the
kernel-native `pwsh` — so an injected `bash` tool sits present but unused.

Adding a tool-description line **and** a scoped `systemPrompt.section` (order 999, just before
`TOOL_BASH` at 1000 and `TOOL_PWSH` at 1010) made the model choose `bash` on the first try, from a
prompt that never mentioned bash at all.

## 9. `--patch` overlays do not mount anything

**Verified.**

`dsh --profile X --patch overlay.yml --dump-config` affects only that invocation's composed tree.
The module is never imported, so a successful run proves nothing about whether the plugin works.
It is a config-shape tool, not a runtime test.

## 10. Unit tests passing means nothing on their own

**Verified** — this is the headline lesson.

This plugin had 46 unit tests green while carrying four bugs that made it completely
non-functional (see CHANGELOG). Every one of them was invisible to unit tests because every one
of them was about how the plugin interacts with the live kernel.

Treat "unit tests pass" as a statement about your code, not about your plugin.

---

## Environment-specific notes (this machine)

Several of these are local quirks rather than kernel facts, but they caused real
misdiagnosis, so they are recorded:

| Fact | Consequence |
|---|---|
| First `tar` on PATH is **MSYS2 GNU tar 1.35**, not the Windows-bundled **bsdtar 3.8.4** | GNU tar cannot read zip and treats `C:/...` as a remote host — the error (`tar: Cannot connect to C: resolve failed`) reads like a bad path. Prefer the absolute path and *run a list operation* to prove a backend can read that archive. |
| Pipes swallow exit codes | `bz t corrupt.zip \| tail` yields `$?` = 0; without the pipe it is 2. Scripts that communicate conclusions through exit codes will silently report success. |
| Chinese-locale Windows defaults Python to GBK | Any `read_text()` on UTF-8 content raises `UnicodeDecodeError`. Pin `encoding="utf-8"` on every read and write. |

## Credits

These findings came from twelve agent runs during a skill-evaluation exercise, several of which
independently reproduced the same kernel behaviour. Two runs deserve particular credit: one
disproved a claim it had already written, and another reported contamination that invalidated its
own result.
