# 海螺 Conchbase 1.0.0 中文发布说明

> 本文件是 `v1.0.0` 的中文发布说明。英文仓库文档、`docs/openapi.yaml` 和已接受的 ADR 仍是契约事实源；本文件不新增 API、架构决策或产品边界。

## 发布范围

- 项目：海螺 Conchbase（Agent Runtime）、寄居蟹 Pagurus（可选控制客户端）。
- 版本：两仓均为 `v1.0.0`。
- 定位：Conchbase 是可独立运行、不依赖图形界面的个人 Agent 执行基座；CLI、Pagurus、IDE 和第三方界面都是它的客户端。Pagurus 只通过版本化 Runtime API 提交配置与读取状态，不拥有 Runtime 私有文件或数据库。
- 最终本地优先目标：Conchbase [ADR 0025](decisions/0025-local-first-v1-platform.md) 与 Pagurus [ADR 0010](https://github.com/2648782102/pagurus/blob/main/docs/decisions/0010-final-local-first-client.md) 已闭合。

## 本次发布内容

- 精确 47 条路径的 `1.0.0` OpenAPI 契约、work contract v2、`PRAGMA user_version = 3`，并保留原有 `Task` 资源。
- 独立 Agent 身份与不可变版本；Agent 任务固定 Agent 版本、全局运行时配置版本和生效的 provider/model。Agent 定义与全局策略/能力配置保持分离。
- 供应商中立的模型引用；Magpie 只是当前兼容适配器，不是产品契约或唯一未来供应商。
- 事件驱动、拓扑中立的持久工作：Trigger 幂等摄入、WorkItem/Assignment/Outbox/DeliveryReceipt、start/stop/complete、重启恢复、交付决策和有界事件证据。
- 认证配对与 token 摘要元数据、显式开启的认证非回环绑定；默认仍只允许 loopback。
- 一个确定性本地 Source、能力目录记录，以及只写 SecretHandle：进程内 AES-256-GCM 封存、轮换、状态、固定适配器使用、摘要收据和重启失效。
- 明文敏感值不会进入模型上下文、提示词、任务状态、事件、日志、错误、客户端响应、Agent 版本、配置文档或 UI；不提供通用密钥解析器。
- Pagurus 同步提供工作台控制、有界事件证据、能力目录、只写 SecretHandle 编辑器和摘要收据视图。

## 验证结果

- 两仓 `npm run check && npm test && npm run build` 全部通过：Conchbase 112 个测试、Pagurus 79 个测试。
- 完成最终本地优先真实端到端走查：真实 Conchbase 开发服务、真实 Pagurus Vite `/v1` 代理、临时 SQLite 数据库，共 54 个确定性 HTTP 请求。
- 走查覆盖 health/runtime capability、Trigger 创建与精确重放、配对/token 撤销、Source allow/deny、能力 upsert、work 控制、交付决策、work 事件、SecretHandle 创建/轮换/状态/使用、身份冲突、禁用使用、摘要收据。
- 重启验证旧封存值 `denied`、轮换恢复 `injected`，并验证 `work.recovered → paused/interrupted → resume → completed` 与 accepted 交付证据。
- sentinel 值未出现在 HTTP 响应、持久事件、日志或数据库字节中。
- 这不是自动化无障碍、可视化 UI、真实供应商一致性、生产远程 UX 或生产存储恢复验证。

## 明确不包含

- 稳定跨进程密钥托管、OS keychain、可重放的静态加密值、任意外部固定适配器或生产密钥保险库。
- 真实外部 Source、真实 Outbox 外部写入、可执行工具、MCP/Skill/plugin 安装与生命周期、宿主执行隔离。
- SSE、事件保留策略、多进程 SQLite、云部署、桌面打包、生产远程配对 UX、BYOM 守护进程。
- 模型驱动组合节点、委派、并发、通用角色注册表、生产审批工作流。

这些能力必须先写新的已接受 ADR，再改变公开契约。

## 中文文档

- [中文 README](../README.zh-CN.md)
- [中文快速开始](QUICK_START.zh-CN.md)
- [中文发布说明](RELEASE_NOTES_1.0.0.zh-CN.md)
- [英文 README](../README.md)
- [AI 交接说明](AI_HANDOFF.md)、[开发约定](AI_DEVELOPMENT.md)、[架构](ARCHITECTURE.md)、[API](API.md)、[OpenAPI 契约](openapi.yaml)、[技术栈](TECH_STACK.md)、[验证计划](VALIDATION_PLAN.md)、[任务队列](AI_TASK_QUEUE.md)
- [目标模式接手说明](OBJECTIVE_MODE.zh-CN.md)、[机器可读项目状态](PROJECT_STATUS.json)、[ADR 0026](decisions/0026-ai-handoff-readiness-development-boundary.md)

本 Release 同时附带上述中文文档资产，便于离线阅读和交付给其他开发模型。

## AI 开发入口

本项目主要由 AI 编码 Agent 开发，代码结构、说明和验证流程优先服务于 AI 快速理解、完成边界清楚的改动并确定性验证；不把后续由人类接手作为产品要求。接手模型应先读 [`AGENTS.md`](../AGENTS.md)，再按 `docs/AI_HANDOFF.md` 的顺序读取英文契约文档。中文文档是阅读入口，不替代英文事实源。

代码改动后运行：

```sh
npm run check
npm test
npm run build
```

## 许可

MIT，详见 [LICENSE](../LICENSE)。配套客户端：[Pagurus v1.0.0 中文发布说明](https://github.com/2648782102/pagurus/blob/main/docs/RELEASE_NOTES_1.0.0.zh-CN.md)。
