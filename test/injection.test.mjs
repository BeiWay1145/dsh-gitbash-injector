import { pathToFileURL } from 'node:url'
const CORDIS = pathToFileURL('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js').href
const { Context } = await import(CORDIS)

const root = new Context()
const logged = []
root.logger = { info: (...a) => logged.push('INFO ' + a.map(String).join(' ')), warn: (...a) => logged.push('WARN ' + a.map(String).join(' ')), debug: () => {} }

root.provide('subprocess', { spawn() { throw new Error('spawn not expected') } })

const registered = []
root.provide('tools', { register: (t) => { registered.push(t.name); return () => {} } })

const agents = []
root.provide('agents', { list: () => agents, get: () => undefined })

const agentCtx = root.isolate({ shell: true })
agents.push({ id: 'test-agent', ctx: agentCtx })

const MOD = pathToFileURL('C:/Users/BeiWay1145/.dsh/plugins/dsh-gitbash-injector/lib/index.js').href
const mod = await import(MOD)

try {
  mod.apply(root, { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe', timeoutMs: 120000 })
  console.log('apply() OK')
} catch (e) {
  console.log('apply() THREW:', String(e).slice(0, 400))
}
console.log('registered tools:', JSON.stringify(registered))
console.log('logger:', JSON.stringify(logged, null, 1))
