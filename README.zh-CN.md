# 海螺 · Conchbase

**可独立运行、可连接多种界面的个人 Agent Runtime。**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

海螺负责 Agent 身份与版本、任务绑定、实际运行、模型调用、取消、显式重试、有序事件与持久状态。寄居蟹等客户端通过版本化 Runtime API 管理 Agent，执行与权限仍由海螺负责。

## 当前状态

Conchbase `1.0.0` 提供运行时内 Agent profile、不可变版本、默认选择、复制/归档、供应商中立的模型引用和 Agent 任务绑定。每个 Agent 任务固定 Agent 版本、全局运行时配置版本和生效的 provider/model，并执行一轮模型调用。旧任务继续按原来的全局 v1/v2 规则运行，其中 v2 是不调用模型或工具的确定性组合遍历。当前唯一注册的 provider adapter 是 Magpie 兼容实现；它不是产品目的或唯一未来供应商。任务状态、进度、最终输出、错误和事件存储在本地 SQLite 中。进程重启会把未完成任务标记为 `interrupted`；显式重试生成新的 attempt，并保留原事件。

[ADR 0024](docs/decisions/0024-durable-work-domain-and-public-api.md) 是历史第一闭环。[ADR 0025](docs/decisions/0025-local-first-v1-platform.md) 已完成最终本地优先目标：`1.0.0`、47 条路径、work contract v2、认证配对元数据、可显式开启的认证非回环绑定、持久工作控制与重启恢复、一个本地 Source、能力目录，以及进程内封存的只写 SecretHandle 与摘要收据。`docs/openapi.yaml` 为 `1.0.0`、47 条路径。

Agent profile 与全局策略/能力配置分别管理。Agent 指令是用户自定义上下文，不会授予工具或权限。Agent 任务不会因为全局配置是 v2 就隐式执行组合图；旧任务行为保持不变。

第一阶段的 SQLite 数据库同一时间只允许一个进程持有。第二个 CLI 或服务实例会快速失败，避免把正在运行的任务误判为中断。`conchbase models` 目前直接读取 Magpie 兼容目录，不打开数据库；未来可由供应商中立的发现契约统一目录，而不改变 Agent 身份。海螺服务运行时，不要执行其他读写任务状态的 CLI 命令，并发查看任务应使用 Runtime API。这是开发期的单实例边界，不代表已支持生产级多进程，详见 [ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md)。

仓库内已有一个仅供测试的 fixture 工具能力内核，用于验证精确审批、按 attempt 幂等和确定性审计；它不是公开工具接口，也不能运行真实宿主工具。Conchbase `1.0.0` 保留 `schemaVersion: 1` 与 `schemaVersion: 2` 配置文档及公开工具请求/审批台账。旧 v1 任务通过 Magpie 兼容适配器执行一轮流式模型调用；旧 v2 任务执行有边界、拓扑中立的确定性组合遍历，记录节点事件并传播取消，不调用模型也不执行工具。Agent 任务绑定所选 profile 版本并执行一轮模型调用。工具台账仅保存请求、决策和审计记录，绝不执行工具或授予能力。ADR 0019 提供临时供应商工具调用观察边界，但不会自动创建台账请求或执行工具。配置引用与 Agent 指令都不会安装 Skills/MCP/插件、解析密钥或授予权限。模型驱动组合、委派、并发、真实工具执行、可移植 profile 文件、SSE、生产级远程配对 UX 与云部署仍在最终本地优先目标之外。用户自定义组合保持拓扑中立，详见 [ADR 0005](docs/decisions/0005-user-defined-agent-topology-proposal.md)、[ADR 0010](docs/decisions/0010-first-real-model-slice.md)、[ADR 0012](docs/decisions/0012-streaming-output-progress.md)、[ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md)、[ADR 0014](docs/decisions/0014-versioned-configuration-api.md)、[ADR 0015](docs/decisions/0015-composition-identity-kernel.md)、[ADR 0016](docs/decisions/0016-composition-execution-and-public-schema.md)、[ADR 0017](docs/decisions/0017-public-tool-request-approval-ledger.md)、[ADR 0018](docs/decisions/0018-provider-tool-call-parsing-boundary.md)、[ADR 0019](docs/decisions/0019-explicit-provider-tool-call-observation-boundary.md) 和 [ADR 0020](docs/decisions/0020-multi-agent-and-provider-neutral-model-contract.md)。

确定性的仓库护栏测试把已接受的契约和 AI-first 边界固定为可执行检查。ADR 0021 增加可选的真实 loopback HTTP 验收：通过确定性的假 Magpie 兼容网关，让 Pagurus 已发布的客户端与真实 Runtime、两个独立 Agent 完成闭环；单独克隆 Conchbase 时该测试安全跳过。CI 使用假模型响应和临时数据库，不调用真实模型。这是确定性的 HTTP 验收，不等于真实供应商、可视化/手工 UI、远程或生产存储验证。

## 环境要求

Node.js 24+；当前 Magpie 兼容适配器进行真实模型调用时，需要启动本机 Magpie 网关，并在 Magpie 中配置其凭证。未来适配器可通过各自的海螺管理边界持有凭证；密钥不得进入 Agent 文档或客户端响应。

```sh
npm ci
npm run dev
```

默认监听 `127.0.0.1:4318`，只允许 loopback 地址。检查服务：

```sh
curl http://127.0.0.1:4318/v1/health
```

## 选择并运行模型

```sh
export CONCHBASE_MAGPIE_APP_KEY=magpie-conchbase
npm run cli -- models
export CONCHBASE_MODEL='provider/model-id'
export CONCHBASE_ORGANIZATION_INTENT_MODEL='用于结构化组织意图解析的模型 id'
npm run cli -- run '只回复：ok'
```

这些环境变量描述当前 Magpie 兼容适配器：`CONCHBASE_MAGPIE_APP_KEY` 可选，只用于让 Conchbase 的请求在 Magpie 使用记录中显示自己的名字，不是供应商密钥；`CONCHBASE_MODEL` 当前使用用户 Magpie 模型目录中的 id；`CONCHBASE_MAGPIE_URL` 默认 `http://127.0.0.1:3425`；`CONCHBASE_DB` 默认 `.conchbase/runtime.sqlite`，已被 Git 忽略。未来供应商中立的 Agent 引用与模型发现，不应依赖这些 Magpie 专属变量名或目录 id。

`CONCHBASE_ORGANIZATION_INTENT_MODEL` 用于开启老板主会话的真实结构化模型解析；未设置时使用确定性离线解析器。两种模式下模型和解析器输出都只是不可信提案：每个组织动作都会由 Conchbase 重新解析、校验和授权后才能提交。

HTTP API 提供同样的操作：

```sh
curl -X POST http://127.0.0.1:4318/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"只回复：ok","model":"provider/model-id"}'
```

任务、事件、配置、模型目录、工具请求/审批台账以及 additive `1.1.0` 组织接口见 [API 文档](docs/API.md) 和 [OpenAPI 契约](docs/openapi.yaml)。Boss Mode `1.1.0` 提供唯一主会话意图入口与组织已发布状态；见 [v1.1.0 中文发布说明](docs/RELEASE_NOTES_1.1.0.zh-CN.md) 和 [中文快速开始](docs/QUICK_START.zh-CN.md)。

## 设计边界

- 海螺拥有任务状态与权限；CLI、寄居蟹和第三方界面都是客户端。
- 当前使用 Magpie 兼容适配器并通过统一适配器边界接入；其他适配器应实现供应商中立的领域契约。任何供应商返回内容都属于未受信任数据。
- 任务与有序事件通过私有的 `TaskStore` 原子提交；界面不读取数据库。
- 有边界的正文增量会生成持久的 `task.output_delta` 事件和 `partialOutput` 快照；最终输出仍以 `output` 为准。
- 组合节点进度会生成持久组合事件，并携带固定的 `cmp_` 身份与配置修订。
- 模型目录读取不依赖数据库；运行时数据库由单一进程持有。
- 每次任务 attempt 固定一个内容寻址的配置修订。
- v1/v2 版本化配置联合保留旧文档兼容性，同时支持拓扑中立的组合数据。
- Skill 只提供指令，不授予工具权限；第一阶段会拒绝模型发起的工具调用。
- 公开的工具请求/审批决策只是持久台账状态，绝不是执行许可。临时的供应商观察值只是未受信任的规范化数据，也绝不是执行许可。

架构、技术栈、路线图、验证计划和[完整组织运行时目标](docs/ORGANIZATION_RUNTIME_TARGET.zh-CN.md)见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/TECH_STACK.md](docs/TECH_STACK.md)、[docs/ROADMAP.md](docs/ROADMAP.md) 和 [docs/VALIDATION_PLAN.md](docs/VALIDATION_PLAN.md)。配套控制台：[Pagurus 寄居蟹](https://github.com/2648782102/pagurus)。中文文档：[快速开始](docs/QUICK_START.zh-CN.md)、[目标模式接手说明](docs/OBJECTIVE_MODE.zh-CN.md)、[v1.0.0 发布说明](docs/RELEASE_NOTES_1.0.0.zh-CN.md) 与 [v1.1.0 发布说明](docs/RELEASE_NOTES_1.1.0.zh-CN.md)。另有可选的[视觉概览](docs/VISUAL_OVERVIEW.zh-CN.md)，仅供人类快速理解，不是契约事实源。English: [README.md](README.md).

## 面向 AI 开发

本项目主要由 AI 编码 Agent 开发，代码结构、说明和验证流程优先服务于 AI 快速理解、完成边界清楚的改动并确定性验证；不把后续由人类接手作为产品要求。先读根目录 [`AGENTS.md`](AGENTS.md)，并以 [`docs/PROJECT_STATUS.json`](docs/PROJECT_STATUS.json) 的 `aiEntry.requiredOrder` 为阅读顺序：[AI 交接说明](docs/AI_HANDOFF.md)、[机器可读项目状态](docs/PROJECT_STATUS.json)、[目标模式接手说明](docs/OBJECTIVE_MODE.zh-CN.md)、[开发约定](docs/AI_DEVELOPMENT.md) 和 [任务队列](docs/AI_TASK_QUEUE.md)。随后读已接受 ADR、[完整组织运行时目标](docs/ORGANIZATION_RUNTIME_TARGET.zh-CN.md)及链接的架构/API 文档。[ADR 0028](docs/decisions/0028-interface-validation-boundary.md) 与 [ADR 0029](docs/decisions/0029-persistence-test-boundary.md) 闭合基础验证；[ADR 0041](docs/decisions/0041-boss-mode-product-loop.md) 完成老板模式主会话闭环及双仓端到端夹具。

实现下一产品切片前必须读 [ADR 0025](docs/decisions/0025-local-first-v1-platform.md)、[ADR 0041](docs/decisions/0041-boss-mode-product-loop.md)、[ADR 0042](docs/decisions/0042-controlled-execution-direction.md) 与 `docs/AI_HANDOFF.md`；本地优先底座与完整老板模式组织闭环已经实现。下一阶段是受控执行能力；新增真实 Source、外部写入、工具执行、跨进程密钥托管或稳定密钥源，都需要新的已接受 ADR。

代码改动后运行 `npm run check`、`npm test` 和 `npm run build`。

## 许可

MIT，详见 [LICENSE](LICENSE)。

> Final local-first target: Conchbase `1.0.0` and ADR 0025 close the exact 47-path platform contract. Write-only SecretHandle values are sealed at rest with a process-scoped AES-256-GCM key, exposed only to one runtime-owned fixed adapter, and never returned, logged, or sent to a model, client, event, or UI. Restart invalidates previously sealed values; cross-process key sources, real external adapters, executors, Sources, external writes, and tools require separate ADRs.
