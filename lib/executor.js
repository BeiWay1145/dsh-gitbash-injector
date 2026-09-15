/**
 * gitbash-executor — Git for Windows (MSYS) bash as a `shell` service provider.
 *
 * WHY THIS EXISTS
 * ---------------
 * On win32 the shipped composition mounts only the PowerShell shell seam
 * (`dsh-base` sets `disabled: process.platform === 'win32'` on both
 * `bash-sandbox` and `tool-bash`). There are two independent reasons a plain
 * "enable the bash rows" patch does not work on Windows:
 *
 *   1. PTY — the shipped persistent bash runs over a PTY backend that
 *      `dsh-subprocess-local` does not implement for win32.
 *   2. SANDBOX — the Windows ACL sandbox spawns children under a
 *      WRITE_RESTRICTED token. The MSYS runtime cannot initialise inside it:
 *      it fails to create its signal pipe ("couldn't create signal pipe,
 *      Win32 error 5" = ACCESS_DENIED) and dies with STATUS_DLL_INIT_FAILED
 *      (0xC0000142). Measured on this machine against BOTH
 *      `Git\bin\bash.exe` and `Git\usr\bin\bash.exe`.
 *
 * So this provider deliberately does NOT declare `sandboxMode`: it is not a
 * confining executor, and claiming otherwise would be a lie the tool layer
 * acts on. Instead it GATES on the standing policy — see `gateFor`.
 *
 * The gate is the honest boundary: under `danger-full-access` the session is
 * already unrestricted and bash runs; under any narrower mode the command is
 * refused with an actionable message rather than silently escaping the
 * sandbox. We never bypass a security boundary the user asked for.
 *
 * @module dsh-gitbash-injector/executor
 */

import { existsSync } from 'node:fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'gitbash-executor'

/** Node's maximum timer delay before setTimeout clamps to 1ms. */
const MAX_TIMER_DELAY_MS = 2147483647

/** Model-friendly environment overrides (same set the shipped executors use). */
const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/**
 * Convert a Git Bash / MSYS drive path such as `/d/foo` into the Windows path
 * `D:\foo` that Node's child_process can use as a cwd or executable path.
 *
 * Only the single-letter drive form is converted (`/d`, `/d/`, `/d/foo`), so
 * MSYS root paths like `/usr/bin` are left alone instead of being mangled into
 * `U:\sr\bin`. UNC and native Windows paths pass through unchanged.
 *
 * @param value - the candidate path.
 * @param platform - target platform, injectable for tests.
 * @returns the converted path, or the input unchanged.
 */
export function toWindowsPath(value, platform = process.platform) {
  if (platform !== 'win32' || typeof value !== 'string' || value.length === 0) return value
  const match = /^\/\s*([A-Za-z])(?:$|\/(.*))$/.exec(value)
  if (match === null) return value
  const drive = match[1].toUpperCase() + ':'
  const rest = match[2] ?? ''
  return rest === '' ? drive + '\\' : drive + '\\' + rest.replace(/\//g, '\\')
}

/**
 * Whether a directory holds a Microsoft `bash.exe` stub (the WSL launcher).
 * Those live under System32 and its WoW64 mirrors; using one as the shell fails
 * with "no installed distribution" when WSL has no distro, so they are skipped.
 *
 * @param dir - a PATH entry.
 * @returns true when the entry is a WSL launcher directory.
 */
export function isWslBashDirectory(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false
  return /(?:\\|\/)(?:system32|sysnative|syswow64)$/i.test(dir)
}

/**
 * Git-for-Windows bash candidates in preference order: the `GIT_BASH` override,
 * the standard install roots, then every non-WSL `bash.exe` on PATH.
 *
 * @param env - environment to read; defaults to the process environment.
 * @returns candidate paths, in preference order.
 */
export function shellPathCandidates(env = process.env) {
  const candidates = [
    env.GIT_BASH,
    env.ProgramFiles === undefined ? undefined : env.ProgramFiles + '\\Git\\bin\\bash.exe',
    env['ProgramFiles(x86)'] === undefined ? undefined : env['ProgramFiles(x86)'] + '\\Git\\bin\\bash.exe',
    env.LOCALAPPDATA === undefined ? undefined : env.LOCALAPPDATA + '\\Programs\\Git\\bin\\bash.exe',
  ]
  if (typeof env.PATH === 'string' && env.PATH.length > 0) {
    for (const dir of env.PATH.split(';')) {
      if (dir.length === 0) continue
      if (isWslBashDirectory(dir)) continue
      candidates.push(dir + '\\bash.exe')
    }
  }
  return candidates
}

/**
 * Resolve the shell executable to spawn. An explicit setting always wins; a
 * POSIX host gets `bash`; on Windows the first existing candidate is used,
 * falling back to the bare name so spawn reports a resolution error.
 *
 * @param explicit - configured `shellPath`, if any.
 * @param env - environment to probe.
 * @param platform - target platform, injectable for tests.
 * @param exists - existence probe, injectable for tests.
 * @returns the executable to spawn.
 */
export function detectShellPath(explicit, env = process.env, platform = process.platform, exists = existsSync) {
  if (platform !== 'win32') {
    return typeof explicit === 'string' && explicit.length > 0 ? explicit : 'bash'
  }
  if (typeof explicit === 'string' && explicit.length > 0) return toWindowsPath(explicit, platform)
  for (const candidate of shellPathCandidates(env)) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (exists(candidate)) return toWindowsPath(candidate, platform)
  }
  return 'bash'
}

/** Reject a non-positive / non-finite numeric setting before it can misfire. */
function positiveNumber(config, label, fallback) {
  const value = config[label] ?? fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(name + ': ' + label + ' must be a positive finite number')
  }
  return value
}

/**
 * Validate and normalise the provider configuration.
 *
 * @param config - raw row config.
 * @param env - environment for shell detection.
 * @param platform - target platform, injectable for tests.
 * @param exists - existence probe, injectable for tests.
 * @returns the resolved configuration.
 */
export function resolveConfig(config, env = process.env, platform = process.platform, exists = existsSync) {
  const source = config ?? {}
  const timeoutMs = positiveNumber(source, 'timeoutMs', 120000)
  const maxTimeoutMs = positiveNumber(source, 'maxTimeoutMs', 600000)
  const graceMs = positiveNumber(source, 'graceMs', 3000)
  for (const [label, value] of [['timeoutMs', timeoutMs], ['maxTimeoutMs', maxTimeoutMs], ['graceMs', graceMs]]) {
    if (value > MAX_TIMER_DELAY_MS) {
      throw new TypeError(name + ': ' + label + ' must be no greater than ' + MAX_TIMER_DELAY_MS)
    }
  }
  if (timeoutMs > maxTimeoutMs) {
    throw new TypeError(name + ': timeoutMs (' + timeoutMs + ') must not exceed maxTimeoutMs (' + maxTimeoutMs + ')')
  }
  return {
    shellPath: detectShellPath(source.shellPath, env, platform, exists),
    cwd: typeof source.cwd === 'string' && source.cwd.length > 0 ? toWindowsPath(source.cwd, platform) : undefined,
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes: positiveNumber(source, 'maxOutputBytes', 64000),
    maxSpillBytes: positiveNumber(source, 'maxSpillBytes', 64 * 1024 * 1024),
    graceMs,
  }
}

/** Fuse upstream cancellation with an identifiable timeout signal. */
function timeoutSignal(upstream, timeoutMs) {
  const timer = new AbortController()
  const id = setTimeout(() => timer.abort(new Error('BASH_TIMEOUT')), timeoutMs)
  return {
    signal: upstream === undefined ? timer.signal : AbortSignal.any([upstream, timer.signal]),
    timedOut: () => timer.signal.aborted,
    dispose: () => clearTimeout(id),
  }
}

/** Project a settled subprocess collector into the shell result shape. */
function finalOutput(reader) {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath === undefined ? {} : { spillPath: read.spillPath },
  }
}

/** Wrap a spawn failure with the shell path and workdir that caused it. */
function spawnError(shellPath, workdir, cause) {
  const detail = cause && cause.message ? cause.message : String(cause)
  return new Error(name + ': failed to start ' + shellPath + ' (workdir: ' + workdir + '): ' + detail, { cause })
}

/**
 * The safety gate: the MSYS runtime cannot start inside the Windows
 * restricted-token sandbox, so commands run only when the standing policy is
 * already unrestricted. This is a refusal, never a silent bypass.
 *
 * @param mode - the standing sandbox mode, or undefined when the deployment
 *   carries no sandbox policy at all.
 * @returns an Error to throw, or undefined to proceed.
 */
export function gateFor(mode) {
  if (mode === undefined) return undefined
  if (mode === 'danger-full-access') return undefined
  return new Error(
    name + ': the Git-for-Windows bash runtime cannot start inside the "' + mode + '" sandbox '
    + '(the MSYS runtime cannot create its signal pipes under the restricted token). '
    + 'Switch this session to full access, or retry the exact command once with '
    + 'sandbox_permissions: "danger-full-access" plus a one-sentence justification.'
  )
}

/**
 * Build the `shell` service object for one agent's isolated realm.
 *
 * @param subprocess - the host subprocess service.
 * @param resolved - resolved configuration.
 * @returns a ShellExecutor-shaped service object.
 */
export function createGitBashShell(subprocess, resolved) {
  const spawnSpec = (spec, argv, stdoutMaxBytes, signal) => ({
    argv,
    cwd: spec.workdir,
    stdio: {
      stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
      stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: resolved.maxSpillBytes } },
      stderr: { maxBytes: resolved.maxOutputBytes, spill: { maxBytes: resolved.maxSpillBytes } },
    },
    graceMs: resolved.graceMs,
    signal,
    env: {
      ...ENV_OVERRIDES,
      ...spec.env,
      ...spec.dshEnv,
    },
  })

  const spawnShell = (spec, stdoutMaxBytes, signal) => {
    try {
      return subprocess.spawn(spawnSpec(spec, [resolved.shellPath, '-lc', spec.command], stdoutMaxBytes, signal))
    } catch (error) {
      throw spawnError(resolved.shellPath, spec.workdir, error)
    }
  }

  return {
    resolve(request = {}) {
      const timeoutMs = Math.min(request.timeoutMs ?? resolved.timeoutMs, resolved.maxTimeoutMs)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(name + ': request.timeoutMs must be a positive finite number')
      }
      const stdoutMaxBytes = request.stdoutMaxBytes ?? resolved.maxOutputBytes
      if (!Number.isFinite(stdoutMaxBytes) || stdoutMaxBytes <= 0) {
        throw new Error(name + ': request.stdoutMaxBytes must be a positive finite number')
      }
      return {
        command: request.command,
        workdir: toWindowsPath(request.workdir ?? resolved.cwd ?? process.cwd()),
        timeoutMs,
        stdoutMaxBytes,
        ...request.signal === undefined ? {} : { signal: request.signal },
        ...request.stdin === undefined ? {} : { stdin: request.stdin },
        ...request.env === undefined ? {} : { env: request.env },
        ...request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv },
        sandboxPolicy: request.sandboxPolicy,
      }
    },

    async run(spec) {
      const refusal = gateFor(spec.sandboxPolicy?.mode)
      if (refusal !== undefined) throw refusal
      const fused = timeoutSignal(spec.signal, spec.timeoutMs)
      try {
        const handle = spawnShell(spec, spec.stdoutMaxBytes, fused.signal)
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          throw spawnError(resolved.shellPath, spec.workdir, error)
        }
        const timedOut = fused.timedOut()
        return {
          ...outcome,
          timedOut,
          aborted: spec.signal !== undefined && spec.signal.aborted && !timedOut,
          timeoutMs: spec.timeoutMs,
          stdout: finalOutput(handle.collected.stdout),
          stderr: finalOutput(handle.collected.stderr),
        }
      } finally {
        fused.dispose()
      }
    },

    start(spec) {
      const refusal = gateFor(spec.sandboxPolicy?.mode)
      if (refusal !== undefined) throw refusal
      const running = spawnShell(spec, resolved.maxOutputBytes, spec.signal)
      const collected = { stdout: running.collected.stdout, stderr: running.collected.stderr }
      let spawnFailureNote
      let stdoutOffset = 0
      let stderrOffset = 0
      const proc = {
        status: 'running',
        exitCode: null,
        signal: null,
        done: running.done.then((outcome) => {
          if (proc.status === 'running') {
            proc.status = (spec.signal && spec.signal.aborted === true) || outcome.signal !== null ? 'killed' : 'completed'
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
        }, (error) => {
          proc.status = 'killed'
          spawnFailureNote = spawnError(resolved.shellPath, spec.workdir, error).message
        }),
        readOutput: () => {
          const out = collected.stdout.readFrom(stdoutOffset)
          const err = collected.stderr.readFrom(stderrOffset)
          stdoutOffset = out.nextOffset
          stderrOffset = err.nextOffset
          const errText = err.text.length > 0 ? err.text : (spawnFailureNote ?? '')
          if (spawnFailureNote !== undefined && err.text.length === 0) spawnFailureNote = undefined
          const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
          return {
            delta: out.text + (errText.length > 0 ? separator + '[stderr]\n' + errText : ''),
            lossy: out.lossy || err.lossy,
            ...out.spillPath === undefined ? {} : { stdoutSpillPath: out.spillPath },
            ...err.spillPath === undefined ? {} : { stderrSpillPath: err.spillPath },
          }
        },
        kill: () => {
          if (proc.status !== 'running') return false
          proc.status = 'killed'
          running.terminate()
          return true
        },
      }
      return proc
    },
  }
}
