# Boss Mode 1.1.0 浏览器验收记录

> 本文件记录一次真实浏览器/真实开发服务验收，不替代自动化测试和 OpenAPI 契约。临时服务、fake provider 与临时 SQLite 数据库均在本地 loopback，不使用公网或真实凭证。

## 验收环境

- Conchbase Runtime：`http://127.0.0.1:4318`
- Pagurus Vite：`http://127.0.0.1:5173`
- fake Magpie-compatible provider：`http://127.0.0.1:3456`
- 临时数据库：`/tmp/conchbase-visual-check/runtime.sqlite`
- 浏览器视口：默认桌面视口与 `375 × 812` 窄屏视口

## 数据准备

按固定顺序提交主会话意图：

1. `Start project alpha and hire worker alpha.`
2. `Start project beta and hire worker beta.`
3. 在 Pagurus 组织台点击 Attention「回答」。
4. `Archive project alpha and offboard its worker.`
5. `Resume project alpha after revalidation.`

公开 session 显示 2 个项目、2 个员工、2 个报告、1 个 Attention；session 响应不含 raw `events`。

## 已验证

- 桌面首屏：连接状态、自动刷新、刷新按钮、最近同步时间、主会话意图输入框、5 项组织摘要均可见。
- 主会话时间线：17 条初始事实按 sequence 展示；Attention 回答后增量游标追加第 18 条；归档/恢复后追加 offboard、quiet、archive、revalidate、resume、worker resume 等结构化事件。
- Attention 优先队列：开放状态显示「回答/撤回」；点击回答后状态变为 `answered`，待处理计数从 1 变为 0，详情保留 digest 和 `expectedVersion`。
- 项目与归档：项目列表可切换，项目线程事实随选中项目更新；归档后项目状态变为 `archived`，恢复后变为 `resumed`。
- 报告、工作项、动态提案与委派审计：均显示 Runtime 已发布摘要和状态，不显示明文、私有路径或本地推演状态。
- 交互：提交意图、Attention 回答、项目切换均通过 published Runtime API 完成；`202` 后显示“等待 Runtime 发布新状态”。
- 键盘：Tab 焦点落在「刷新组织状态」按钮时可见 `outline: solid`，颜色为既有的可见焦点色；跳过链接存在。
- 控制台：仅 Vite connected 与 React DevTools 信息，无错误、无异常请求日志。
- 窄屏 `375 × 812`：左侧导航压缩为图标，组织摘要和卡片变为单栏，时间与项目详情无横向溢出。

## 截图证据

- 桌面：`/tmp/conchbase-visual-check/organization-console-desktop.png`
- 窄屏：`/tmp/conchbase-visual-check/organization-console-mobile.png`

> 截图保存在本机临时验收目录，不加入仓库；本文件只记录验收事实与可复跑步骤。
