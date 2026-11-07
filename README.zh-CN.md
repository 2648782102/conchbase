# 海螺 · Conchbase

**可独立运行、可连接多种界面的个人 Agent Runtime。**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

海螺负责 agent 的实际运行：任务生命周期、模型与工具编排、权限执行、运行事件和持久状态。它可以脱离图形界面通过 CLI 工作；寄居蟹和第三方客户端通过版本化 API 接入。

当前是早期骨架，已提供本机健康检查接口。模型执行、MCP 连接、持久化和公开任务 API 仍在规划中。

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

技术架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，接口状态见 [docs/API.md](docs/API.md)。English: [README.md](README.md).
技术栈与路线图见 [docs/TECH_STACK.md](docs/TECH_STACK.md) 和 [docs/ROADMAP.md](docs/ROADMAP.md)。配套控制台：[Pagurus 寄居蟹](https://github.com/2648782102/pagurus)。

## 许可

MIT，详见 [LICENSE](LICENSE)。
