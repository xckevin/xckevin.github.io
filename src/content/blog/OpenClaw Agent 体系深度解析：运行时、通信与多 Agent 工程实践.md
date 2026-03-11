---
title: OpenClaw Agent 深度解析：从 Prompt 容器到可调度执行体
excerpt: 这篇文章聚焦 OpenClaw Agent 本体，系统拆解 Agent 对象模型、运行状态机、Session 树、调度与预算、Tool 权限边界和失败恢复机制，给出可直接落地的工程方案。
publishDate: 2026-03-11
tags:
  - OpenClaw
  - Agent
  - LLM
  - AI
  - 架构设计
seo:
  title: OpenClaw Agent 深度解析：从 Prompt 容器到可调度执行体
  description: 深入解析 OpenClaw Agent 的对象模型、run loop、session 树、调度策略、工具权限与故障治理。
---



多数人把 Agent 理解成“提示词 + 模型 + 工具”。这个定义能解释 Demo，解释不了生产系统。你真正要回答的是：一个 Agent 在系统里如何被创建、调度、约束、观测和回收。

OpenClaw 的价值就在这里。它把 Agent 从“聊天人格”提升为“可运行、可治理的执行体（Execution Unit）”。

## 一、先建立正确抽象：Agent 不是提示词文件

在 OpenClaw 里，Agent 可以抽象成 6 元组：

```text
Agent = Identity + Policy + Toolset + Memory + Runtime + Session
```

这 6 项分别解决不同问题：

- `Identity`：我是谁，负责什么，不负责什么。
- `Policy`：哪些行为允许，哪些行为禁止。
- `Toolset`：可调用能力边界。
- `Memory`：跨轮次状态沉淀。
- `Runtime`：执行引擎与生命周期控制。
- `Session`：这次运行的上下文与事件轨迹。

很多“看似模型不聪明”的问题，本质是其中某一项没有工程化。

## 二、Agent 运行状态机：一轮请求到底发生了什么

OpenClaw Agent 更接近一个有状态机的事件处理器。最小 run loop 可以拆成以下阶段：

```text
RECV -> CONTEXT BUILD -> PLAN -> TOOL SELECT -> EXECUTE -> REFLECT -> EMIT -> PERSIST
```

每个阶段的关键职责：

1. `RECV`：接收消息，绑定会话。
2. `CONTEXT BUILD`：拼装系统指令、会话历史、记忆片段。
3. `PLAN`：形成当前轮行动计划。
4. `TOOL SELECT`：决策是否调用工具、调用哪个工具。
5. `EXECUTE`：执行工具，收集结果。
6. `REFLECT`：根据执行结果修正答案或触发下一步。
7. `EMIT`：输出用户可见结果。
8. `PERSIST`：保存轨迹与状态，供后续轮次使用。

关键点不在“多了几个步骤”，而在于每一步都可以被治理：超时、重试、审计、熔断。

## 三、Session 树模型：为什么多 Agent 还能维持可控

OpenClaw 的多 Agent 不是“平铺会话”，而更像一棵 Session 树：

```text
main session
  -> subagent session A
  -> subagent session B
  -> acp session C
```

### Session 的工程意义

- 是状态边界，不是普通聊天记录。
- 是权限边界，决定该会话能调什么工具。
- 是故障边界，子会话失败不必污染主会话。
- 是审计边界，问题可回放到具体会话。

### 设计上的硬约束

如果没有深度与宽度限制，Session 树会迅速失控。工程上建议：

- 深度限制：`maxSpawnDepth = 2`
- 宽度限制：`maxChildrenPerAgent = 3~5`
- 生命周期：子会话必须有超时与自动回收

## 四、Sub-agent 与 ACP：同样是“分身”，本质完全不同

很多团队会混用这两个概念，最后导致调度和权限模型混乱。

### Sub-agent

- 属于 OpenClaw 内部运行时。
- 会话隔离，调度相对可控。
- 适合并行检索、汇总、校验等内部任务拆分。

### ACP Agent

- 属于外部运行时委托。
- 强在生态复用，弱在链路复杂度。
- 适合代码执行、外部 harness、跨工具链任务。

一句话区分：

```text
Sub-agent = 内部计算平面
ACP = 外部计算平面
```

## 五、调度器视角：多 Agent 系统的核心不是并行，而是预算

多数故障不是“算不出来”，而是“算得太慢、太贵、太不稳定”。

OpenClaw Agent 调度至少管理 4 类预算：

1. `Token Budget`：每轮和每任务的 token 上限。
2. `Time Budget`：每个子任务可占用的时间窗口。
3. `Concurrency Budget`：并发子任务数量上限。
4. `Risk Budget`：高风险工具调用配额与审批额度。

可落地的调度策略：

```text
主 Agent 低并发高质量
子 Agent 高并发低预算
ACP Agent 低频高价值
```

这比“所有 Agent 都开高配模型”稳定得多。

## 六、Tool 调用协议：从“会调工具”到“调得可审计”

Agent 可执行性来自 Tool，但系统风险也主要来自 Tool。

建议把 Tool 策略分成 3 层：

1. 能力白名单：只开放任务必需工具。
2. 调用约束：参数校验、路径限制、网络域名限制。
3. 审计追踪：每次调用记录 `who/why/what/result`。

配置示例：

```json
{
  "tools": {
    "profile": "standard",
    "allow": ["sessions_spawn", "web", "filesystem"],
    "deny": ["system_shutdown", "network_admin"]
  },
  "exec": {
    "security": "allowlist",
    "ask": "on-miss"
  }
}
```

### 关键原则

`deny > allow > profile`

这条优先级必须固定在团队共识里，否则排障会反复绕圈。

## 七、上下文工程：Agent 质量不是模型函数，而是上下文函数

同一个模型、同一套工具，效果差异常来自上下文拼装策略。

建议采用分层上下文：

```text
L0: System/Policy（稳定层）
L1: Role/Task（任务层）
L2: Session Summary（会话压缩层）
L3: Fresh Evidence（最新证据层）
```

这样能解决两个现实问题：

- 长会话 token 爆炸。
- 旧上下文干扰新任务。

工程实践里，`Session Summary` 应该是结构化摘要，而不是简单截断。

## 八、失败恢复：要把“异常”当常态设计

多 Agent 里最常见的失败不是模型报错，而是链路局部失败：

- 子 Agent 超时。
- 工具调用失败。
- ACP 返回语义不一致。
- 结果冲突无法聚合。

推荐恢复策略：

1. 幂等重试：只重试可幂等任务。
2. 部分降级：子任务失败不阻断整条链路。
3. 结构化回退：返回“已完成/未完成/风险项”。
4. 人工接管点：高风险步骤允许人工确认。

这决定了系统在压力场景下是“硬崩”还是“可降级可恢复”。

## 九、可观测性：没有观测，就没有生产级 Agent

Agent 上线后，最少要看这 5 类指标：

1. 每轮时延：`P50 / P95 / P99`
2. 每任务 token：主会话 + 子会话 + ACP
3. 工具成功率：按工具维度拆分
4. 子会话生命周期：创建数、超时数、回收数
5. 失败归因：模型、工具、网络、权限四类

建议每个任务都生成 `trace_id`，把主会话与所有子会话串起来。没有统一 trace，复杂故障几乎无法定位。

## 十、一个可直接复用的生产模板

如果你要做稳定的 Agent 系统，建议从这套模板起步：

```text
Controller
  -> Planner
  -> Worker.Search
  -> Worker.Code
  -> Worker.Test
  -> Reviewer
```

治理参数建议：

- `maxSpawnDepth = 2`
- `maxChildrenPerAgent = 3`
- 单子任务超时 `30~90s`
- 高风险工具默认 deny
- ACP 仅用于高收益步骤

输出协议建议统一为：

```json
{
  "task_id": "t-2048",
  "status": "done|partial|failed",
  "summary": "...",
  "evidence": [],
  "risk": [],
  "next_action": "..."
}
```

这能显著降低“多 Agent 输出不可汇总”的问题。

## 十一、最终结论：OpenClaw Agent 的本质是“可调度执行体”

OpenClaw作为可调度执行体：

- 运行状态机是否可控。
- Session 边界是否清晰。
- 调度预算是否稳定。
- Tool 权限是否可审计。
- 故障恢复是否可预期。

这才是“OpenClaw Agent”的核心，也是Agent系统能从 Demo 走向生产的分水岭。
