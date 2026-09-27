/**
 * dsh-gitbash-injector — give selected agent sessions a real Git Bash shell,
 * WITHOUT modifying or adding any agent preset.
 *
 * THE PROBLEM
 * -----------
 * On win32 the shipped composition mounts only the PowerShell shell seam:
 * `dsh-base` sets `disabled: process.platform === 'win32'` on both
 * `bash-sandbox` and `tool-bash`. Enabling those rows by id does not work,
 * for two independent reasons (see `executor.js` for the measurements):
 * the PTY backend is absent on win32, and the MSYS runtime cannot initialise
 * inside the Windows ACL restricted-token sandbox.
 *
 * THE APPROACH
 * ------------
 * A preset normally installs its own `shell` provider behind an
 * `isolate: { shell: true }` realm. That works, but it means owning a preset
 * (or editing a shipped one, which the next Desktop upgrade overwrites).
 *
 * This plugin does the same thing from the HOST plane instead, per agent:
 *
 *   ctx.on('agent/created', ({ agent }) => { install(agent) })
 *
 * For each qualifying agent it creates a scoped child context, isolates the
 * `shell` service inside it, provides the Git Bash provider there, and
 * registers the `bash` tool through that same scoped context. The kernel's
 * tool registry is layer-scoped, so the registration lands in THIS agent's
 * layer and is invisible to every other session.
 *
 * Why the isolation realm is mandatory: `dsh-shell` documents that a host
 * composes exactly ONE provider of `ctx.shell` and that mounting a second
 * "fails loud on a duplicate service registration". Isolating the name into a
 * child realm is what makes a per-agent provider legal, and it is exactly what
 * the shipped presets do for their own services.
 *
 * SCOPE (per the request): inject only where the session has no usable bash
 * already — i.e. never shadow a real bash provider, and never touch a POSIX
 * host. See `shouldInject`.
 *
 * @module dsh-gitbash-injector
 */

import { existsSync } from 'node:fs'
import { createGitBashShell, detectShellPath, name as executorName, resolveConfig, toWindowsPath } from './executor.js'

/**
 * Debug tracer routed through the host logger. Per-decision tracing is what made
 * the load/activation failures of this plugin diagnosable, so it stays — but it
 * writes to the DSH host log rather than a private file, and it is silent unless
 * `verbose` is enabled in the row config.
 */
let traceEnabled = false
let traceLogger

/**
 * Emit one debug line, when tracing is enabled.
 *
 * @param event - short event label.
 * @param detail - extra context.
 */
function trace(event, detail) {
  if (!traceEnabled) return
  try { traceLogger?.info?.('[' + name + '] ' + event + ' ' + detail) } catch { /* never break the plugin */ }
}

/**
 * System-prompt section order for the shell-preference rule.
 *
 * The kernel's own table puts TOOL_BASH at 1000 and TOOL_PWSH at 1010; 999
 * places this section immediately before both, so the rule is read before
 * either tool's own guidance.
 */
const PREFERENCE_SECTION_ORDER = 999

/**
 * The shell-preference rule, as one system-prompt section.
 *
 * This exists because nothing else in the composition states a preference. The
 * two shipped shell tools describe themselves in exactly parallel language and
 * both prompt sections talk only about exit codes, so the model has no basis to
 * choose and defaults to the kernel-native pwsh. Injecting bash without also
 * saying when to use it leaves the tool present but unused.
 *
 * It is deliberately scoped to the sessions this plugin injected into, and it
 * keeps pwsh reachable rather than suppressing it: the fallback matters when a
 * sandbox refuses bash, and PowerShell genuinely is the better tool for
 * Windows-native administration.
 *
 * The last sentence addresses a real behaviour seen in RESUMED sessions. A
 * transcript that already contains dozens of pwsh calls is a strong few-shot
 * demonstration, and demonstration beats instruction: the model keeps reaching
 * for pwsh even with this section in front of it. Naming that pattern outright —
 * telling the model the earlier turns predate this shell — is what breaks the
 * anchor, because otherwise the model has no way to know those turns are stale.
 */
const PREFERENCE_TEXT = [
  'On Windows, prefer the `bash` tool over `pwsh` for shell work.',
  'Use bash by default: pipes, text processing, grep/sed/awk/find/jq, git, and build or test commands.',
  'Use `pwsh` instead only when (a) bash is refused by the sandbox and cannot be escalated — a subagent, or a session whose approvals are disabled — or (b) the task is Windows-native administration, where PowerShell is more direct: services, the registry, WMI/CIM, COM, and event logs.',
  'If earlier turns in this conversation used `pwsh`, that was before this `bash` tool existed — their example is stale and is not a reason to keep using `pwsh`.',
].join(' ')

/**
 * The one-time announcement spliced into a resumed session's inbox.
 *
 * Kept short on purpose. It is read once, adjacent to real work, so it spends
 * its words saying only what the model cannot infer: that the earlier pwsh
 * calls predate this tool rather than recommending it.
 */
const SWITCH_ANNOUNCEMENT = [
  'A `bash` tool (Git for Windows bash) is now available in this session.',
  'The `pwsh` calls earlier in this conversation happened before it existed — they are not a preference, just history.',
  'From here on, prefer `bash` for shell work; use `pwsh` only when bash is refused by the sandbox, or for Windows-native administration.',
].join(' ')

/** Stable cordis plugin name. */
export const name = 'gitbash-injector'

/** Host services this plugin consumes. */
export const inject = ['agents', 'subprocess']

/** Tool name to register (the request chose `bash`). */
const TOOL_NAME = 'bash'

/** Marks a shell service we provided, so re-entry is idempotent. */
const OURS = Symbol.for('dsh-gitbash-injector.shell')

/**
 * Whether a resolved `shell` service is a BASH provider.
 *
 * The plugin must not shadow a working bash, but it must not mistake the shipped
 * PowerShell executor for one either — on win32 that executor is ALWAYS present
 * (as `SandboxPwshExecutor`, a host-plane provider every agent scope inherits),
 * so any test that merely asks "is there a shell?" rejects unconditionally and
 * the plugin silently never injects.
 *
 * Identity is read from the executor's own executable fields, which each shipped
 * executor names after its shell: `pwshPath` (PowerShell), `bashPath` or
 * `shellPath` (bash). A subclass — the sandboxed variants — keeps the same field.
 * A provider carrying no path at all is treated as NOT bash, which is the safe
 * direction: injecting beside an unknown provider costs one extra tool, while
 * failing to inject beside a real bash would be a silent no-op.
 *
 * @param shell - the resolved shell service, or undefined.
 * @returns true when that service already runs bash.
 */
export function resolvesBash(shell) {
  if (shell === undefined || shell === null) return false
  if (typeof shell.run !== 'function') return false
  const exe = shell.bashPath ?? shell.shellPath ?? shell.pwshPath
  if (typeof exe !== 'string' || exe.length === 0) return false
  return /\bbash(\.exe)?$/i.test(exe)
}

/**
 * Whether this agent should receive the injected Git Bash provider.
 *
 * The rule is deliberately conservative — an injected shell that shadows a
 * working one would be a regression, so we only fill a genuine gap:
 *
 *  - never on a POSIX host (the shipped bash rows already work there);
 *  - never when this exact agent was already installed for;
 *  - never when the agent's scope ALREADY RESOLVES A BASH PROVIDER.
 *
 * That last rule is the subtle one, and getting it wrong costs the whole plugin.
 * The obvious test — "does this agent resolve a `shell` service?" — is WRONG:
 * `pwsh-sandbox` is a HOST-plane provider, every agent scope inherits it, and so
 * every agent on win32 resolves a shell. Gating on that makes the guard reject
 * unconditionally and the plugin silently never injects.
 *
 * The question that actually matters is whether the session already has a *bash*
 * capability, because that is what this plugin supplies and what a working
 * provider would make redundant. Two observations answer it:
 *
 *  - a host shell whose `sandboxMode` is undefined is the pwsh executor (the
 *    shipped bash sandbox declares its mode), so it is not a bash provider;
 *  - an agent whose catalog already offers a `bash` tool needs nothing from us.
 *
 * @param agent - the agent from `agent/created`.
 * @param platform - target platform, injectable for tests.
 * @returns true when the provider should be installed.
 */
export function shouldInject(agent, platform = process.platform) {
  if (platform !== 'win32') { trace('shouldInject', 'false:posix'); return false }
  if (agent === undefined || agent === null) { trace('shouldInject', 'false:no-agent'); return false }
  const ctx = agent.ctx
  if (ctx === undefined || ctx === null) { trace('shouldInject', 'false:no-ctx'); return false }
  if (ctx[OURS] === true) { trace('shouldInject', 'false:already-ours'); return false }

  // Does this agent already have a bash tool? If so, leave it alone.
  let hasBashTool = false
  try {
    const schemas = ctx.tools?.schemas?.(agent)
    if (Array.isArray(schemas)) hasBashTool = schemas.some((s) => s?.name === TOOL_NAME)
  } catch { /* an unreadable catalog is not evidence of a bash tool */ }
  if (hasBashTool) { trace('shouldInject', 'false:has-bash-tool'); return false }

  // Does the scope resolve a shell provider that IS a bash executor? The shipped
  // bash sandbox advertises a sandboxMode; the pwsh executor does not.
  let existing
  try { existing = ctx.get('shell') } catch { existing = undefined }
  const isBashProvider = resolvesBash(existing)
  trace('shouldInject', isBashProvider ? 'false:bash-provider' : 'true:no-bash-provider')
  if (isBashProvider) return false
  return true
}

/**
 * Install the provider for one agent, if it qualifies.
 *
 * @param ctx - the plugin's (host) context, used for the shared subprocess seam.
 * @param agent - the agent to consider.
 * @param config - resolved plugin configuration.
 * @param logger - optional logger.
 * @returns a disposer, or undefined when nothing was installed.
 */
export function installAgent(ctx, agent, config, logger) {
  if (!shouldInject(agent, config.platform)) return undefined

  let scoped
  try {
    trace('isolate-begin', String(agent.id))
    // A scoped child context whose `shell` name is realm-private: this is what
    // makes a second `shell` provider legal beside the host's.
    //
    // `isolate(name, label)` takes the SERVICE NAME as a string. Passing an
    // object isolates a property named after that object instead, leaving
    // `shell` pointing at the parent's registration — and the later
    // `provide('shell', ...)` then dies with
    // 'service "shell" has been registered at <SandboxPwshExecutor>'.
    scoped = agent.ctx.isolate('shell')
    trace('isolate-ok', String(agent.id))
  } catch (error) {
    trace('isolate-FAIL', String(error))
    logger?.warn?.('[' + name + '] could not isolate a shell realm for agent ' + String(agent.id) + ': ' + String(error))
    return undefined
  }

  let shell
  try {
    shell = createGitBashShell(ctx.subprocess, config)
  } catch (error) {
    logger?.warn?.('[' + name + '] could not build the Git Bash provider: ' + String(error))
    return undefined
  }
  shell[OURS] = true

  const disposers = []
  try {
    scoped.provide('shell', shell)
    disposers.push(() => {})

    // Without this section the model gets NO preference signal between the two
    // shells: the shipped tool descriptions are exactly symmetric ("Execute a
    // bash command" / "Execute a PowerShell command") and neither tool's prompt
    // section mentions priority. With no signal the model picks the
    // kernel-native pwsh, which is why bash went unused in fresh sessions.
    //
    // Registered on the AGENT's scoped context, not the plugin's host context,
    // so it reaches exactly the sessions this plugin injected into. Order 999
    // places it just before TOOL_BASH (1000) and TOOL_PWSH (1010).
    scoped.systemPrompt?.section?.({
      name: 'tool:gitbash-injector',
      order: PREFERENCE_SECTION_ORDER,
      text: PREFERENCE_TEXT,
    })
    disposers.push(() => {})

    // A resumed session carries a transcript full of pwsh calls. That is a
    // few-shot demonstration, and demonstration beats instruction, so the
    // section above can lose to it. Announce the switch once, in the turn it
    // becomes true, through the inbox where weighting is nearest-field.
    //
    // Once per agent, and only when the transcript actually shows the pattern:
    // a fresh session has nothing to correct, and a notice nobody needs is
    // pure context cost.
    // This mirrors the pattern the kernel itself uses for its model-switch
    // notice (see dsh-agent's installModelSelection): append to the messages
    // the pre-step decision already returned, rather than splicing the inbox.
    // Appending is simpler and needs no inbox handle, and the durable
    // transcript records it as an ordinary user message.
    //
    // Fires once per agent, and only when the transcript actually shows the
    // pattern: a fresh session has nothing to correct, and a notice nobody
    // needs is pure context cost.
    let announced = false
    const onPreStep = async ({ agent, messages, signal, step }, next) => {
      const decision = await next()
      if (announced || signal?.aborted) return decision
      if (decision.kind === 'reject') return decision
      // Wait for a step that actually carries the user's turn, so the notice
      // lands beside real work instead of in an empty assembly.
      if (decision.messages.length === 0 && step !== 1) return decision
      announced = true
      try {
        let pwshCalls = 0
        let bashCalls = 0
        for (const event of agent?.session?.events ?? []) {
          if (event?.type !== 'tool/call') continue
          const n = event.data?.name
          if (n === 'pwsh') pwshCalls++
          else if (n === TOOL_NAME) bashCalls++
        }
        if (pwshCalls === 0 || bashCalls > 0) return decision
        trace('announce-switch', String(agent.id) + ' pwsh=' + pwshCalls + ' bash=' + bashCalls)
        return {
          ...decision,
          messages: [...decision.messages, {
            role: 'user',
            source: { kind: 'plugin', plugin: name, form: 'notice' },
            content: [{ type: 'text', text: SWITCH_ANNOUNCEMENT }],
          }],
        }
      } catch (error) {
        trace('announce-FAIL', String(error))
        return decision
      }
    }
    scoped.on?.('agent/pre-step', onPreStep, { prepend: true })
    disposers.push(() => {})

    scoped.tools.register({
      name: TOOL_NAME,
      description: [
        'Execute a bash command (`bash -c`) through Git for Windows bash and return its stdout/stderr.',
        'PREFER THIS TOOL over `pwsh` on Windows. Use bash by default for anything a POSIX shell does: pipes, text processing, grep/sed/awk/find/jq, git, build and test commands, and any command you would write for Linux. Reach for `pwsh` only in the two cases below, not merely because you are on Windows.',
        'Use `pwsh` instead when: (1) this tool is refused by the sandbox and cannot be escalated (see the sandbox note below) — a delegated subagent, or a session that states approvals are disabled; or (2) the task is Windows-native administration, where PowerShell is the more direct tool: services (Get-Service), the registry (Get-ItemProperty / Set-ItemProperty on HKLM:/HKCU:), WMI/CIM (Get-CimInstance), COM objects, and Windows event logs.',
        'Each call runs in a fresh login shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`.',
        'Non-zero exits are reported as `[exit code: N]`.',
        'This shell is NOT sandbox-confined: the MSYS runtime cannot start inside the Windows restricted-token sandbox, so commands run only when the session policy is full access.',
        'If this tool refuses for that reason: (1) in a session where approvals are available, retry the SAME command once with `sandbox_permissions: "danger-full-access"` plus a one-sentence `justification`; (2) where they are not — a delegated subagent, or a session that states approvals are disabled — escalation is rejected automatically, so DO NOT attempt it: use the `pwsh` tool instead. PowerShell is sandbox-confined and runs under every policy, and for the shell commands an agent normally runs the two are interchangeable.',
        'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.',
      ].join('\n'),
      // MUST be real JSON Schema. `tools.register` passes `parameters` straight
      // through to the model (see ToolRuntime.schemaOf), so the authoring shape
      // the kernel's own tools use — a per-property `required: true` — is NOT
      // accepted here: it reaches the provider verbatim and the request is
      // rejected with "Invalid schema for function 'bash'". That shape is only
      // legal through defineTool(), which compiles it; a plugin living outside
      // the kernel's node_modules cannot import that, so the schema is written
      // out longhand and `required` is declared as the standard array.
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute.',
          },
          description: {
            type: 'string',
            description: 'Clear, concise description of what this command does in active voice, 5-10 words.',
          },
          workdir: {
            type: 'string',
            description: 'Working directory; defaults to the session cwd. Git Bash paths like /d/foo are accepted and converted to D:\\foo.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds.',
          },
          // Advertised so the kernel's escalation path is reachable: under a
          // narrower session policy the executor REFUSES, and this is how the
          // model asks for the one-shot widening that makes the command run.
          sandbox_permissions: {
            type: 'string',
            description: 'Escalate this one command: "danger-full-access". The Git-for-Windows bash runtime cannot start inside the restricted-token sandbox, so a narrower session policy is refused. Only valid where approvals are available — in a delegated subagent or a session with approvals disabled this is rejected automatically; use the pwsh tool there instead.',
          },
          justification: {
            type: 'string',
            description: 'One sentence explaining why this exact command needs the wider access.',
          },
        },
        required: ['command', 'description'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        // The standing policy for this call, then the per-call escalation the
        // model may have asked for. Without applying the second step the
        // documented upgrade path is inert: the model sends
        // `sandbox_permissions`, the gate keeps reading the standing mode, and
        // the retry fails identically — which is worse than not offering the
        // escalation at all, because the model is told to use it.
        const standing = exec?.agent?.session === undefined
          ? undefined
          : ctx.get('sandboxPolicy')?.resolve?.({ session: exec.agent.session })
        const escalated = typeof args.sandbox_permissions === 'string' && args.sandbox_permissions.length > 0
        const policy = escalated
          ? { ...(standing ?? {}), mode: args.sandbox_permissions }
          : standing
        // The kernel's managed `DSH_*` variables (DSH_HOME, DSH_SESSION_ID,
        // DSH_SHELL, DSH_WEB_URL, ...) — the same set the shipped tool-bash
        // passes. Without this the injected shell is missing every harness fact
        // the system prompt tells the model it can read from the environment.
        const dshEnv = ctx.get('shellEnv')?.collect?.(exec)
        const spec = shell.resolve({
          command: String(args.command ?? ''),
          workdir: typeof args.workdir === 'string' && args.workdir.length > 0
            ? args.workdir
            : exec?.agent?.session?.header?.cwd,
          ...typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {},
          ...exec?.signal === undefined ? {} : { signal: exec.signal },
          ...dshEnv === undefined ? {} : { dshEnv },
          sandboxPolicy: policy,
        })
        const result = await shell.run(spec)
        const body = [result.stdout?.text ?? '', result.stderr?.text ?? ''].filter((part) => part.length > 0).join('\n')
        const suffix = result.exitCode === 0 ? '' : '\n[exit code: ' + String(result.exitCode) + ']'
        const text = (body.length > 0 ? body : '(no output)') + suffix
        if (result.exitCode !== 0) throw new Error(text)
        return { text }
      },
    })
    disposers.push(() => {})
  } catch (error) {
    trace('install-FAIL', String(agent.id) + ' :: ' + String(error))
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* best effort */ }
    }
    logger?.warn?.('[' + name + '] failed to install for agent ' + String(agent.id) + ': ' + String(error))
    return undefined
  }

  trace('install-OK', String(agent.id ?? '(unknown)'))
  logger?.info?.('[' + name + '] installed ' + executorName + ' for agent ' + String(agent.id ?? '(unknown)'))
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* best effort */ }
    }
    try { scoped.dispose?.() } catch { /* best effort */ }
  }
}

/**
 * Plugin entry.
 *
 * @param ctx - cordis context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config = {}) {
  traceEnabled = config.verbose === true
  traceLogger = ctx.logger
  trace('apply-begin', 'platform=' + process.platform)
  const resolved = resolveConfig(config)
  trace('apply-resolved', 'shell=' + resolved.shellPath)
  const installed = new Map()

  const onCreated = ({ agent }) => {
    trace('agent-created', String(agent?.id))
    const dispose = installAgent(ctx, agent, resolved, ctx.logger)
    if (dispose !== undefined) installed.set(agent, dispose)
  }
  const onDisposed = ({ agent }) => {
    const dispose = installed.get(agent)
    if (dispose === undefined) return
    installed.delete(agent)
    dispose()
  }

  // Agents already alive when this plugin loads (a reload, say) qualify too.
  for (const agent of ctx.agents.list()) onCreated({ agent })

  ctx.on('agent/created', onCreated)
  ctx.on('agent/disposed', onDisposed)

  ctx.effect(() => () => {
    for (const dispose of installed.values()) {
      try { dispose() } catch { /* best effort */ }
    }
    installed.clear()
  }, name + ': agent disposers')

  ctx.logger?.info?.(
    '[' + name + '] enabled — shell=' + resolved.shellPath
    + ' platform=' + process.platform
    + (process.platform === 'win32' ? '' : ' (inactive: POSIX host already has bash)')
  )
}

/** Runtime configuration schema for the plugin row. */
export function Config() {}

export default { name, inject, apply }