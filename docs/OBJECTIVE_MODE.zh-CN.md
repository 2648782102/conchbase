# 目标模式：AI 接手说明

> 本文是中文阅读入口，不是契约事实源。英文仓库文档、`docs/openapi.yaml`、已接受的 ADR 与 `docs/PROJECT_STATUS.json` 共同描述当前事实；本文不新增 API、schema 或产品边界。

## 最终目标状态

海螺 Conchbase 与寄居蟹 Pagurus 的 `1.0.0` 本地优先闭环已经完成。Conchbase 拥有 Agent 执行、身份与不可变版本、任务状态、持久工作、权限和私有 SQLite；Pagurus 只通过已发布的 47 条 OpenAPI 路径提交意图并读取状态。CLI、IDE 和第三方界面同样是合法客户端。

本轮「目标模式」不重开 `1.0.0`，也不把待定能力伪装成已实现功能。它把接手模型需要立即知道的状态整理为：

- 机器可读现状：[`docs/PROJECT_STATUS.json`](PROJECT_STATUS.json)。
- 有界任务顺序：[`docs/AI_TASK_QUEUE.md`](AI_TASK_QUEUE.md)。
- 开发边界决策：[ADR 0026](decisions/0026-ai-handoff-readiness-development-boundary.md)。
- 契约事实源：[`docs/openapi.yaml`](openapi.yaml)、[`docs/API.md`](API.md)、[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) 与已接受 ADR。
- 完整验证范围：[`docs/VALIDATION_PLAN.md`](VALIDATION_PLAN.md)。

## 立刻能做什么

在保持公开契约不变的前提下，当前可直接推进的一类有界工作是接口验证：

1. 接口验证：增加不依赖真实凭证的 provider 一致性夹具和自动化无障碍夹具；它不能替代已有的确定性 HTTP 验收。

持久层验证在 `docs/PROJECT_STATUS.json` 中标为 `status: "proposal"` 且 `requiresAcceptedAdr: true`：必须先单独接受持久化测试边界 ADR，再增加受支持平台矩阵、WAL 崩溃恢复、保留与迁移夹具；不得把当前单进程 SQLite 所有权说成多进程支持。

每项工作都要按 `docs/PROJECT_STATUS.json` 的 `aiEntry.requiredOrder` 阅读：先读 `AGENTS.md`、`docs/AI_HANDOFF.md`、机器可读状态和本文，再读 `docs/AI_DEVELOPMENT.md`、任务队列与英文契约文档。完成后运行 `npm run check`、`npm test`、`npm run build`，并同步更新受影响文档。

## 必须先立 ADR 才能做什么

- 稳定跨进程 SecretHandle、OS keychain、可重放静态加密值和任意外部固定适配器。
- 真实外部 Source、真实 Outbox 外部写入、真实工具执行、MCP/Skill/plugin 安装与生命周期。
- 生产远程配对 UX、云部署、桌面打包、SSE/保留/重连契约、服务端任务分页与实时历史。
- 新 provider adapter、模型驱动组合节点、委派、并发、通用角色注册表、生产审批工作流。
- 从未经单独接受的 schema 生成客户端类型，或在 Pagurus 发明第二套 Runtime schema。

这些方向在 `docs/PROJECT_STATUS.json` 中一律标为 `blockedDirections`，且 `requiresAcceptedAdr` 为 `true`。涉及双仓的契约必须在两个仓库分别接受对应 ADR 后再实现。

## 辩证取舍

选择「接手就绪度」而不是立即实现第一个待定能力，是因为当前最强的约束不是功能数量，而是安全与契约边界：密钥托管、外部副作用、工具隔离和远程认证都要求新的威胁模型、持久化语义和公开契约。弱模型若从历史路线图中自行挑一项，最容易越过这些边界。把状态、证据与待决方向分离，并让 guardrails 可执行检查，能让下一步开发既明确又不改变 `1.0.0`。

## 不变量

- 明文敏感值绝不进入模型上下文、提示词、任务状态、事件、日志、错误、客户端响应、Agent 版本、配置文档或 UI；不提供通用密钥解析器。
- 工具永远不能绕过 Runtime 策略与审批路径执行；Skill 只提供指令，不授予权限。
- 默认只监听 loopback；非回环绑定必须显式开启并通过已批准 token 摘要认证。
- UI 不读写 Conchbase 私有文件或数据库；Conchbase 始终是执行权威。
- 用户自定义 Agent 保持拓扑中立；三层、Router/Worker 等只是例子，不是 schema、默认值或调度规则。
- 已实现、验证证据、待决方向三类事实绝不混写。

> 本文件由 [ADR 0026](decisions/0026-ai-handoff-readiness-development-boundary.md) 接受为开发边界资料；它不是新公开 API 契约，也不使任何 `blockedDirections` 成为已实现行为。
