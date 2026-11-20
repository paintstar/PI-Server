# 参与贡献指南

欢迎为 Pi Subagents 提交缺陷修复、宿主适配、服务商额度解析或面板体验改进。动笔前请先阅读本文档，了解本地验证步骤与代码规范。

## 本地开发环境

开发与完整测试需要以下环境：

- **操作系统**：macOS（内置 `/usr/bin/sandbox-exec`）或 Linux / Windows WSL2（需安装 `bubblewrap`：`sudo apt-get install -y bubblewrap`）
- **Node.js**：`>= 22.19.0`
- **Pi CLI**：`>= 1.0.2`（仅运行 `npm test` 时无需配置真实模型 Key，测试使用 `tests/helpers/fake-pi.js` 隔离模拟进程）

克隆仓库并运行全量检查：

```bash
git clone https://github.com/paintstar/PI-Server.git
cd PI-Server
npm ci --ignore-scripts
npm run check
npm test
```

## 代码与模块约定

为了让后续维护者和 AI 代理都能快速读懂并安全修改代码，合并前必须通过的检查包含以下硬性要求：

1. **模块体积上限**：`src/*.js`、`scripts/*.js` 单文件不超过 500 行，`dashboard/*.js` 单文件不超过 450 行（由 `tests/dashboard.test.js` 自动断言）。
2. **代码自解释**：前端与重构后的服务文件不写行内注释和文档字符串，用清晰的命名、参数校验和单元测试表达意图，把改动原因写进 Git 提交信息。
3. **凭据与状态安全**：涉及配置文件写入一律使用 `atomicWriteJson` 原子替换并保持 `0600` 权限；禁止在日志、测试快照、截图或接口返回中暴露真实 API Key、OAuth Token 或个人目录路径。
4. **协议输出纯净**：`src/server.js` 的标准输出（`stdout`）只用于 MCP JSON-RPC 通信，诊断信息一律写往 `stderr`。

## 提交流程

1. 从 `main` 分支拉出特性或修复分支，一次提交只包含一件完整的事。
2. 为新增行为或修复的边界条件补充对应测试（位于 `tests/*.test.js`），确保 `npm run check && npm test` 全部通过。
3. 如修改了 `dashboard/` 下的界面或交互，运行 `npm run dashboard` 在浏览器同时检查暗色/浅色主题与 375px 窄屏抽屉表现。
4. 提交 Pull Request，在描述中写明解决的问题、改动要点与实际运行的验证命令。
