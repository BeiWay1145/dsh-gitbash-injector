import { toWindowsPath, isWslBashDirectory, detectShellPath, resolveConfig, gateFor } from '../lib/executor.js'

const results = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)))
}

check('drive path /d/foo', toWindowsPath('/d/foo', 'win32'), 'D:\\foo')
check('drive root /d', toWindowsPath('/d', 'win32'), 'D:\\')
check('drive slash /d/', toWindowsPath('/d/', 'win32'), 'D:\\')
check('msys /usr/bin untouched', toWindowsPath('/usr/bin', 'win32'), '/usr/bin')
check('native D:\\x unchanged', toWindowsPath('D:\\x', 'win32'), 'D:\\x')
check('posix host untouched', toWindowsPath('/d/foo', 'linux'), '/d/foo')

check('system32 is wsl', isWslBashDirectory('C:\\Windows\\System32'), true)
check('syswow64 is wsl', isWslBashDirectory('C:\\Windows\\SysWOW64'), true)
check('git bin not wsl', isWslBashDirectory('C:\\Program Files\\Git\\bin'), false)

check('explicit wins', detectShellPath('C:\\custom\\bash.exe', {}, 'win32', () => true), 'C:\\custom\\bash.exe')
check('probes ProgramFiles', detectShellPath(undefined, { ProgramFiles: 'C:\\PF' }, 'win32', (p) => p === 'C:\\PF\\Git\\bin\\bash.exe'), 'C:\\PF\\Git\\bin\\bash.exe')
check('skips wsl on PATH', detectShellPath(undefined, { PATH: 'C:\\Windows\\System32' }, 'win32', (p) => p.endsWith('bash.exe')), 'bash')
check('posix default bash', detectShellPath(undefined, {}, 'linux', () => false), 'bash')

const rc = resolveConfig({}, {}, 'linux', () => false)
check('default timeout 120000', rc.timeoutMs, 120000)
check('default maxOutput 64000', rc.maxOutputBytes, 64000)
check('default grace 3000', rc.graceMs, 3000)
let threw = false
try { resolveConfig({ timeoutMs: -1 }, {}, 'linux', () => false) } catch { threw = true }
check('rejects negative timeout', threw, true)
threw = false
try { resolveConfig({ timeoutMs: 900000, maxTimeoutMs: 600000 }, {}, 'linux', () => false) } catch { threw = true }
check('rejects timeout>max', threw, true)

check('full access passes', gateFor('danger-full-access'), undefined)
check('undefined policy passes', gateFor(undefined), undefined)
check('workspace-write refused', gateFor('workspace-write') instanceof Error, true)
check('read-only refused', gateFor('read-only') instanceof Error, true)

console.log(results.join('\n'))
console.log('---- ' + results.filter(r => r.startsWith('PASS')).length + '/' + results.length + ' passed ----')
