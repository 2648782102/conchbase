# 目标模式：AI 接手说明

> 本文是中文阅读入口，不是契约事实源。英文仓库文档、`docs/openapi.yaml`、已接受的 ADR 与 `docs/PROJECT_STATUS.json` 共同描述当前事实；本文不新增 API、schema 或产品边界。

## 最终目标状态

海螺 Conchbase 与寄居蟹 Pagurus 的 `1.0.0` 本地优先闭环已经完成，并作为组织能力的执行底座。Conchbase 拥有 Agent 执行、身份与不可变版本、任务状态、持久工作、权限和私有 SQLite；Pagurus 只通过已发布的 47 条 OpenAPI 路径提交意图并读取状态。CLI、IDE 和第三方界面同样是合法客户端。

当前最终目标已提升为**完整组织运行时**：用户只有一个主会话，只跟入口 Agent 对话；入口 Agent 或被授权的招聘 Agent 在 Runtime 边界内动态定义员工 Agent；多个项目并发执行；结果、问题和重要汇报安静回到主会话；项目可归档、撤销活跃授权并在后续重新验证后恢复。

完整目标规格见 [Organization Runtime 最终目标规格](ORGANIZATION_RUNTIME_TARGET.zh-CN.md)。它把 [ADR 0030](decisions/0030-organization-runtime-direction.md) 的产品方向展开为对象、状态机、公开契约、Pagurus 配套能力和验证矩阵。ADR 0031–0034 接受组织领域、动态 Agent/委派、并发/汇报/归档和公开契约边界；ADR 0035–0040 接受内部持久化、执行规划、动态 Agent 投影、公开契约和 Boss-mode 执行桥；[ADR 0041](decisions/0041-boss-mode-product-loop.md) 完成主会话产品闭环。完整组织运行时与 Pagurus 控制台现在都已连接并经过双仓端到端夹具验证。

本轮「目标模式」不重开 `1.0.0`，也不把待定能力伪装成已实现功能。它把接手模型需要立即知道的状态整理为：

- 机器可读现状：[`docs/PROJECT_STATUS.json`](PROJECT_STATUS.json)。
- 有界任务顺序：[`docs/AI_TASK_QUEUE.md`](AI_TASK_QUEUE.md)。
- 开发边界决策：[ADR 0026](decisions/0026-ai-handoff-readiness-development-boundary.md)。
- 契约事实源：[`docs/openapi.yaml`](openapi.yaml)、[`docs/API.md`](API.md)、[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) 与已接受 ADR。
- 完整验证范围：[`docs/VALIDATION_PLAN.md`](VALIDATION_PLAN.md)。
- 远期组织目标：[`docs/ORGANIZATION_RUNTIME_TARGET.zh-CN.md`](ORGANIZATION_RUNTIME_TARGET.zh-CN.md)。

## 立刻能做什么

[ADR 0028](decisions/0028-interface-validation-boundary.md) 已把可直接推进的接口验证切片闭合为可执行夹具：`tests/provider-conformance.test.ts` 使用临时本地 HTTP 服务覆盖当前 provider 兼容形态，不需要真实凭证；Pagurus [ADR 0014](../pagurus/docs/decisions/0014-interface-validation-boundary.md) 同步闭合自动化无障碍与已发布契约夹具。[ADR 0029](decisions/0029-persistence-test-boundary.md) 进一步把持久化测试边界闭合为可执行夹具：`tests/persistence-conformance.test.ts` 覆盖异常退出后的已提交 WAL 状态、增量迁移保留、单实例拒绝与正常重开。它们记录在 `PROJECT_STATUS.json` 的 `validationEvidence` 中，不替代真实供应商一致性、真实浏览器无障碍审计、生产持久化矩阵或多进程支持。

目前 `nextBoundedSlices` 为空。ADR 0058 允许每轮最多 `maxToolCallsPerTurn` 个工具调用（默认 4，上限 8），按顺序执行，每个写工具单独审批；审批恢复会回到同一个循环，因此后续轮次仍可继续调用工具。组织状态机、动态 Agent/委派、并发/汇报/归档、公开契约与双仓端到端夹具已经闭合。受控执行 `1.2.0` 由 [ADR 0043](decisions/0043-controlled-execution-v1.md) 实现为确定性 fake executor；隔离本地执行 `1.3.0` 由 [ADR 0044](decisions/0044-isolated-local-execution-v2.md) 实现为 Runtime 拥有的固定子进程、durable run、重启中断与显式恢复；主会话对话投影 `1.4.0` 由 [ADR 0045](decisions/0045-primary-conversation-projection.md) 实现为只读、有序、bounded 的 Boss 编排 published message stream；独立 Agent 对话 `1.5.0` 由 [ADR 0046](decisions/0046-agent-chat-module.md) 实现为配置 Agent 的一问一答，复用 Agent-backed task 与用户自行配置的 Magpie OpenAI 兼容协议接口；[ADR 0047](decisions/0047-boss-agent-adapter.md) 将老板模式封装为 Agent Chat 中 Runtime 拥有的「老板 Agent」适配器，用户从同一对话入口提交组织意图，但动作仍由 Runtime 裁决；[ADR 0049](decisions/0049-boss-conversation.md) 让老板 Agent 通过同一个用户配置的协议端点进行自然对话，只在合适时提出组织动作，动作仍由 Runtime 校验，且不新增公开路径或 schema；[ADR 0050](decisions/0050-boss-conversation-hardening.md) 进一步把纯聊天与组织写入彻底分离，注入可读组织事实和能力边界，支持真实流式进度、重启恢复与私有 `user_version = 5` Agent Chat 持久化；[ADR 0051](decisions/0051-agent-chat-model-selection.md) 让 Agent 对话在创建时从 Magpie 目录选择并固定模型；[ADR 0053](decisions/0053-agent-loop-v1.md) 实现有界 Agent Loop 与只读内置工具；[ADR 0054](decisions/0054-mcp-provider.md) 接入管理员配置的只读 MCP stdio 工具；[ADR 0056](decisions/0056-skill-provider.md) 接入只读 Skill 指令；[ADR 0057](decisions/0057-tool-approval-and-write-tools.md) 为写工具增加 Runtime 审批与检查点恢复。前三者不产生外部写入；Agent 对话只调用用户配置好的协议端点，不管理上游凭证。持久化测试边界已由 ADR 0029 接受并完成；生产平台矩阵、任意崩溃点恢复、事件保留、多进程写入协议和归一化驱动错误仍属于独立的 ADR 门控方向，不得把当前单进程 SQLite 所有权说成多进程支持。

每项工作都要按 `docs/PROJECT_STATUS.json` 的 `aiEntry.requiredOrder` 阅读：先读 `AGENTS.md`、`docs/AI_HANDOFF.md`、机器可读状态和本文，再读 `docs/AI_DEVELOPMENT.md`、任务队列与英文契约文档。完成后运行 `npm run check`、`npm test`、`npm run build`，并同步更新受影响文档。

## 必须先立 ADR 才能做什么

- 稳定跨进程 SecretHandle、OS keychain、可重放静态加密值和任意外部固定适配器。
- 真实外部 Source、真实 Outbox 外部写入、真实工具执行、MCP/Skill/plugin 安装与生命周期。
- 生产远程配对 UX、云部署、桌面打包、SSE/保留/重连契约、服务端任务分页与实时历史。
- 新 provider adapter、模型驱动组合节点、委派、并发、通用角色注册表、生产审批工作流。
- 从未经单独接受的 schema 生成客户端类型，或在 Pagurus 发明第二套 Runtime schema。

这些方向在 `docs/PROJECT_STATUS.json` 中一律标为 `blockedDirections`，且 `requiresAcceptedAdr` 为 `true`。涉及双仓的契约必须在两个仓库分别接受对应 ADR 后再实现。

## 辩证取舍

过去选择「接手就绪度」而不是立即实现第一个待定能力，是因为当时最强的约束不是功能数量，而是安全与契约边界。现在目标已明确为完整组织运行时，难点进一步变成：让模型在运行时定义组织，同时让 Runtime 保持唯一授权者与唯一写入者。只做多会话或固定角色拓扑会更快，但违背用户只想表达意图、不想维护组织图的产品目标；让模型文本直接成为权限则越过既有安全边界。因此先用 ADR 固定远期目标与契约门，再逐项实现并验证，是当前最稳妥的路径。

## 不变量

- 明文敏感值绝不进入模型上下文、提示词、任务状态、事件、日志、错误、客户端响应、Agent 版本、配置文档或 UI；不提供通用密钥解析器。
- 工具永远不能绕过 Runtime 策略与审批路径执行；Skill 只提供指令，不授予权限。
- 默认只监听 loopback；非回环绑定必须显式开启并通过已批准 token 摘要认证。
- UI 不读写 Conchbase 私有文件或数据库；Conchbase 始终是执行权威。
- 用户自定义 Agent 保持拓扑中立；三层、Router/Worker 等只是例子，不是 schema、默认值或调度规则。
- 已实现、验证证据、待决方向三类事实绝不混写。
- 用户只有一个主会话；ProjectThread 不是第二个用户会话。
- 模型提出 Agent 定义和委派，Runtime 裁决；能力只能收缩，不能扩张。
- 老板/HR/员工只是产品隐喻，不是 schema 枚举或 canonical topology。
- `waiting_on_human` 与所有报告状态必须是结构化事实。

> 本文件由 [ADR 0026](decisions/0026-ai-handoff-readiness-development-boundary.md) 接受为开发边界资料，并由 [ADR 0030](decisions/0030-organization-runtime-direction.md) 提升到完整组织运行时目标；它不是新公开 API 契约，也不使任何 `blockedDirections` 成为已实现行为。
