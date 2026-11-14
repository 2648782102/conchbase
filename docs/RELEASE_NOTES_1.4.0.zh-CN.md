# Conchbase v1.4.0 中文发布说明

> 本文件是主会话对话投影 `1.4.0` 的中文发布说明。英文仓库文档、`docs/openapi.yaml`、已接受的 ADR 与 `docs/PROJECT_STATUS.json` 仍是契约事实源；本文件不另立 API 或 schema。

- 版本：Conchbase additive `1.4.0` 主会话投影契约。
- 事实源：[ADR 0045](decisions/0045-primary-conversation-projection.md)、配对 [Pagurus ADR 0022](../pagurus/docs/decisions/0022-primary-conversation-console.md) 与 [OpenAPI](openapi.yaml)。

## 本次发布

- `GET /v1/runtime` 可选发布 `conversationContract: "1.4.0"` 与 `conversationPaths: 2`。
- 新增 `GET /v1/organization/conversation` 与 `GET /v1/organization/conversation/messages` 两条 additive 路径。
- 主会话消息从 Runtime 拥有的 durable organization events 与当前 published state 确定性投影，包含用户消息、Boss 回执、员工活动、结构化报告、Attention 与 bounded system status。
- 用户意图文本以进程内 bounded intent message store 保存；Runtime 重启后若文本不可用，只发布 digest-only 占位说明，不伪造 transcript。
- 不暴露模型原始 transcript、草稿、提示词、工具输出、明文密钥、私有路径或第二个用户会话；不新增可写消息 API、跨设备同步或供应商流式 transcript 契约。
- Pagurus 按可选 `1.4.0` 发现字段渲染完整主会话栏，并把组织状态卡片保留为辅助详情。

## 验证

- `tests/primary-conversation.test.ts` 覆盖确定性消息序列、cursor、limit、无重复消息 id、无泄漏、HTTP 发现与错误路径。
- 双仓 `npm run check`、`npm test`、`npm run build` 通过；中文文档随发布一并更新。

## 边界

`1.4.0` 是 Runtime 事实的只读投影，不是新的会话写入模型。持久化消息撰写、附件、供应商原生 transcript 流、多用户会话和跨设备同步仍需要单独已接受 ADR。
