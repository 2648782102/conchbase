# Conchbase v1.7.0 中文发布说明

> 本文件是 Agent Chat `1.7.0` 的中文发布说明。英文仓库文档、`docs/openapi.yaml`、已接受的 ADR 与 `docs/PROJECT_STATUS.json` 仍是契约事实源；本文件不另立 API 或 schema。

- 版本：Conchbase additive `1.7.0` Agent Chat 契约。
- 事实源：[ADR 0059](decisions/0059-agent-chat-tool-projection.md) 与 [OpenAPI](openapi.yaml)。

## 本次发布

- `GET /v1/runtime` 可选发布 `agentChatContract: "1.7.0"` 与 `agentChatPaths: 5`。
- 新增第五条 additive 路径：`POST /v1/agent-chat/conversations/{conversationId}/approval`，提供对话内审批。
- Agent Chat 助手消息新增 `activity` 投影，展示轮次、工具调用、审批与流式输出的有界活动；不包含工具参数、文件内容或供应商原始载荷。
- 新增 `waiting_approval` 对话状态，映射到 `human` 阶段；用户可在对话内直接批准或拒绝写工具，Runtime 仍是唯一审批与执行裁决方。
- 活动来自既有的持久化 Agent Loop 事件；投影有界、有序、可重放，不新增事件表，也不改变任务状态机。
- `1.7.0` 只改 Agent Chat 契约；冻结的 47 条 `1.0.0` 平台路径与其他 additive 契约保持不变。

## 验证

- `tests/agent-chat-tools.test.ts` 覆盖工具/审批活动投影、`waiting_approval`、对话内批准、写入结果、终态回复与重复决策 `409`。
- `tests/agent-paired-runtime.test.ts` 保持 Pagurus typed client 与升级后的契约一致。
- 双仓 `npm run check` 与相关测试通过。

## 边界

SSE、供应商推理文本、工具参数展示、网络工具、可写 MCP 工具、插件宿主与密钥注入仍不在已发布边界内，需要单独已接受 ADR。
