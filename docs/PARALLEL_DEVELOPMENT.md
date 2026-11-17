# 并行开发：多个 Codex 会话同时迭代

本文件说明如何在同一台机器上，用多个 Codex 会话并行推进本仓库的不同方向。目标是不需要人工协调端口、数据库和编号。

> 这是开发约定，不是公开 API 契约。运行时行为以 `docs/openapi.yaml` 与已接受的 ADR 为准。

有两种方式可用：手写 `git worktree`（下面「开一个新会话」），或 `codex-parallel`
插件（「用 codex-parallel 插件」一节）。两者都靠 worktree 隔离工作区；区别在于插件
额外提供路径租约、checkpoint 重叠检测和串行集成。

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

## 用 codex-parallel 插件

插件把「租约、重叠检测、集成」做成了工具，适合**两条线真的会互相踩到**的时候。
只推进一个方向时，手写 worktree 更轻。

### 一次性准备

`parallel.toml` 在仓库根，已提交。它声明两个独立仓库：

| id | 路径 | 说明 |
|---|---|---|
| `runtime` | `.` | Conchbase 本体 |
| `console` | `pagurus` | 独立仓库，在父仓库被 `.git/info/exclude` 忽略 |

状态目录必须在所有业务仓库之外：

```sh
export CP_MANIFEST="/path/Conchbase-codex-parallel/parallel.toml"
export CP_STATE="/path/conchbase-parallel-state"
```

### 一轮流程

```sh
# 1. 开一个会话：两个仓库各得一个独立 worktree
codex-parallel start --name <方向>

# 2. 声明要动的模块（见 parallel.toml 的 [modules]）
codex-parallel claim --session <ID> --repo console --module agent-app

# 3. 开发并提交，然后发布 checkpoint
codex-parallel checkpoint --session <ID> --summary "改了什么"
#    -> overlaps / unclaimed 应当为空；unclaimed 非空说明改到了没声明的路径

# 4. 集成预览，确认会跑哪些命令
codex-parallel integrate --session <ID> --preview

# 5. 用户确认后执行；只写集成分支，不碰 main
codex-parallel integrate --session <ID> --authorize-tests
```

### 三个必须知道的坑

**1. 新 worktree 没有 `node_modules`。**
插件不装依赖，直接跑集成门禁会得到 `sh: tsc: command not found`。开完会话先装：

```sh
cd <workspace> && npm ci --ignore-scripts        # runtime
cd <workspace>/pagurus && npm ci --ignore-scripts # console
```

npm 缓存通常是热的，两个仓库合计约 1 秒。

**2. `base` 是提交，不是工作区。**
`parallel.toml` 用 `origin/main`，所以**未推送的本地提交不会出现在新会话里**。
开工前先把要共享的工作推上去，否则新会话会缺文件（manifest 自己就踩过这个：它不在
`origin/main` 时，会话里根本读不到 `parallel.toml`）。

**3. 端口有两套。**
仓库自己的端口派生（分支名哈希，见上表）与插件分配的 `resources.port` 是两套机制。
`npm run dev` 用的是前者；`CONCHBASE_PORT` 显式设置时永远优先。两者不会互相覆盖，
但排查「页面连错 Runtime」时要知道自己在看哪一个。

### 清理

插件只在同时满足以下条件时才允许清理，任何一条不满足都会拒绝并列出原因：

- 每个仓库的会话提交都已进入集成分支
- worktree 里没有已跟踪、未跟踪或被忽略的文件
- 会话不再持有租约
- 会话的资源目录已不存在

注意「空会话」也会因为「session commit is not integrated」被拒绝——它要求的是
**已集成**，而不是**没改动**。所以想回收一个试验会话，正规做法是先释放租约、
把分支集成进去，再 cleanup；不要在插件之外直接删状态目录，那会留下悬空的
worktree 注册和无法追溯的账本记录。

**4. 改一次 `parallel.toml`，所有现存会话一起失效。**

每次操作都会校验「会话创建时的 digest」与「当前 manifest 的 digest」。digest 是
**解析后配置对象**的 sha256，不是文件哈希，所以无法用 `shasum` 直接对比。一旦两者
不等，插件返回 `MANIFEST_CHANGED` 并拒绝**该项目下所有操作**——包括 `status`、
`claim --release` 和新建会话之外的一切。

危险之处在于它是**项目级阻塞**：一个会话带着旧 digest，会让同一个状态目录里的
新会话也用不了，而且旧会话连释放自己的租约都做不到，形成死锁。

调整 manifest 的正确顺序：

1. 先把所有会话的工作提交并推送（它们此后无法再操作）。
2. 修改 `parallel.toml` 并推送。
3. 删除 `$CP_STATE/<projectId>/sessions/*` 里 digest 过期的会话目录，以及它们在
   `leases/` 下对应的文件（先备份整个 `sessions/` 和 `leases/`）。
4. `git worktree prune` 清理悬空注册。
5. 重新 `start`。

所以：**manifest 尽量一次定稿**。尤其是 `[tests]` 与仓库列表，改一次就要付上面的代价。
