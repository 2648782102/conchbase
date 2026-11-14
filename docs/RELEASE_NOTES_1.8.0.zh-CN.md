# Conchbase v1.8.0 中文发布说明

> 本文件是 Agent Chat `1.8.0` 实时事件流的中文发布说明。英文仓库文档、`docs/openapi.yaml`、已接受的 ADR 与 `docs/PROJECT_STATUS.json` 仍是契约事实源。

- 版本：Conchbase additive `1.8.0` Agent Chat 契约。
- 事实源：[ADR 0060](decisions/0060-agent-chat-live-event-stream.md) 与 [OpenAPI](openapi.yaml)。

## 本次发布

- `GET /v1/runtime` 发布 `agentChatContract: "1.8.0"` 与 `agentChatPaths: 6`。
- 新增第六条 additive 路径：`GET /v1/agent-chat/conversations/{conversationId}/events`，使用 Server-Sent Events。
- 连接后第一帧是 `snapshot`，随后是按 Runtime 事件顺序回放的 `message` 帧；每帧携带事件 id，可直接用于 `Last-Event-ID` 或 `?after=` 断线续传。
- 未知游标、格式错误游标或不属于当前会话的游标会在建立流之前返回 `400`；回放上限 500 条，空闲时每 15 秒发送一次心跳。
- 流是只读投影：不暴露工具参数、文件内容、供应商推理或私有路径；审批仍走 `POST .../approval`，断线不会取消任务。
- 轮询接口保持兼容；客户端在 SSE 不可用时自动回退。
- `1.8.0` 只改 Agent Chat 契约；冻结的 47 条 `1.0.0` 平台路径与其他 additive 契约保持不变。

## 验证

- `tests/agent-chat-stream.test.ts` 覆盖首帧快照、工具/审批更新、从游标续传、事件 id 去重与非法游标 `400`。
- `tests/agent-paired-runtime.test.ts` 保持 Pagurus typed client 与升级后的契约一致。
- 双仓 `npm run check`、`npm test`、`npm run build` 通过。

## 边界

事件保留策略、多进程 fan-out、SSE 负载压缩、供应商推理文本、工具参数展示、网络工具、可写 MCP 工具、插件宿主与密钥注入仍不在已发布边界内，需要单独已接受 ADR。
