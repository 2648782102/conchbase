# 海螺中文快速开始

> 面向中文读者与 AI 编码 Agent 的入口文档。英文 `docs/AI_HANDOFF.md`、`docs/AI_DEVELOPMENT.md`、`docs/openapi.yaml` 和 ADR 仍是契约事实源；本文件不另立 schema 或 API。

## 这套项目是什么

海螺 Conchbase 是本地优先、可独立运行的个人 Agent Runtime。它拥有 Agent 身份与版本、任务执行、模型调用、持久状态、事件、策略和权限；不依赖图形界面。寄居蟹 Pagurus 是可选控制客户端，通过版本化 Runtime API 管理 Agent、配置、工作、能力和 SecretHandle。CLI、IDE 与第三方界面同样可以作为客户端接入。

当前已包含 Boss Mode `1.1.0` 主会话闭环、受控执行 `1.2.0` v1、隔离执行 `1.3.0` v2、主会话对话投影 `1.4.0` 与独立 Agent 对话 `1.5.0`：前者从唯一主会话生成动态员工、工作、报告与 Attention；`1.2.0` 证明完整授权/审批/审计路径；`1.3.0` 用 Runtime 拥有的隔离子进程执行封闭确定性操作并提供 durable run、中断与恢复；`1.4.0` 把用户消息、Boss 回执、员工活动、报告与 Attention 组织成有序编排事件流；`1.5.0` 让用户选择配置好的 Agent，通过 Runtime 调用真实模型并正常一问一答。

用户可高度定制自己的 Agent，例如设计多角色协作。但产品不内置三层结构、Router/Worker、固定层级或调度规则；组合数据保持拓扑中立，示例不等于 schema。

## 环境与启动

要求 Node.js 24+。当前 Magpie 兼容适配器进行真实模型调用时需要本机 Magpie 网关；它只是当前兼容路径，不是产品唯一供应商。凭证留在 Magpie/适配器边界，不要写进 Agent 文档、仓库或客户端响应。

启动 Runtime：

```sh
npm ci
npm run dev
curl http://127.0.0.1:4318/v1/health
```

启动配套客户端（另一个终端，在 Pagurus 仓库中）：

```sh
npm ci
npm run dev
```

Pagurus 的 Vite 开发服务器把 `/v1` 代理到 `http://127.0.0.1:4318`。服务默认只监听 loopback；非回环绑定必须显式开启并通过已批准 token 摘要认证。

## 常用命令

```sh
npm run cli -- models
npm run cli -- run "只回复：ok"
npm run cli -- boss "Start project alpha and hire worker beta."
npm run cli -- organization
npm run cli -- tasks
npm run cli -- events
```

`conchbase boss` 会调用同一个 Runtime 主会话入口并等待当前执行链完成；`conchbase organization` 打印已发布组织状态。`conchbase serve` 活跃时，不要运行其他读写任务状态数据库的 CLI 命令；并发查看任务应使用 Runtime API。单进程 SQLite 所有权是当前开发边界，不是生产多进程支持。

配置写操作、工作控制、能力目录和 SecretHandle 通过 `docs/openapi.yaml` 描述的 47 条 `1.0.0` 路径完成；组织状态与主会话意图使用 18 条 `1.1.0` additive 路径；授权、审批、假执行与审计使用 8 条 `1.2.0` additive 路径；隔离执行 run 使用 8 条 `1.3.0` additive 路径；主会话对话投影使用 2 条 `1.4.0` additive 路径；独立 Agent 对话使用 4 条 `1.5.0` additive 路径。UI 不读取私有数据库。

真实模型解析主会话意图时设置：

```sh
export CONCHBASE_ORGANIZATION_INTENT_MODEL='deepseek/deepseek-flash'
npm run dev
```

未设置时使用 `CONCHBASE_MODEL` 或 `CONCHBASE_BOSS_MODEL` 指定的老板自然对话解析器；两者都未设置时才回退到确定性离线解析器。模型或解析器输出只是不可信提案，所有组织动作都由 Conchbase 重新校验和授权。

设置 `CONCHBASE_MODEL` 后，老板 Agent 会默认通过同一个协议端点进行自然对话；可用 `CONCHBASE_BOSS_MODEL` 单独覆盖模型。用户只和老板对话，是否使用组织能力由老板判断；所有动作仍由 Runtime 校验。

需要让 Agent 使用 MCP 工具时，先由管理员写一份本地配置，再用 `CONCHBASE_MCP_CONFIG` 指向它：

```json
{
  "servers": [
    {
      "id": "local",
      "command": "/absolute/path/to/mcp-server",
      "args": ["--stdio"],
      "tools": [{ "name": "search_docs", "sideEffect": "read" }]
    }
  ]
}
```

Runtime 只启动这里声明的绝对路径命令，不继承环境变量，不接受 `shell`，并且只暴露显式列出的 `read` 工具。写入类工具与远程 MCP 传输仍需单独 ADR。

需要让 Agent 参考 Skill 时，把标准 `SKILL.md` 目录放到一处，并用 `CONCHBASE_SKILLS_DIR` 指向父目录：

```sh
CONCHBASE_SKILLS_DIR=/path/to/skills npm run dev
```

Runtime 只读取每个子目录的 `SKILL.md` 正文，最多注入 8 个 Skill、8 KiB 指令；`allowed-tools`、脚本和附件会被完全忽略。Skill 只是建议性指令，不能覆盖 Runtime 策略、工具授权或审批要求。

独立 Agent 对话不需要在 Conchbase 配置供应商凭证；请在 Magpie 中配置模型、供应商、凭证、路由与 app key，Conchbase 只通过 OpenAI 兼容协议接口访问本机 Magpie。

## 架构边界

- Conchbase 是执行权威；Pagurus 和其他界面只提交意图并消费公开响应。
- Agent 版本与全局策略/能力配置版本分离；每个 Agent 任务固定两者及生效 provider/model。
- 供应商适配器可替换；Agent 模型引用使用 `{ providerId, modelId }`，不绑定 Magpie 目录 id。
- 工具台账只保存请求、决策与审计事件，不执行工具；Skill 只提供指令，不授予权限。
- 只写 SecretHandle 的明文只由 Runtime 拥有的固定适配器在进程内短暂使用；客户端、模型、事件、日志、错误和响应都只能看到摘要与元数据。
- 重启会使旧封存值失效，必须轮换后恢复；这是刻意选择的安全边界。

## AI-first 开发顺序

1. 先读根目录 [`AGENTS.md`](../AGENTS.md)，确认 AI-first 原则和产品不变量。
2. 读 [AI 交接说明](AI_HANDOFF.md)，再读 [机器可读项目状态](PROJECT_STATUS.json) 与 [目标模式接手说明](OBJECTIVE_MODE.zh-CN.md)，先区分已实现、验证证据与必须先立 ADR 的方向。
3. 读 [开发约定](AI_DEVELOPMENT.md)、[任务队列](AI_TASK_QUEUE.md)，并以 `PROJECT_STATUS.json` 的 `aiEntry.requiredOrder` 为准。
4. 读 [架构](ARCHITECTURE.md)、[API](API.md)、[OpenAPI 契约](openapi.yaml)、[技术栈](TECH_STACK.md)。
5. 读 [验证计划](VALIDATION_PLAN.md)、[ADR 0025](decisions/0025-local-first-v1-platform.md)、[ADR 0026](decisions/0026-ai-handoff-readiness-development-boundary.md)、[ADR 0028](decisions/0028-interface-validation-boundary.md) 与 [ADR 0029](decisions/0029-persistence-test-boundary.md)。
6. 在进入组织能力开发前，完整读 [Organization Runtime 最终目标规格](ORGANIZATION_RUNTIME_TARGET.zh-CN.md)、[ADR 0030–0034](decisions/) 与 [ADR 0041](decisions/0041-boss-mode-product-loop.md)；它们定义目标、领域状态机、委派边界、并发/汇报/归档、公开契约门与已完成的产品闭环。
7. 修改持久工作或 SecretHandle 状态前，读 `src/runtime/work-contract.ts`、`src/runtime/work-store.ts`、`src/runtime/platform-contract.ts` 和 `src/runtime/platform-store.ts`。

每次改动后运行 `npm run check`、`npm test`、`npm run build`，并同步更新受影响的文档与 OpenAPI。不要静默扩展 `Task`、configuration、work 或 SecretHandle schema；外部能力必须先写新 ADR。

## 验证与发布文档

- [中文 README](../README.zh-CN.md)
- [中文发布说明](RELEASE_NOTES_1.0.0.zh-CN.md)
- [v1.1.0 中文发布说明](RELEASE_NOTES_1.1.0.zh-CN.md)
- [v1.2.0 中文发布说明](RELEASE_NOTES_1.2.0.zh-CN.md)
- [v1.3.0 中文发布说明](RELEASE_NOTES_1.3.0.zh-CN.md)
- [v1.4.0 中文发布说明](RELEASE_NOTES_1.4.0.zh-CN.md)
- [v1.5.0 中文发布说明](RELEASE_NOTES_1.5.0.zh-CN.md)
- [v1.7.0 中文发布说明](RELEASE_NOTES_1.7.0.zh-CN.md)
- [v1.8.0 中文发布说明](RELEASE_NOTES_1.8.0.zh-CN.md)
- [目标模式接手说明](OBJECTIVE_MODE.zh-CN.md)
- [机器可读项目状态](PROJECT_STATUS.json)
- [英文 README](../README.md)
- [Pagurus 中文快速开始](https://github.com/2648782102/pagurus/blob/main/docs/QUICK_START.zh-CN.md)

`v1.0.0` 是历史发布快照；`v1.1.0` 描述 Boss Mode，`v1.2.0` 描述受控执行 v1，`v1.3.0` 描述隔离执行 v2，`v1.4.0` 描述主会话对话投影，`v1.5.0` 描述独立 Agent 对话模块。仓库内的中文文档与 Release notes 保持一致。
