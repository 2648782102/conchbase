# 架构总览（2026-11-16 审阅）

![Conchbase 架构总览](architecture-overview.png)

> 图由 `generate_flow_diagram` 生成，节点名与仓库模块一一对应。本文是审阅结论，不是契约事实源；契约以 `docs/openapi.yaml` 与已接受 ADR 为准。

## 分层与依赖方向

自左向右是调用方向，不允许反向：

1. **客户端**（CLI / Pagurus 控制台 / 第三方 API）— 只通过版本化 HTTP 契约交互，不读私有文件或数据库。
2. **HTTP 契约层**（17 个路由组）— 负责传输与形状，不含业务判断。
3. **编排层** — `boss-mode-service`（意图→组织动作）与 `agent-chat`（会话投影）。
4. **执行层** — `task-service` 拥有 Agent 循环、工具排空、审批与预算。
5. **领域层** — `organization-contract` 与 `organization-validators` 是纯函数，无 I/O。
6. **存储所有权** — `task-store` 是唯一 SQLite 持有者，同时拥有 work / platform / organization / agentChat / memory 五个子存储。

## 审阅结论

**成立的部分**

- 依赖方向干净：领域层不 import 服务层，服务层不 import HTTP 层。
- 单一写入者成立：只有 `task-service` 构造 `SqliteTaskStore`，其余模块通过它访问。
- 适配器边界清晰：`magpie-provider`、`mcp-provider`、`skill-provider` 都是可替换实现，不被领域代码直接依赖。
- 拆分后无运行时文件超过 1300 行（拆分前 5 个文件超 1000 行，最大 1518）。

**仍然存在的问题（按优先级）**

1. **`task-store.ts` 有 1239 行且承担 6 类表的职责**：任务、事件、Agent、work、platform、organization、agentChat、memory。它是唯一所有者这一点是对的，但"唯一所有者"不等于"一个文件"。可拆成「连接与迁移」+「按表分组的仓储」，保持单 owner 不变。
2. **`agent-chat-store.ts` 反向 import `agent-chat.js` 的类型**：形成 store ↔ service 的循环依赖。这是拆分引入的，应当把会话记录类型下沉到 `agent-chat-types.ts`。
3. **`boss-mode-service` 仍含生命周期批处理**（恢复、归档、下线），与"意图→动作"混在一起，是它剩下的主要耦合。
4. **并发缺失是结构性的**：`submit` 串行 `await` 每个派发的员工，`organization-execution` 只有并发上限而没有实际并发。这不是 bug，是尚未实现的能力；在引入并发前，需要先明确 `task-service` 的循环状态是否可重入。

**不建议做的事**

- 不要引入"调度中台"式独立服务：会成为第二个状态所有者，违反单一写入者不变量。
- 不要在 `task-store` 拆分前引入并发：现在循环与存储的所有权边界还不够细，并发会放大所有隐藏的共享状态。
