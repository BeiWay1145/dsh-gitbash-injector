# dsh-gitbash-injector

给 **DeepSeek Harness (DSH)** 的 Windows 会话一个真正的 **Git Bash**，
**不新增、不修改任何 agent preset**。

[English](README_EN.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

```
模型调用 bash  ->  jq --version && uname -s
                     jq-1.7.1
                     MINGW64_NT-10.0-26200
```

---

## 为什么需要它

Windows 上 DSH 只装配 **PowerShell** 的 shell seam：`dsh-base` 给 `bash-sandbox`
和 `tool-bash` 都写了 `disabled: process.platform === 'win32'`。

把这两行按 id 打开**并不管用**，有两个互不相干的原因：

1. **PTY** — 内核自带的持久 bash 走 PTY 后端，而 `dsh-subprocess-local`
   在 win32 上不实现它。
2. **沙箱** — Windows ACL 沙箱用 WRITE_RESTRICTED 令牌拉起子进程，
   而 MSYS 运行时在受限令牌内**起不来**。它建不了 signal pipe，直接死掉：

   ```
   bash: *** fatal error - couldn't create signal pipe, Win32 error 5
   ```
   （退出码 `0xC0000142` / `STATUS_DLL_INIT_FAILED`）

   本机实测：`Git\bin\bash.exe` 与 `Git\usr\bin\bash.exe` **两个都一样**。

本插件绕开这两个障碍：在**宿主平面**为每个 agent 提供自己的 shell 服务，
放在一个隔离 realm 后面——这正是内核自带预设对自己服务做的事。

## 工作原理

```js
ctx.on('agent/created', ({ agent }) => {
  const scoped = agent.ctx.isolate('shell')        // 把服务名隔离进私有 realm
  scoped.provide('shell', gitBashExecutor)         // 用 Git Bash 而不是 pwsh
  scoped.tools.register({ name: 'bash', ... })     // 只落进这个 agent 的层
})
```

几个反直觉但关键的细节：

- **`isolate('shell')` 收的是字符串（服务名）**。DSH 规定宿主只能有一个
  `ctx.shell` 提供者，所以跑第二个必须把名字隔离进子 realm。
  传对象会隔离一个名为 `"[object Object]"` 的属性，随后的 `provide`
  会以 `service "shell" has been registered at <SandboxPwshExecutor>` 失败。
- **工具 schema 必须是真的 JSON Schema**。`tools.register` 把 `parameters`
  **原样转发**给 provider，所以内核自带工具用的那种逐属性 `required: true` 写法
  会被拒：`Invalid schema for function 'bash'`。
  那个形状只有经 `defineTool()` 编译才合法，而插件在 kernel 的 `node_modules`
  之外无法 import 它。

## 安全性：诚实的边界

提供者**故意不声明 `sandboxMode`**——它不受限，声称受限就是撒谎，
而工具层会照着这个声明行动。

取而代之的是**门控**：

| 会话策略 | 行为 |
|---|---|
| `danger-full-access` | 放行 |
| 无策略（部署未装配沙箱） | 放行 |
| `workspace-write` / `read-only` | **拒绝**，并给出可操作指引 |

拒绝而非静默绕过你要求的安全边界。工具同时暴露 `sandbox_permissions` +
`justification`，让模型能在有审批的会话里走正常流程申请单次放宽。

> **子代理里审批是禁用的**——升级会被自动拒绝。
> 工具描述已指引模型在那种场景改用 `pwsh`（它受沙箱约束，任何策略下都能跑）。

## 安装

```powershell
cd $env:USERPROFILE\.dsh\profiles\<你的 profile>
pnpm add "link:<本仓库路径>"
```

然后把 `"dsh-gitbash-injector"` 加进该 profile 的 `package.json` 里的
`dsh.profile.bundles`，跑一次 `pnpm install`，重启 DSH。

### 四个实测踩过的坑

**1. bundle 的 patch 不能是空数组。**
bundle 必须**自己 insert 自己那一行**。写成 `[]` 能通过
`declares no dsh.bundle` 检查，但**静默不挂载**——无报错，插件永不运行。

**2. 包名必须进 `dsh.profile.bundles`。**
只写进 `dependencies` 会以 `profile bundle "..." declares no dsh.bundle` 启动失败。

**3. 用 `link:` 而不是 `file:`。**
pnpm 对 `file:` 本地依赖是**拷贝**而非链接，所以改源 `package.json` 不生效
（读出来是 `null`）。

**4. profile 层只能写 config，不能再 `insert`。**
bundle 层已经插入了那一行；重复插入会以 `duplicate loader entry id` 中止启动。

### 绝对不要 disable `pwsh-sandbox`

win32 上它是**唯一的**宿主 `ctx.shell` 提供者。关掉它会让
`dsh-permission-presets` 永远等 `shell` 服务，DSH 启动失败：

```
@deepseek-ai/dsh-permission-presets: pending (waiting for service: shell)
dsh: 1 entry did not activate
```

本插件与它**并存**——隔离 realm 买的就是这一点。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `shellPath` | 自动探测 | 显式路径优先；也认 `GIT_BASH` 环境变量 |
| `timeoutMs` / `maxTimeoutMs` | `120000` / `600000` | 单次超时与上限 |
| `maxOutputBytes` / `maxSpillBytes` | `64000` / `67108864` | 输出保留量、spill 文件上限 |
| `graceMs` | `3000` | 终止宽限期 |
| `verbose` | `false` | 把每次注入决策打到 host logger |

**shell 探测顺序**：`GIT_BASH` → `ProgramFiles`、`ProgramFiles(x86)`、`LOCALAPPDATA`
下的标准安装目录 → PATH 上每个非 WSL 的 `bash.exe` → 兜底裸 `bash`。
`System32`/`SysWOW64` 下的 `bash.exe` 是 **WSL 启动器**（不是真 bash），会被跳过。

**`workdir`** 接受原生路径或 Git Bash 盘符路径：`/d/foo` 会转成 `D:\foo`。
`/usr/bin` 这类 MSYS 根路径保持不变（否则会被误转成 `U:\sr\bin`）。

## 验证

以下全部在真实 DSH 实例上实测，不是从源码推断的。

| 场景 | 结果 |
|---|---|
| **PTC 预设**（默认）经 `run_code` 调 `tools.bash` | 可用；工具出现在生成的 SDK 声明里 |
| PTC + `workspace-write` | 门控拒绝 → 模型升级 → `jq-1.7.1` / `MINGW64_NT-10.0-26200` |
| PTC + `danger-full-access` | **首次调用即成功**，无需升级 |
| `standard` / `cordis` 预设 | catalog 里含 `bash` |
| `minimal` 预设 | 正好补上空缺——该预设 win32 上本就禁用了自己的持久 shell |
| 3 个会话并发 | 各自独立注入，零冲突 |
| 会话第二轮对话 | 再次注入生效 |
| **子代理**（受限策略下） | 工具存在但升级被拒（DSH 策略）→ 回退到 `pwsh` |

有 4 个 bug **只在真实会话才暴露**，均已修复：

| 症状 | 根因 |
|---|---|
| 插件加载了但从不注入 | 守卫问「是否解析到 shell」——而宿主 PowerShell 执行器总是能解析到，所以永远拒绝 |
| `service "shell" has been registered` | `isolate()` 收字符串，不是对象 |
| `Invalid schema for function 'bash'` | 参数必须是真 JSON Schema |
| 升级重试仍然同样失败 | 执行器读会话固定策略，忽略了每次调用的 `sandbox_permissions` |

## 测试

```sh
node test/executor.test.mjs    # 22 用例：路径转换、WSL 跳过、探测、配置校验、门控
node test/guard.test.mjs       #  8 用例：注入判定表
node test/schema.test.mjs      #  8 用例：参数必须是真 JSON Schema
node test/injection.test.mjs   # 真实 cordis：isolate + provide + 注册
node test/bash-tool.test.mjs   # 端到端：真跑 Git Bash + jq + 退出码
```

## 环境要求

- **Windows** 上的 DSH（DeepSeek Harness）
- [Git for Windows](https://git-scm.com/download/win) —— 默认期望在
  `C:\Program Files\Git`，或用 `shellPath` / `GIT_BASH` 指定
- 只用 Node 内置模块，**无运行时依赖**

POSIX 上插件**故意不生效**：那边的内核自带 bash 行本来就能用。

## 卸载

从 profile 的 `package.json` 里移除 `dsh.profile.bundles` 与 `dependencies` 中的
`dsh-gitbash-injector`，跑 `pnpm install`，重启 DSH。

## 相关文档

- [CHANGELOG.md](CHANGELOG.md) —— 版本变更
- [docs/plugin-authoring-findings.md](docs/plugin-authoring-findings.md) —— **编写 DSH 插件前值得先读的 10 条实测事实**（PTC 双事件族、`isolate()` 签名、schema 原样透传、静默不挂载等），每条都标注核验状态

## 许可

MIT —— 见 [LICENSE](LICENSE)。
