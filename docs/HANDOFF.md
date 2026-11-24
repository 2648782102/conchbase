# 交给别人使用

这份说明只回答一件事：一个没有读过源码的人，怎样在自己的机器上打开并使用 Conchbase + Pagurus。

## 准备

- Node.js 24 或更新版本。
- 一个本地 OpenAI-compatible 网关。推荐先使用你已有的 Magpie 网关；默认地址是 `http://127.0.0.1:3425`。
- 不需要把模型密钥写进 Pagurus；Runtime 自己读取网关环境变量。

## 一条命令启动

```sh
npm ci
(cd pagurus && npm ci)
npm run start:local
```

默认启动只提供只读工作区工具，写文件需要显式开启：

```sh
CONCHBASE_ALLOW_TOOL_WRITES=1 CONCHBASE_WORKSPACE_ROOT="$PWD" npm run start:local
```

命令会打印两个地址：

```text
Agent console  http://127.0.0.1:5173/
Runtime API    http://127.0.0.1:4318/v1/health
```

打开 Agent console 即可。Ctrl-C 会同时关闭 Runtime 和控制台。

如果你使用 linked worktree，端口会按分支自动错开；始终以命令行打印的地址为准。

## 第一次打开后做什么

1. 页面中央的首启引导会显示本机 Runtime、模型、Agent 三项真实状态；任何一项没准备好，点「查看诊断」。
2. 三个都就绪后，点「用这条开始」，直接发送第一条消息。
3. 默认 Agent 是老板 Agent。它负责理解目标、组织工作、收集报告；写文件和外部动作仍由 Runtime 审批。
4. 需要看显示过的工具调用、审批、错误和决策，点顶栏「上下文」里的「发生了什么」。
5. 需要把问题发给别人，点顶栏「诊断」→「生成支持包」→「复制」。支持包不含提示词、对话内容和文件正文。

## 键盘与窄屏

- 输入框：Enter 发送，Shift + Enter 换行。中文输入法选字时不会误发。
- 所有抽屉和菜单都能用键盘打开、操作并关闭；焦点会回到打开它的按钮。
- 窄屏下抽屉占满宽度，正文和输入框保持单列。

## 验证安装是否正确

```sh
npm run smoke
npm run build
npm run probe:provider
```

`smoke` 验证 Runtime 的启动、发现、任务创建与干净退出；`build` 生成 `dist/`，因为 `probe:provider` 从编译产物读取 Runtime 配置；`probe:provider` 用 Runtime 自己的 catalog、streaming 和错误分类跑一遍真实网关。

## 高级入口

需要管理 Agent、组织、任务、配置、能力与 SecretHandle 时，从 Agent 顶栏点「控制台」。那里是运维视图，不是首次使用的默认路径。

## 安全边界

- Runtime 是权限、任务、会话和持久状态的唯一权威；Pagurus 只调用公开 API。
- 浏览器不保存 Runtime 密钥、提示词、对话内容或私有文件正文。
- 工具默认受限；写、外联和破坏性动作需要 Runtime 的明确审批。
- 支持包只带版本、数据位置、体积和诊断结果，且敏感内容在 Runtime 端已脱敏。
