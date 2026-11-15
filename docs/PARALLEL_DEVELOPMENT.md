# 并行开发：多个 Codex 会话同时迭代

本文件说明如何在同一台机器上，用多个 Codex 会话并行推进本仓库的不同方向。目标是不需要人工协调端口、数据库和编号。

> 这是开发约定，不是公开 API 契约。运行时行为以 `docs/openapi.yaml` 与已接受的 ADR 为准。

## 一句话结论

Git worktree 本身就是隔离的；**需要隔离的是端口、数据库、工作区和文档编号**。仓库已经把这几件事做成了自动派生。

## 开一个新会话

```sh
# 1. 从最新 main 拉一个独立工作树
git worktree add ../Conchbase-<方向> -b codex/<方向>

# 2. 进入并安装依赖（约 1–2 秒，npm 缓存通常是热的）
cd ../Conchbase-<方向> && npm ci

# 3. 启动；端口、数据库、工作区会按分支名自动派生并打印
npm run dev
```

启动时会打印本次会话的身份，先读它再继续：

```
  session  codex-my-direction
  bind     127.0.0.1:4345
  database /path/Conchbase-my-direction/.conchbase/codex-my-direction/runtime.sqlite
  workspace /path/Conchbase-my-direction/.conchbase/codex-my-direction/workspace
```

主检出（`Conchbase` 本身）保持历史行为：端口 `4318`、库 `.conchbase/runtime.sqlite`、工作区为仓库根目录。

## 派生规则

| 项目 | 主检出 | 链接工作树 |
|---|---|---|
| 端口 | `4318` | 由分支 slug 哈希到 `4320–4399` |
| 数据库 | `.conchbase/runtime.sqlite` | `.conchbase/<slug>/runtime.sqlite` |
| 工作区 | 仓库根 | `.conchbase/<slug>/workspace` |
| Console 端口 | `5173` | `5173 + (端口 − 4318)` |
| Console 代理 | `http://127.0.0.1:4318` | 指向本会话自己的端口 |

显式的环境变量永远优先，需要时可以直接覆盖：

```sh
CONCHBASE_PORT=4360 CONCHBASE_DB=/tmp/x.sqlite npm run dev
CONCHBASE_URL=http://127.0.0.1:4360 npm run dev   # 在 pagurus 目录
```

## 为什么必须隔离数据库

一个 Runtime 独占一个 SQLite 文件（ADR 0011）。两个会话共用一个库会同时写 organization 状态和 `Task` 行，事后无法判断哪次写入属于哪个会话。派生目录让每个会话的运行时数据彼此不可见。

## 为什么必须隔离 Console 代理

`pagurus` 的开发代理原先写死指向 `127.0.0.1:4318`。在工作树里改控制台时，页面读到的其实是**主检出**的 Runtime，改动看起来没生效，或者更糟：旧行为被当成新行为。现在代理跟随本会话端口。

## ADR 编号

不要手工挑「下一个编号」。用分配器，它用独占创建避免两个会话抢到同一个号：

```sh
node scripts/next-adr.mjs "Per-worktree isolation"
# -> docs/decisions/0078-per-worktree-isolation.md
```

文件会以 `Status: **draft; not accepted**` 创建，补完正文后自行改成 accepted。

## 项目状态分片

`docs/PROJECT_STATUS.json` 里的 `implemented` 和 `validationEvidence` 是只增数组，两个会话同时追加必然冲突。它们现在按记录拆到 `docs/status/`：

```sh
node scripts/status-slices.mjs split   # JSON -> docs/status/
node scripts/status-slices.mjs merge   # docs/status/ -> JSON
node scripts/status-slices.mjs check   # 校验两边一致（CI 也会跑）
```

新增一条记录的做法是**加一个文件**，而不是改数组：

```sh
cat > docs/status/implemented/my-new-slice.json <<'JSON'
{ "id": "my-new-slice", "summary": "…", "evidence": "src/…" }
JSON
node scripts/status-slices.mjs merge
```

`npm test` 会执行 `check`，两边不一致直接失败。

## 仍然会冲突的地方

诚实说明：以下文件是单文件，多个会话同时改仍会冲突，合并时需人工处理。

- `docs/AI_TASK_QUEUE.md`
- `README.md` / `README.zh-CN.md`
- `docs/openapi.yaml`（新增路径时）
- `src/runtime` 下被两个方向同时改动的模块

缓解办法：

1. 开始前先声明方向，尽量让不同会话改不同模块。
2. 收尾时先 `git fetch && git rebase origin/main`，再解决冲突。
3. 冲突集中在入口文档时，保留双方内容再手工排序，不要整段覆盖。

## 收尾

```sh
npm run check && npm test && npm run build
git push -u origin codex/<方向>
```

工作树用完可以归档：

```sh
git worktree remove ../Conchbase-<方向>
git branch -d codex/<方向>   # 已合并后
```
