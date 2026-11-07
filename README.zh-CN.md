# 海螺 · Conchbase

**可独立运行、可连接多种界面的个人 Agent Runtime。**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

海螺负责 agent 的实际运行：任务生命周期、模型与工具编排、权限执行、运行事件和持久状态。它可以脱离图形界面通过 CLI 工作；寄居蟹和第三方客户端通过版本化 API 接入。

当前是早期骨架，已提供本机健康检查与运行时状态接口，并包含面向未来的内部确定性模块：任务状态、事件顺序、配置修订、工具策略门，以及不依赖模型供应商的 fake-model 验收夹具。模型执行、MCP 连接、持久化和公开任务 API 仍在规划中；这些内部模块尚未接入 HTTP，不调用真实模型或工具，也不能执行真实任务。

## 本地运行

要求 Node.js 24 或更高版本。

```sh
npm install
npm run dev
```

默认监听 `127.0.0.1:4318`，当前只允许 loopback 地址。检查服务：

```sh
curl http://127.0.0.1:4318/v1/health
```

## 设计边界

- 海螺拥有任务执行和权限强制执行。
- CLI、寄居蟹和第三方界面都是 Runtime API 客户端。
- MCP 提供工具连接，Skill 提供 agent 指令。
- 任务运行期间使用固定配置快照。

技术架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，当前接口和 [OpenAPI 契约](docs/openapi.yaml) 见 API 文档。接手开发的模型请先读 [AI 交接说明](docs/AI_HANDOFF.md)，再读 [AI 任务队列](docs/AI_TASK_QUEUE.md) 与 `docs/decisions/` 中的提案 ADR。English: [README.md](README.md).
技术栈、路线图和验证计划见 [docs/TECH_STACK.md](docs/TECH_STACK.md)、[docs/ROADMAP.md](docs/ROADMAP.md) 与 [docs/VALIDATION_PLAN.md](docs/VALIDATION_PLAN.md)。配套控制台：[Pagurus 寄居蟹](https://github.com/2648782102/pagurus)。

## 面向 AI 开发

本项目主要由 AI 编码 Agent 开发，代码结构、说明和验证流程优先服务于 AI 快速理解、完成边界清楚的改动并确定性验证；不把后续由人类接手作为产品要求。每次开始前先读根目录 [`AGENTS.md`](AGENTS.md)，再按其中顺序读取 [AI 交接说明](docs/AI_HANDOFF.md) 和 [开发约定](docs/AI_DEVELOPMENT.md)。

## 许可

MIT，详见 [LICENSE](LICENSE)。
