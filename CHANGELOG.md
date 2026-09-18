# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-09-15

首次发布。

### 新增

- 为 Windows 上的 DSH 会话注入 Git Bash shell，**不新增、不修改任何 agent preset**。
- 通过 `ctx.on('agent/created', ...)` 在每个 agent 自己的隔离 realm 内提供 `shell` 服务，
  并把 `bash` 工具注册进该会话的层。
- 自动探测 Git for Windows：`GIT_BASH` 环境变量 → 标准安装目录 → PATH 上非 WSL 的 `bash.exe`。
- Git Bash 盘符路径转换：`/d/foo` → `D:\foo`（MSYS 根路径如 `/usr/bin` 保持不变）。
- 沙箱门控：仅在 `danger-full-access`（或部署未装配沙箱）下放行，
  受限策略下**拒绝**并给出可操作指引，不静默绕过边界。
- **shell 优先级指引**：工具描述与一条 system-prompt section（order 999）共同声明
  Windows 上优先用 bash，pwsh 作为降级路径。

### 修复

以下四个 bug 都**只在真实会话中暴露**，单元测试全绿时依然存在：

- **插件加载了但从不注入。** 注入守卫问的是「是否解析到某个 shell」，
  而宿主的 PowerShell 执行器（`SandboxPwshExecutor`）是宿主平面服务、每个 agent 都能解析到，
  所以守卫**永远拒绝**。改为判断「是否已有 **bash** 提供者」——读执行器自己的
  `bashPath` / `shellPath` / `pwshPath` 字段。
- **`service "shell" has been registered`。** `ctx.isolate(name, label)` 收的是**字符串**服务名。
  传对象会隔离一个名为 `"[object Object]"` 的属性，`shell` 根本没被隔离，
  随后的 `provide` 与宿主执行器撞车。
- **`Invalid schema for function 'bash'`。** `tools.register` 把 `parameters` **原样透传**给 provider，
  所以必须已是标准 JSON Schema。内核自带工具用的逐属性 `required: true` 写法
  只有经 `defineTool()` 编译才合法，而插件在 kernel 的 `node_modules` 之外无法 import 它。
- **按指引升级却仍然失败。** 执行器读的是会话固定策略，**没有应用**模型传来的
  `sandbox_permissions`，使升级路径形同虚设——比不提供更糟，因为指引了模型去用。

### 验证

在真实 DSH 实例上实测（非源码推断）：PTC（默认）、standard、cordis、minimal 四个预设；
并发会话隔离；多轮对话再注入；`danger-full-access` 下首次调用即成功；
`workspace-write` 下门控拒绝 + 模型按指引升级成功。

### 已知限制

- **子代理在受限策略下无法使用 bash。** DSH 对子代理禁用审批，
  `sandbox_permissions` 升级会被自动拒绝。工具描述已指引模型在那种场景回退到 `pwsh`。
- 未在 POSIX 上测试——插件在那边**故意不生效**（内核自带的 bash 行本来就能用）。

[Unreleased]: https://github.com/BeiWay1145/dsh-gitbash-injector/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BeiWay1145/dsh-gitbash-injector/releases/tag/v0.1.0
