# 海螺 · Conchbase

Conchbase 是一个本地优先的个人 Agent Runtime。它负责 Agent 循环、模型
调用、工具、权限、对话、持久化工作和本地状态。配套的
[`Pagurus 寄居蟹`](https://github.com/2648782102/pagurus) 是可选控制台，CLI
和其他客户端使用同一套 Runtime API。

## 快速开始

要求 Node.js 24 或更高版本：

```sh
npm ci
npm run dev
curl http://127.0.0.1:4318/v1/health
```

需要真实模型时，在本机配置 OpenAI 兼容的 Magpie 网关并设置
`CONCHBASE_MODEL`。Magpie 只是当前适配器，不是产品身份。可以使用
`npm run cli -- models` 查看模型，使用
`npm run cli -- run "只回复：ok"` 做一次冒烟调用。

## 开发模型先读

- [`docs/START_HERE.md`](docs/START_HERE.md)：最短入口。
- [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md)：当前已实现和缺口。
- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md)：详细方向、阶段和任务 ID。
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：开发流程。
- [`docs/openapi.yaml`](docs/openapi.yaml)：HTTP 契约。
- [`docs/VALIDATION_PLAN.md`](docs/VALIDATION_PLAN.md)：验证策略。

`docs/` 只保留当前产品和工程文档；实现细节以代码和测试为准，不再维护
旧流程文档。

## 产品方向

优先把个人助理做好：自然对话、边界清楚的工具、明确审批、可审查记忆、
重启恢复、可理解的证据和简单可靠的本地运行流程。云部署、复杂集成和任意
宿主机控制都放到后面，并且每次只做一个完整、可测试的切片。

## 开发检查

```sh
npm run check
npm test
npm run build
```

自动化测试使用本地假 provider、临时数据库和临时工作区；不要提交凭证或真实
用户数据。

MIT 许可，见 [`LICENSE`](LICENSE)。
