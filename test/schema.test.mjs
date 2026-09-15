/**
 * The `bash` tool's parameter schema must be REAL JSON Schema.
 *
 * Regression guard for a bug found only in a live session: `tools.register`
 * passes `parameters` straight through to the provider (ToolRuntime.schemaOf),
 * so the authoring shape the kernel's own tools use — a per-property
 * `required: true` — reaches the wire verbatim and the request is rejected with
 * "Invalid schema for function 'bash'". In-session that surfaces as an empty
 * assistant turn and a failed tool call, which is easy to misread as a model
 * problem rather than a schema problem.
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const APP = 'D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app'
const { assertSupportedJsonSchema } = await import(
  pathToFileURL(APP + '/node_modules/@deepseek-ai/dsh-tools/lib/index.js').href
)

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const cases = []

// The plugin's registered schema, reconstructed from source so it cannot drift.
const start = source.indexOf('parameters: {')
const end = source.indexOf('output: {', start)
cases.push(['parameters block located', start !== -1 && end !== -1, true])

const block = source.slice(start + 'parameters:'.length, end).trim().replace(/,$/, '')
let parameters
try {
  // eslint-disable-next-line no-eval -- this repo's own source, not user input
  parameters = eval('(' + block + ')')
  cases.push(['parameters parses as an object', typeof parameters, 'object'])
} catch (e) {
  cases.push(['parameters parses as an object', 'parse error: ' + String(e.message).slice(0, 60), 'object'])
}

if (parameters !== undefined) {
  cases.push(['kernel validator accepts it', (() => {
    try { assertSupportedJsonSchema(parameters); return true } catch { return false }
  })(), true])
  cases.push(['type is object', parameters.type, 'object'])
  cases.push(['required is an ARRAY', Array.isArray(parameters.required), true])
  cases.push(['requires command', Array.isArray(parameters.required) && parameters.required.includes('command'), true])
  const props = Object.values(parameters.properties ?? {})
  cases.push(['no property carries required:true', props.some((p) => p && 'required' in p), false])
  cases.push(['exposes sandbox_permissions', 'sandbox_permissions' in (parameters.properties ?? {}), true])
}

let pass = 0
for (const [label, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(got)))
}
console.log('---- ' + pass + '/' + cases.length + ' passed ----')
