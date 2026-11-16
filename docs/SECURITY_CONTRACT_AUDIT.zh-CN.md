# 安全与契约复审（2026-11-17）

本次复审覆盖 ADR 0090–0098 后的完整代码面，目标是确认新增能力没有破坏已接受的不变量。

## 结论

**闭环。** 未发现需要回退的契约破坏；发现并修复一处真实环境泄漏风险。

## 核对项

| 不变量 | 结果 | 证据 |
| --- | --- | --- |
| SecretHandle 明文不进入模型/事件/日志/插件 | 通过 | 新增插件与 Git 代码不引用 SecretHandle；无 SecretHandle 接口暴露给插件 |
| 工具必须在 Runtime 策略与审批路径内 | 通过 | 插件工具经 ADR 0096 guard；写/外部 sideEffect 仍经审批；Git 仅只读固定子命令 |
| 默认 loopback-only | 通过 | `runtime-config` 未改动；HTTP 测试与 guardrails 通过 |
| UI 不读写私有文件/数据库 | 通过 | 新增公开路径只返回运行时派生的能力审计；无私有路径字段 |
| 单一 SQLite owner | 通过 | 本轮未新增 store；子存储仍共享 `DatabaseSync` |
| 公开契约版本化 | 通过 | `GET /v1/agents/capability-grants` 由 ADR 0097 记录，OpenAPI 与冻结计数同步至 49 |
| 无调试残留 | 通过 | `src/runtime` 与 `src/http` 无 `console.error/log/warn` |
| 最小子进程环境 | 修复后通过 | 插件与 Git 子进程均不使用 `...process.env` |

## 发现并修复

1. **Git 子进程继承完整环境变量**（真实风险）：原先 `env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }` 会让 git hooks/helper 读到无关凭据。已改为白名单环境，并在 `tests/git-tools.test.ts` 加源码级回归断言。

## 诚实边界

- 子进程插件仍是**故障隔离**，不是安全沙箱：它继承相同的用户级文件系统与网络能力。ADR 0098 已明确写出，未承诺不可信代码隔离。
- `openapi.yaml` 的 `pathCount` 当前语义是「已接受公开路径总数」，不是历史 1.0.0 的 47/48 路径子集。ADR 0097 新增路径后为 49；守卫和状态切片同步。

## 验证

- `npm run check`：通过
- `npm test`：541 / 541 通过
- `node scripts/test-audit.mjs`：untested = none
- `npm run test:coverage`：96.13% line / 82.52% branch / 92.53% function
