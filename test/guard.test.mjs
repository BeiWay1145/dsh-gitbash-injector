import { resolvesBash } from '../lib/index.js'
const cases = [
  ['pwsh executor (host)', { run(){}, pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', sandboxMode: 'workspace-write' }, false],
  ['bash sandbox executor', { run(){}, bashPath: '/usr/bin/bash', sandboxMode: 'workspace-write' }, true],
  ['gitbash (shellPath)', { run(){}, shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }, true],
  ['bash without .exe', { run(){}, shellPath: 'C:\\Program Files\\Git\\usr\\bin\\bash' }, true],
  ['undefined shell', undefined, false],
  ['null shell', null, false],
  ['no path field', { run(){}, sandboxMode: 'workspace-write' }, false],
  ['not an executor', { pwshPath: 'x' }, false],
]
let pass = 0
for (const [label, shell, want] of cases) {
  const got = resolvesBash(shell)
  const ok = got === want
  if (ok) pass++
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' -> got ' + got + ' want ' + want))
}
console.log('---- ' + pass + '/' + cases.length + ' passed ----')
