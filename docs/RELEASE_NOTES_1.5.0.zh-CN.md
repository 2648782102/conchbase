# Conchbase v1.5.0 中文发布说明

> 本文件是独立 Agent 对话模块 `1.5.0` 的中文发布说明。英文仓库文档、`docs/openapi.yaml`、已接受的 ADR 与 `docs/PROJECT_STATUS.json` 仍是契约事实源；本文件不另立 API 或 schema。

- 版本：Conchbase additive `1.5.0` Agent Chat 契约。
- 事实源：[ADR 0046](decisions/0046-agent-chat-module.md)、配对 [Pagurus ADR 0023](../pagurus/docs/decisions/0023-agent-chat-console.md) 与 [OpenAPI](openapi.yaml)。

## 本次发布

- `GET /v1/runtime` 可选发布 `agentChatContract: "1.5.0"` 与 `agentChatPaths: 4`。
- 新增四条 additive 路径：读取可用 Agent、创建会话、读取会话、发送用户消息。
- Agent Chat 固定 `agentId`、`agentRevisionId`、`providerId/modelId` 与 `configurationRevisionId`；发送消息时复用现有 Agent-backed task 与 Magpie/OpenAI-compatible 协议调用真实模型。
- 用户消息与模型回复以 Runtime-published messages 展示，包含 `pending`、`succeeded`、`failed`、`cancelled` 状态与 bounded error。
- 组织主会话 `1.4.0` 仍保持 Boss 编排事实投影，不因本模块改变测试逻辑或产品语义。
- Magpie 只承担协议接口：用户自行在 Magpie 配置模型、供应商、凭证、路由与 app key；Conchbase 不在本模块管理上游凭证或模型目录配置。
- Agent 显示名统一使用中文：动态生成的员工 Agent 会获得中文角色名，已有的 `worker-validator` / `worker-scout` 等英文名在对话与项目视图中显示为中文别名，不改变 `agentId` 或 revision id。
- [ADR 0049](decisions/0049-boss-conversation.md) 让 Runtime 拥有的「老板 Agent」通过同一个用户配置协议端点进行自然对话；老板自行判断何时使用组织能力，Runtime 校验全部动作，公开路径与 schema 不变。`CONCHBASE_MODEL` 作为默认模型，`CONCHBASE_BOSS_MODEL` 可选覆盖。

## 验证

- `tests/agent-chat.test.ts` 使用 credential-free fake provider 覆盖会话创建、真实 Agent task 回复、幂等重放、错误路径、发现字段与 no-private-state 边界。
- `tests/agent-name.test.ts` 覆盖中文显示名与既有英文别名转换。
- 双仓 `npm run check`、`npm test`、`npm run build` 通过；中文文档随发布一并更新。

## 边界

`1.5.0` 是进程内 bounded Agent Chat 状态与单条消息对应单轮 Agent task 的实现；跨进程会话持久化、完整多轮记忆/摘要策略、流式 assistant delta、附件、工具执行与供应商原生 transcript 仍需要单独已接受 ADR。
