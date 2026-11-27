# 验证矩阵与回归记录

本文档说明 Pi Server v2.0 的四层验证体系、离线隔离自动化测试套件、脱敏可视化夹具以及真机端到端验收脚本。

## 四层验证入口

日常开发与双平台 CI（macOS Seatbelt + Ubuntu Bubblewrap）默认只运行 L1 + L2 离线门禁，不消耗模型额度，也不触碰真实用户数据：

```bash
# L1 静态语法、行数上限（<500 / <450）与零行首注释门禁
npm run check

# L2 全量离线隔离测试（原 100 项 + M1/M2/M3 全部新增测试）
npm test

# CLI 八维体检与无副作用预览
node bin/pi-server.js doctor --json
node bin/pi-server.js install --dry-run

# L3 脱敏可视化演示夹具（供浏览器明暗双主题 + 375px 窄屏验收）
node scripts/seed-demo-state.js --dir=/tmp/pi-demo
PI_SERVER_STATE_DIR=/tmp/pi-demo node bin/pi-server.js dashboard

# L3/L4 真机多模型端到端验收脚本（隔离临时仓库）
node scripts/verify-v2.js       # v2.0 验收闭环 + cross_review + council 真机实测
npm run verify:communication    # 断线重连、阻塞提问与请求上限实测
npm run verify:live             # 多模型并行修改、兄弟通信与临时模型切换
node scripts/verify-codex.js    # 真实 Codex CLI 调度实测（可用 PI_VERIFY_CODEX_MODEL 覆盖）
node scripts/verify-opencode.js # 真实 OpenCode CLI 调度实测
```

## 自动化测试覆盖模块

| 测试文件 | 验证重点 |
| --- | --- |
| `tests/acceptance-checks.test.js` | **v2.0 机械验收闭环**：全过转 `completed-verified`、失败转 `completed-unverified` + `send_message` 修复重验、整批超时与 `strict` 沙箱 `sandboxHint`、验收中 `interrupt`/`closeAgent` 秒中止零死锁、MCP Task `failed`+`isError` 映射、`readOnly` 同目录多路并发 |
| `tests/orchestration.test.js` | **v2.0 高层协作原语**：`consult`（只读归档、`runs/*.json`、`contextFiles` 越界拦截、`dryRun`、非 JSON 降级、取消清理）、`council`（脏目录 3 路并发、`cleanProfile`、`partial`/低于 `minQuorum`、容量/`budgetCapUsd`/`unknownPricingModels`）、`cross_review`（未跟踪新文件 diff、同模型拒审、空 diff 零成本短路、`blocker` 强升、畸形 Fail-Closed）与 MCP 端到端调用 |
| `tests/backend-hardening.test.js` | **v2.0 后端 8 项加固**：`bwrap` 普通文件 `/dev/null` 掩蔽防 `ENOTDIR`、跨分片中文 UTF-8 与 200KB 请求体无乱码、重连保留 `parentInfo`、三零条件热替换、`spawn` 失败清 Map、`interruptedRun` 防迟到 `agent_settled` 覆盖、`manager.read()` 内存尾窗一致 |
| `tests/cli-install.test.js` | **v2.0 CLI 与安装稳健性**：`fnm_multishells` default/pinned 别名软链稳定化（不穿透 `bin/pi`）、MOTD 抗噪、`install --dry-run` 零副作用与实装校验、`doctor --json` 8 项体检与零密钥泄露、`ask --dry-run` 端到端、`serve` 的 `stdout` 纯净 JSON-RPC 帧 |
| `tests/dashboard.test.js` | 只读快照不抢占归属、同源与令牌防护、共享单实例 SSE 广播、`/api/runs` & `/api/runs/:runId`、`/api/system`（`sandbox` + 四端 `hosts`）、`/logo.svg` 与全部 ES 模块静态路由、单文件行数上限与零行首注释门禁 |
| `tests/antigravity.test.js` & `tests/opencode.test.js` | Antigravity 与 OpenCode 会话绑定、单调游标排干去重、钩子与 JSONC 保留注释安装/卸载、四端凭据沙箱隔离 |
| `tests/tool-sandbox.test.js` & `tests/linux-sandbox.test.js` | macOS Seatbelt / Linux & WSL2 `bwrap` 三档读写、符号链接越界拦截、凭据与控制状态目录隔离、禁网与后代进程组终止 |
| `tests/mcp.test.js` & `tests/mcp-tasks.test.js` | 真实 MCP SDK 客户端发现全部 **27 个工具**、标准 Tasks 状态机、取消与 TTL 清理、资源订阅 |
| `tests/callbacks.test.js`、`tests/communication.test.js`、`tests/controller.test.js`、`tests/model-settings.test.js`、`tests/quota*.test.js`、`tests/reliable-messages.test.js`、`tests/workspace.test.js`、`tests/lifecycle.test.js`、`tests/recovery.test.js`、`tests/benchmark-profile.test.js` | 原有 100 项协议、通信回执、独立控制器、模型设置脱敏、额度查询、工作树隔离、洁净评测模式全量回归基线 |

## 关键里程碑验收摘要

1. **v2.0 M1–M3 全量离线与双平台 CI 门禁**：`npm run check` 与 `npm test`（原 100 项零回归 + M1/M2/M3 全部新增测试）在 macOS Seatbelt 与 Ubuntu Bubblewrap 双环境全绿，单文件体积上限与零行首注释卫生检查全通过。
2. **浏览器桌面 + 375px 窄屏视觉验收**：通过 `scripts/seed-demo-state.js` 构造脱敏四端+会诊+审查+验收夹具，验证桌面 `1440×900` 与窄屏 `375×812` 明暗双主题零控制台报错、零横向溢出，全部新视图与内联 Diff 联动正常。
3. **四端宿主与真机模型实测**：覆盖 Antigravity、Claude Code、Codex、OpenCode 四端安装与回调唤醒，以及 `verify-v2.js` 真机验收闭环、跨模型审查与多模型委员会并发运行。
