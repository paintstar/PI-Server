# 安全说明与漏洞上报

本文档说明 Pi Subagents 的本机安全边界、凭据保护机制与安全漏洞私密上报方式。

## 安全边界设计

Pi Subagents 只面向单机本地开发环境运行，通过以下四层边界隔离模型工具调用与外部访问：

1. **进程级操作系统沙箱（macOS Seatbelt `/usr/bin/sandbox-exec` / Linux & WSL2 `bubblewrap`）**：默认 `strict` 档位下，子代理的文件读写与 shell 子进程受操作系统内核规则约束，只能写入声明的 `ownedPaths` 与私有临时目录；不支持沙箱后端的平台默认拒绝启动受限子代理（fail-closed）。
2. **凭据零继承与脱敏展示**：模型 API Key 与 OAuth 令牌只由受信任的 Pi 主进程读取，不会注入子代理的 shell 环境变量；`strict` 与 `dev` 模式下均禁止子代理读写 `~/.pi`、`~/.codex`、`~/.ssh`、`~/.config/opencode`、`~/.local/share/opencode` 及管理进程状态目录。Web 调度台与全部 MCP 工具只返回脱敏后的凭据状态（例如 `sk-••••8821`），写 `~/.pi/agent/auth.json` 和 `models.json` 前先以 `0600` 权限原子备份。
3. **本机私密通信与同源保护**：管理进程只监听 `0600` 权限的私密 Unix Domain Socket；Web 调度台只绑定 `127.0.0.1`，校验 `Host` 头、`HttpOnly; SameSite=Strict` 查看 Cookie 与写接口的同源及自定义请求头，拒绝跨站读取与远程连接。
4. **不在能力范围内的事项**：本工具依赖本机已安装的受信任 Pi CLI 及其内置模型通道，不隔离恶意第三方 Pi 扩展，也不提供 CPU、内存或磁盘配额隔离；显式开启 `bypass` 沙箱档位会向该子代理放开本机凭据目录读写权限，仅应在完全受信任的任务中使用。

## 漏洞私密上报

如果你发现沙箱越界、跨会话接管、Web 调度台跨站访问或明文凭据泄露问题，请勿在公开 Issue 中披露细节。请直接通过 GitHub 私密安全通告提交复现步骤与影响范围：

- 上报地址：https://github.com/paintstar/PI-Server/security/advisories/new

维护者收到报告后会复现验证、发布修复补丁并在更新说明中致谢。
