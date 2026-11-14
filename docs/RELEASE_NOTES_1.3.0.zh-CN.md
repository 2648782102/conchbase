# 海螺 / 寄居蟹 1.3.0 中文发布说明

> 本文件是隔离本地执行 `1.3.0` 的中文发布说明。契约事实源仍是 `docs/openapi.yaml`、已接受 ADR 与两仓 `PROJECT_STATUS.json`。

## 发布范围

- Conchbase [ADR 0044](decisions/0044-isolated-local-execution-v2.md) 与 Pagurus [ADR 0021](../pagurus/docs/decisions/0021-isolated-execution-console-v2.md) 实现隔离本地执行 v2。
- additive 新增 8 条 execution run 路径；`1.0.0` 47 条、`1.1.0` 18 条、`1.2.0` 8 条路径保持不变。
- Runtime discovery 保留 `executionContract: 1.2.0` / `executionPaths: 8`，新增可选 `executionRunContract: 1.3.0` / `executionRunPaths: 8`。

## 本次发布内容

- Runtime 拥有固定 Node 子进程的 isolated local executor；子进程使用固定脚本、固定 argv、封闭环境变量、两秒超时和固定 stdout 形状。
- 操作白名单仅 `hash`、`echo_length`、`fixed_matrix`；不接受任意命令、路径、URL、网络、密钥、文件读写或用户指定 npm 包。
- durable execution run 包含 queued/running/succeeded/failed/cancelled/interrupted、attempt、expectedVersion、workerPidDigest、exitCode、resultDigest、errorDigest、时间戳和 idempotency key。
- 显式 `start`、`cancel`、`recover`；重启会把 running 标记 interrupted，恢复保留历史并递增 attempt。
- 审计事件覆盖 created/started/succeeded/failed/cancelled/interrupted/recovered，全部只包含 opaque id、摘要、状态与有界标量。
- Pagurus 受控执行工作区新增隔离执行 Runs、Run 审计事件、创建/启动/取消/恢复交互，并显式区分所有 run 状态。

## 明确不包含

- 真实 MCP/Skill/plugin 安装、启用、加载、授权与生命周期。
- 任意宿主工具执行、外部 Source、真实 Outbox 外部写入、外部系统副作用。
- 跨进程 SecretHandle 密钥托管、OS keychain、生产密钥保险库。
- SSE、生产远端配对、云部署、桌面打包、生成式客户端类型。

后续实现必须先写新的已接受 ADR，并补齐外部隔离、崩溃安全副作用、真实生命周期与双仓夹具。

## 验证

- Conchbase 160 tests，Pagurus 100 tests；双仓 `npm run check && npm test && npm run build` 通过。
- `tests/isolated-execution.test.ts` 覆盖 approved request / active grant、隔离子进程、stale version、幂等冲突、cancel/recover、重启中断、1.3.0 discovery、adapters 与无明文/私有路径泄漏。
- Pagurus `tests/execution-run-api.test.ts` 与 `tests/execution-console.test.tsx` 覆盖 typed run client、状态词汇、run 面板与 published-state-only 边界。

## 中文文档

- [中文快速开始](QUICK_START.zh-CN.md)
- [v1.2.0 中文发布说明](RELEASE_NOTES_1.2.0.zh-CN.md)
- [v1.3.0 中文发布说明](RELEASE_NOTES_1.3.0.zh-CN.md)
- [Pagurus v1.3.0 中文发布说明](../pagurus/docs/RELEASE_NOTES_1.3.0.zh-CN.md)

> 本文件描述当前仓库事实，不替代英文契约文档。
