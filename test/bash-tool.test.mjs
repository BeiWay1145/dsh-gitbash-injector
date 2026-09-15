import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
const CORDIS = pathToFileURL('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js').href
const { Context } = await import(CORDIS)

const root = new Context()
root.logger = { info: () => {}, warn: (...a) => console.log('WARN', ...a), debug: () => {} }

// Real subprocess stand-in that actually runs the command.
const subprocess = {
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const done = new Promise(res => child.on('close', code => res({ exitCode: code ?? -1, signal: null })))
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: out, lossy: false, nextOffset: out.length }) },
        stderr: { readFrom: () => ({ text: err, lossy: false, nextOffset: err.length }) },
      },
      terminate: () => child.kill(),
    }
  },
}
root.provide('subprocess', subprocess)

let captured = null
root.provide('tools', { register: (t) => { captured = t; return () => {} } })

const agents = []
root.provide('agents', { list: () => agents, get: () => undefined })
const agentCtx = root.isolate({ shell: true })
agents.push({ id: 'a1', ctx: agentCtx })

const mod = await import(pathToFileURL('C:/Users/BeiWay1145/.dsh/plugins/dsh-gitbash-injector/lib/index.js').href)
mod.apply(root, { timeoutMs: 120000 })

console.log('tool name:', captured?.name)
console.log('has sandbox_permissions param:', 'sandbox_permissions' in (captured?.parameters ?? {}))

const exec = { agent: { session: { header: { cwd: process.cwd() } } } }
const run = async (label, cmd) => {
  try {
    const res = await captured.execute({ command: cmd, description: 'test' }, exec)
    console.log(label + ' -> ' + JSON.stringify(res.text.trim()))
  } catch (e) {
    console.log(label + ' -> THREW: ' + String(e.message).slice(0, 120))
  }
}
await run('[bash]', 'echo hello-from-injected-bash')
await run('[jq]', 'echo \'{"x":{"y":7}}\' | jq -c .x.y')
await run('[uname]', 'uname -s')
await run('[exit7]', 'exit 7')
