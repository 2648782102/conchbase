# 海螺 · Conchbase

**可独立运行、可连接多种界面的个人 Agent Runtime。**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

海螺负责 agent 的实际运行：任务生命周期、模型调用、取消、显式重试、有序事件与持久状态。它可以脱离图形界面通过 CLI 工作；寄居蟹和第三方客户端通过同一套版本化 API 接入。

## 当前状态

`schemaVersion: 1` 任务通过本机 [Magpie](https://usemagpie.ai/docs/integrate) 网关接入一轮真实流式模型调用；`schemaVersion: 2` 任务执行有边界的确定性组合遍历，带节点事件且不调用模型或工具。任务状态、进度、最终输出、错误和事件存储在本地 SQLite 中。CLI 与寄居蟹都能创建、查看、取消和重试任务。进程重启会把未完成任务标记为 `interrupted`；显式重试生成新的 attempt，并保留原事件。运行时不会静默续跑中断中的模型请求或组合。

第一阶段的 SQLite 数据库同一时间只允许一个进程持有。第二个 CLI 或服务实例会快速失败，避免把正在运行的任务误判为中断。`conchbase models` 直接读取 Magpie，不打开数据库；当 `conchbase serve` 正在运行时，不要执行其他读写任务状态的 CLI 命令，并发查看任务应使用 Runtime API。这是开发期的单实例边界，不代表已支持生产级多进程，详见 [ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md)。

仓库内已有一个仅供测试的 fixture 工具能力内核，用于验证精确审批、按 attempt 幂等和确定性审计；它不是公开工具接口，也不能运行真实宿主工具。Conchbase `0.6.0` 实现了 `schemaVersion: 1` 与 `schemaVersion: 2` 两版配置文档，以及公开的、与供应商无关的工具请求/审批台账。v1 任务执行一轮 Magpie 流式模型调用；v2 任务执行有边界、拓扑中立的确定性组合遍历，记录节点事件并传播取消，不调用模型也不执行工具。台账接收符合条件的 v2 任务 attempt 的规范化工具调用提案，持久化组合作用域内的请求、决策和审计事件，但绝不执行工具或授予能力。仓库内还有一个纯函数、未接线的内部解析器，可以把单个非流式供应商 function tool call 规范化为临时观察值和摘要；在线供应商仍拒绝工具调用，供应商适配器集成与执行仍留给后续已接受的切片。配置引用仍是不透明数据，不会安装 Skills/MCP/插件、解析密钥、授予工具或定义固定拓扑。模型驱动节点工作、委派、并发、已解析工具调用的供应商适配器集成、流式工具调用累积、模型发起的工具执行、公开执行接口、真实执行器隔离、崩溃安全的副作用、能力生命周期、可移植 profile 文件、生产审批、SSE 传输、推理内容展示、认证和远程访问仍在规划中。两种当前任务模式都不是内建 Agent 拓扑；用户自定义组合仍保持拓扑中立，详见 [ADR 0005](docs/decisions/0005-user-defined-agent-topology-proposal.md)、[ADR 0010](docs/decisions/0010-first-real-model-slice.md)、[ADR 0012](docs/decisions/0012-streaming-output-progress.md)、[ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md)、[ADR 0014](docs/decisions/0014-versioned-configuration-api.md)、[ADR 0015](docs/decisions/0015-composition-identity-kernel.md)、[ADR 0016](docs/decisions/0016-composition-execution-and-public-schema.md)、[ADR 0017](docs/decisions/0017-public-tool-request-approval-ledger.md) 和 [ADR 0018](docs/decisions/0018-provider-tool-call-parsing-boundary.md)。

确定性的仓库护栏测试把已接受的契约和 AI-first 边界固定为可执行检查。CI 使用假模型响应和临时数据库，不调用真实模型。

## 环境要求

Node.js 24+；进行真实模型调用时，本机 Magpie 网关需要处于运行状态。模型供应商与密钥由 Magpie 自己管理，海螺不保存它们。

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
npm run cli -- run '只回复：ok'
```

`CONCHBASE_MAGPIE_APP_KEY` 可选，只用于让 Conchbase 的请求在 Magpie 使用记录中显示自己的名字，不是供应商密钥。`CONCHBASE_MODEL` 使用用户 Magpie 模型目录中的 id。`CONCHBASE_MAGPIE_URL` 默认 `http://127.0.0.1:3425`；`CONCHBASE_DB` 默认 `.conchbase/runtime.sqlite`，已被 Git 忽略。

HTTP API 提供同样的操作：

```sh
curl -X POST http://127.0.0.1:4318/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"只回复：ok","model":"provider/model-id"}'
```

任务、事件、配置、模型目录与工具请求/审批台账接口见 [API 文档](docs/API.md) 和 [OpenAPI 契约](docs/openapi.yaml)。

## 设计边界

- 海螺拥有任务状态与权限；CLI、寄居蟹和第三方界面都是客户端。
- Magpie 是适配器背后的可替换本机模型来源，其返回内容是未受信任的数据。
- 任务与有序事件通过私有的 `TaskStore` 原子提交；界面不读取数据库。
- 有边界的正文增量会生成持久的 `task.output_delta` 事件和 `partialOutput` 快照；最终输出仍以 `output` 为准。
- 组合节点进度会生成持久组合事件，并携带固定的 `cmp_` 身份与配置修订。
- 模型目录读取不依赖数据库；运行时数据库由单一进程持有。
- 每次任务 attempt 固定一个内容寻址的配置修订。
- v1/v2 版本化配置联合保留旧文档兼容性，同时支持拓扑中立的组合数据。
- Skill 只提供指令，不授予工具权限；第一阶段会拒绝模型发起的工具调用。
- 公开的工具请求/审批决策只是持久台账状态，绝不是执行许可。

架构、技术栈、路线图和验证计划见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/TECH_STACK.md](docs/TECH_STACK.md)、[docs/ROADMAP.md](docs/ROADMAP.md) 和 [docs/VALIDATION_PLAN.md](docs/VALIDATION_PLAN.md)。配套控制台：[Pagurus 寄居蟹](https://github.com/2648782102/pagurus)。English: [README.md](README.md).

## 面向 AI 开发

本项目主要由 AI 编码 Agent 开发，代码结构、说明和验证流程优先服务于 AI 快速理解、完成边界清楚的改动并确定性验证；不把后续由人类接手作为产品要求。先读根目录 [`AGENTS.md`](AGENTS.md)，再读 [AI 交接说明](docs/AI_HANDOFF.md)、[ADR 0010](docs/decisions/0010-first-real-model-slice.md)、[ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md)、[ADR 0012](docs/decisions/0012-streaming-output-progress.md)、[ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md)、[ADR 0014](docs/decisions/0014-versioned-configuration-api.md)、[ADR 0015](docs/decisions/0015-composition-identity-kernel.md)、[ADR 0016](docs/decisions/0016-composition-execution-and-public-schema.md)、[ADR 0017](docs/decisions/0017-public-tool-request-approval-ledger.md)、[ADR 0018](docs/decisions/0018-provider-tool-call-parsing-boundary.md)、[开发约定](docs/AI_DEVELOPMENT.md) 和 [任务队列](docs/AI_TASK_QUEUE.md)。

代码改动后运行 `npm run check`、`npm test` 和 `npm run build`。

## 许可

MIT，详见 [LICENSE](LICENSE)。
