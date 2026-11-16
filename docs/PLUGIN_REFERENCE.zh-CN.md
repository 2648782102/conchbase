# 插件与扩展：外部参考与海螺取舍

> 本文是设计输入，不是契约事实源。第二阶段实现以 ADR 为准。

## 参考结论

### Cursor / MCP 治理

- 企业侧允许列表按「命令模式 / URL 模式」批准 MCP 服务器。
- 工具允许列表限制已批准服务器中哪些工具可自动运行。
- 网络控制按服务器声明：allow-all / allowlist / deny-all / unsandboxed。
- 关键点：**批准配置 ≠ 安装/分发服务器**。

对海螺的启发：批准、安装、启用、授权必须是四个不同的动作。我们已有 grant 与审计视图，后续进程外插件必须复用，而不是另建开关。

### 「Declare outside, enforce below」

外部文章对 MCP 的批评很尖锐：MCP server 自己 `tools/list` 声明能力，客户端往往照单全收；这与「capability set 必须在 workload 外声明、由 runtime 强制」的安全原则相反。

对海螺的启发：ADR 0096 的 manifest 必须在 Runtime 侧解析，插件实现不能在运行中扩大工具集合。这个方向正确，第二阶段不能退化成「插件进程自己返回什么就信什么」。

### 沙箱研究

重要事实：stdio MCP 子进程默认继承父进程环境、文件系统权限与网络访问，这不是隔离。真正处理不可信第三方代码需要 Wasm、显式 capability imports、签名验证、网络与文件系统白名单。

对海螺的启发：如果只做 stdio 子进程插件，必须诚实标注它是「故障隔离」而不是「安全沙箱」。不应允许任意第三方二进制成为高权限插件。

### Tools vs Resources

MCP 区分 Tools（可执行、可能有副作用）与 Resources（只读上下文）。这个区分有价值：读与写的风险等级不同。海螺已有 `sideEffect: read/write/external`，与之一致。

## 海螺第二阶段的取舍

1. **不是任意进程插件。** v2 只接受管理员/组合层登记的可信插件清单；不根据模型输出或用户上传路径动态加载。
2. **声明外部化。** manifest 由 Runtime 解析，工具集合固定；插件进程不能通过 discovery 扩大工具面。
3. **四态生命周期。** declared → approved → enabled → granted。批准不代表启用，启用不代表 Agent 可用；最后一步必须 pin 到 Agent revision。
4. **故障隔离优先，安全沙箱诚实标注。** stdio 子进程可以限制崩溃半径，但不等于安全边界。不可信插件需要后续 Wasm/沙箱方案，不在 v2 承诺。
5. **环境最小化。** 插件子进程不继承完整 `process.env`，只获得显式 allowlist 的变量；工作区路径与网络策略由 Runtime 注入，不接受插件自选。
6. **能力审计复用 ADR 0097。** 进程外插件与进程内插件共用 `GET /v1/agents/capability-grants`，不新增第二套权限视图。
