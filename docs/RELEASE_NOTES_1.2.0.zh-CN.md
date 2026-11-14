# 海螺 / 寄居蟹 1.2.0 中文发布说明

> 本文件是受控执行 `1.2.0` 的中文发布说明。契约事实源仍是英文仓库文档、`docs/openapi.yaml`、已接受 ADR 与 `docs/PROJECT_STATUS.json`。

## 发布范围

- Conchbase [ADR 0043](decisions/0043-controlled-execution-v1.md) 与 Pagurus [ADR 0020](../pagurus/docs/decisions/0020-controlled-execution-console-v1.md) 实现受控执行 v1。
- additive `1.2.0` 增加 8 条公开路径；冻结的 `1.0.0` 47 条路径和 additive `1.1.0` 18 条路径保持不变。
- 本版本只包含确定性 fake executor：不安装 MCP、不加载 Skill/plugin、不执行宿主工具、不写外部系统、不读取明文密钥。

## 本次发布内容

- 显式 Grant：绑定能力、Agent/Revision、运行时配置、Delegation、Project、WorkItem、Assignment、operation、destination digest、scope/capability、expiry 与 expected version。
- 执行 Request：必须引用 active grant 并使用 expected grant version；只保存 argument digest，不保存原始参数。
- 显式审批：approved 后调用 fake executor 产生 digest-only 结果；rejected 永不执行；stale version 与 idempotency 冲突返回 `409`。
- 撤销与审计：grant 可版本化撤销，历史全部保留；事件覆盖 grant、request、approval、start、success/failure。
- Runtime discovery：`GET /v1/runtime` 可选发布 `executionContract: 1.2.0` 与 `executionPaths: 8`。
- Pagurus「受控执行」工作区：区分 recorded/enabled/granted/approved/running/succeeded/failed/revoked，使用 typed client 提交授权、请求、审批和撤销，不本地计算权限。

## 明确不包含

- 真实 MCP/Skill/plugin 安装、启用、加载、授权与生命周期。
- 宿主工具执行、真实 executor isolation、外部 Source、外部 Outbox 写入、外部副作用。
- 跨进程 SecretHandle 密钥托管、OS keychain、生产密钥保险库。
- SSE、生产远端配对、云部署、桌面打包、生成式客户端类型。

后续实现必须先写新的已接受 ADR，并补齐授权、隔离、审计、崩溃恢复与双仓夹具。

## 验证

- Conchbase 156 tests，Pagurus 98 tests；双仓 `npm run check && npm test && npm run build` 通过。
- `tests/controlled-execution.test.ts` 覆盖 grant 固定身份、stale version、幂等、批准/拒绝、撤销、公开路径、discovery、digest-only 结果与无明文/私有路径泄漏。
- Pagurus `tests/execution-api.test.ts`、`tests/execution-console.test.tsx` 覆盖 typed client、状态词汇、workspace gating 和 published-state-only 面板。

## 中文文档

- [中文快速开始](QUICK_START.zh-CN.md)
- [v1.1.0 中文发布说明](RELEASE_NOTES_1.1.0.zh-CN.md)
- [v1.2.0 中文发布说明](RELEASE_NOTES_1.2.0.zh-CN.md)
- [Pagurus v1.2.0 中文发布说明](../pagurus/docs/RELEASE_NOTES_1.2.0.zh-CN.md)

> 本文件描述当前仓库事实，不替代英文契约文档。
