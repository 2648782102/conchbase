# 海螺 / 寄居蟹 1.1.0 中文发布说明

> 本文件是 Boss Mode `1.1.0` 的中文发布说明。英文仓库文档、`docs/openapi.yaml`、已接受的 ADR 与 `docs/PROJECT_STATUS.json` 仍是契约事实源；本文件不新增 API、schema 或产品边界。

## 发布范围

- 项目：海螺 Conchbase（Agent Runtime）与寄居蟹 Pagurus（可选控制台）。
- 版本：Runtime 公开组织契约为 additive `1.1.0`；冻结的 `1.0.0` 47 条路径保持不变，新增 18 条组织发布状态路径。
- 定位：用户只与一个主会话对话，Runtime 解析意图、裁决动作、创建动态员工 Agent、并发执行工作、汇总结构化报告与 Attention，并支持归档/恢复。Pagurus 只提交有界文本意图并读取已发布状态。
- 事实源：Conchbase [ADR 0041](decisions/0041-boss-mode-product-loop.md)、Pagurus [ADR 0018](../pagurus/docs/decisions/0018-boss-mode-console-product-loop.md)、[`docs/openapi.yaml`](openapi.yaml) 与 [机器可读项目状态](PROJECT_STATUS.json)。

## 本次发布内容

- 主会话意图：`POST /v1/organization/session/intents` 接收有界文本与 idempotency key；`202` 代表 Runtime 已接受，客户端通过已发布状态读取结果。
- 双解析器：默认使用确定性离线解析器；设置 `CONCHBASE_ORGANIZATION_INTENT_MODEL` 后使用 OpenAI-compatible / Magpie 兼容结构化解析器。模型输出永远不可信，必须重新通过组织内核校验。
- 动态员工：Runtime 从当前模型目录解析 provider-neutral model reference，通过既有 Agent 边界创建不可变 revision，并记录 Delegation、scope、capabilities、TTL 与 depth。
- 并发工作：授权后的员工绑定 WorkItem / Assignment 与 Agent-backed Task；任务结果转成 digest-only `report_worker`，需要用户输入时转成 `request_attention`。
- Attention：公开视图带 `expectedVersion`；回答会唤醒员工并创建新的 Task/WorkItem，撤回只记录决策；开放 Attention 阻止新的自主启动。
- 生命周期：归档前 offboard 活跃员工、撤销委派、quiet 后 archive；恢复时 revalidate Delegation、resume worker、创建新的工作。
- 持久化与恢复：意图记录、执行身份、工作项映射与结果摘要都落在组织 action/event 链中；重建服务可从事件恢复映射。
- 控制台与 CLI：Pagurus 组织主会话工作区提交意图、读取项目/员工/委派/报告/Attention/事件；CLI 提供 `conchbase boss` 与 `conchbase organization`。
- 安全边界：明文敏感值不进入模型、提示词、任务状态、事件、日志、错误、客户端响应、Agent revision、配置文档或 UI；不提供通用密钥解析器；工具不能绕过 Runtime 策略与审批路径。

## 快速开始

```sh
npm ci
npm run dev
```

另一个终端启动 Pagurus：

```sh
cd pagurus
npm ci
npm run dev
```

CLI 直接提交主会话意图：

```sh
npm run cli -- boss "Start project alpha and hire worker beta."
npm run cli -- organization
```

若要让主会话意图由真实模型解析：

```sh
export CONCHBASE_ORGANIZATION_INTENT_MODEL='deepseek/deepseek-flash'
npm run dev
```

未设置该变量时使用确定性离线解析器；本地模型目录必须包含所选模型。不要将任何凭证写入仓库、Agent profile、配置文档或客户端。

HTTP 入口：

```sh
curl -X POST http://127.0.0.1:4318/v1/organization/session/intents \
  -H 'Content-Type: application/json' \
  -d '{"intent":{"text":"Start project alpha and hire worker beta.","idempotencyKey":"demo-001"}}'

curl http://127.0.0.1:4318/v1/organization/session
curl 'http://127.0.0.1:4318/v1/organization/events?limit=100'
```

在 Pagurus 中打开「组织主会话」工作区，输入意图、处理 Attention，并查看项目、员工提案、委派、报告与事件。

## 验证结果

- Conchbase `npm run check && npm test && npm run build`：152 个测试通过。
- Pagurus `npm run check && npm test && npm run build`：95 个测试通过。
- 双仓产品闭环夹具：`tests/organization-e2e.test.ts` 使用 credential-free fake provider、真实 Fastify Runtime、动态导入的 Pagurus typed organization client，覆盖两个项目、并发 worker、一次 Attention 回答、一次归档/恢复，以及意图/报告/Attention/归档/恢复事件。
- 本地 Runtime 验收：`npm run validate:boss-local` 对真实开发服务完成 `health → runtime discovery → model-catalog → primary intent → published session → events` 检查；确定性离线模式下通过，输出项目、员工、报告、事件与 session 不含 raw events 的有界摘要。
- 真模型解析器验收：本机 Magpie 模型目录可用；`workbuddy/hy4flash-dev` 能完成 Chat Completions，但当前结构化提示曾返回不被组织内核接受的 `startProjectReleaseValidation` action type，Runtime 正确在提交前拒绝为 `400`。这属于供应商/提示词结构化输出一致性限制，不代表 Runtime 状态提交；结构化解析器指令已加强为明确 action 白名单，未来真实供应商一致性仍需单独验证。
- 真实模型凭证、输出或用户数据不会提交到仓库。
- CI 不调用公网、不使用真实凭证；真实供应商一致性、真实浏览器无障碍、生产远程 UX 与生产存储矩阵仍是独立验证层。

## 明确不包含

- 真实工具执行、MCP/Skill/plugin 安装与生命周期、宿主执行隔离、持久执行结果。
- 真实外部 Source、真实 Outbox 外部写入与 crash-safe external side effects。
- 跨进程 SecretHandle 密钥托管、OS keychain、生产密钥保险库。
- 生产远程配对 UX、云部署、桌面打包、SSE/保留/重连契约、服务端历史分页。
- 从未经单独接受的 schema 生成客户端类型，或在 Pagurus 发明第二套 Runtime schema。

这些能力必须先写新的已接受 ADR，再改变公开契约。

## 中文文档

- [中文 README](../README.zh-CN.md)
- [中文快速开始](QUICK_START.zh-CN.md)
- [v1.0.0 中文发布说明](RELEASE_NOTES_1.0.0.zh-CN.md)
- [v1.1.0 中文发布说明](RELEASE_NOTES_1.1.0.zh-CN.md)
- [目标模式接手说明](OBJECTIVE_MODE.zh-CN.md)
- [机器可读项目状态](PROJECT_STATUS.json)
- [Pagurus 中文发布说明](../pagurus/docs/RELEASE_NOTES_1.1.0.zh-CN.md)

> 本文件描述当前仓库事实，不替代英文契约文档；`v1.0.0` 发布说明作为历史发布快照保持不变。
