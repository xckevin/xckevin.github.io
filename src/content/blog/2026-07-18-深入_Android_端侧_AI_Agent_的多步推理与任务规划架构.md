---
title: 深入 Android 端侧 AI Agent 的多步推理与任务规划架构
excerpt: 本文剖析 Function Calling 在多步任务中的依赖断裂、分支缺失和上下文膨胀三大短板，提出 ReAct 推理循环与 DAG 任务分解相结合的分层规划架构，并分享端侧部署中内存调度、失败回退和规划缓存等工程实践。
publishDate: '2026-07-18'
tags:
- Android
- AI Agent
- 端侧推理
- 任务规划
- 架构设计
seo:
  title: 深入 Android 端侧 AI Agent 的多步推理与任务规划架构
  description: 剖析 Function Calling 在多步任务中的局限性，提出 ReAct + DAG 分层规划架构，涵盖内存调度、失败回退、规划缓存等端侧落地的工程实践与优化策略。
---

在做端侧 AI Agent 时，我踩过一个典型的坑：用户说「帮我把昨天拍的那张表格照片转成 Excel，然后发到工作群里」，模型通过 Function Calling 顺利调用了图片搜索和文件转换接口，但发给群的那一步，它传了空路径——因为转换还没完成，文件路径根本没返回。

这个问题的本质不是模型不够聪明，而是 **Function Calling 只解决了工具调用，没解决任务编排**。端侧 Agent 需要一个独立的规划层来管理多步推理中的状态、依赖和异常恢复。

## Function Calling 的天花板

标准的 Function Calling 流程是线性的：用户输入 → 模型决策是否调工具 → 调工具 → 返回结果让模型继续生成。单步操作这条流水线跑得很顺畅，但面对多步任务立刻暴露三个短板：

**依赖链断裂**。工具 A 的输出是工具 B 的输入，但模型可能在 A 的结果回来之前就决定了 B 的参数——它不懂「等一等」。

**分支路径缺失**。用户意图可能有多种实现方式：传文件可以用邮件、IM、网盘链接。单轮决策没法回退尝试备选方案。

**上下文膨胀**。每轮调用都把历史工具结果塞进 prompt，5 步之后 token 消耗翻倍，端侧推理延迟直线上升。

在 Mate 60 Pro 上跑一个 7B 量化模型，超过 3 步的工具链调用就能感觉到明显卡顿。端侧的规划层不能只是把云端方案照搬过来，得直面内存和算力约束。

## ReAct：让模型边想边做

规划层的第一个可落地方案是 ReAct（Reasoning + Acting）范式。核心思路：每一步都让模型输出一个三元组——思考（Thought）、行动（Action）、观察（Observation），然后在观察结果的基础上继续下一轮思考。

```kotlin
data class AgentStep(
    val thought: String,       // 模型推理："需要先找到昨天的照片"
    val action: ToolCall?,     // 具体操作：调用 searchPhotos()
    val observation: String    // 工具返回："找到 3 张表格照片"
)

class ReActLoop(
    private val model: LocalLLM,
    private val tools: Map<String, AgentTool>
) {
    suspend fun run(userInput: String): String {
        var context = userInput
        repeat(MAX_STEPS) {
            val step = model.generateStep(context)
            if (step.action == null) return step.thought // 模型认为任务完成
            val result = tools[step.action.name]?.execute(step.action.params)
            context += "\nObservation: ${result ?: "执行失败"}"
        }
        return "任务超出步数限制"
    }
}
```

这段循环就是 ReAct 的全部骨架。每轮推理明确记录「在想什么—做了什么—得到了什么」，模型据此判断下一步。

我在项目里用这个结构跑通了 5 个典型场景，成功率从单轮 Function Calling 的 40% 左右提升到 75%。但问题也暴露了：简单的循环无法处理需要并行调用的子任务，而且「边想边做」的串行执行在端侧延迟叠加后体验很差。

## 分层任务分解：先规划，再执行

实际改进方案是在 ReAct 之前加一层 **任务规划（Task Planning）**。把模型的一次推理拆成两个阶段：

1. **规划阶段**：分析用户意图，输出一个有向无环图（DAG）的子任务序列
2. **执行阶段**：按 DAG 的拓扑顺序调度执行，注入中间结果

```kotlin
data class TaskDAG(
    val tasks: List<SubTask>,
    val dependencies: Map<Int, List<Int>> // taskId → 依赖的 taskId 列表
)

data class SubTask(
    val id: Int,
    val description: String,   // 面向模型的可读描述
    val tool: String,          // 目标工具名
    val params: Map<String, Any>,
    val status: TaskStatus = TaskStatus.PENDING
)
```

规划阶段的 prompt 强调输出结构化任务，而非直接调用工具：

```
分析用户请求，拆解为原子子任务。每个子任务包含：
- id: 数字编号
- description: 任务描述
- tool: 所需工具（如需）
- depends_on: 依赖的子任务 id 列表

要求：子任务粒度尽可能小，无依赖关系的子任务可以并行执行。
```

这样拆分后，模型只需要在规划阶段做一次深度推理，后续执行交给确定性调度器。7B 模型做一次规划推理 vs 每步都推理，延迟从 3 秒 × 4 步降到 3 秒 × 1 次 + 工具执行时间，体感差别很大。

## DAG 调度引擎的端侧优化

有了 DAG 不代表万事大吉。实际执行过程中，我遇到了几个只在端侧才会放大的问题。

**内存约束下的并行调度**。云上可以无脑并行所有无依赖任务，但在端侧同时跑 3 个工具——比如图片分类 + OCR + 文件转码——内存直接爆了。调度器需要感知任务的计算类型：

```kotlin
class ResourceAwareScheduler(private val maxConcurrency: Int = 2) {
    fun schedule(tasks: List<SubTask>, deps: Map<Int, List<Int>>) {
        val ready = tasks.filter { task ->
            deps[task.id]?.all { depId ->
                tasks.find { it.id == depId }?.status == TaskStatus.COMPLETED
            } ?: true
        }
        val (heavyTasks, lightTasks) = ready.partition { it.cost == TaskCost.HEAVY }
        
        // 重量级任务最多并行 1 个，轻量级可以并行
        heavyTasks.take(1).forEach { execute(it) }
        lightTasks.take(maxConcurrency - heavyTasks.size).forEach { execute(it) }
    }
}
```

**依赖失败的回退路径**。端侧工具更容易失败——文件权限问题、传感器数据异常、模型推理超时。DAG 的依赖关系如果写死，一个叶子节点失败就让整条链断裂。需要给每个任务定义 fallback：

```kotlin
data class SubTask(
    // ... 原有字段
    val fallback: FallbackStrategy? = null
)

sealed class FallbackStrategy {
    data class Retry(val maxAttempts: Int = 2) : FallbackStrategy()
    data class AlternativeTool(val toolName: String) : FallbackStrategy()
    object Skip : FallbackStrategy() // 非关键任务允许跳过
}
```

**部分执行与增量返回**。等所有子任务完成再返回结果，用户看到的是长时间白屏。我的做法是：可展示的中间结果立刻回调 UI，比如「已找到照片」「正在识别表格」这种状态更新，本质上是把 Agent 的思考过程做了透传。

## 模型选择与推理策略

端侧规划对模型有两个额外要求：**指令遵循能力**和**结构化输出**。

指令遵循差的模型在规划阶段容易出现幻觉——编造不存在的工具、搞错参数类型、生成循环依赖。我在 4 款端侧模型上做了对比测试，7B 级别的 Qwen 和 Gemma 系列能稳定输出 JSON 格式的任务列表，但部分精调不足的模型会在 `depends_on` 里写出不存在的 taskId。

我在工程上加了一层轻量校验：

```kotlin
fun validateDAG(dag: TaskDAG): Result<TaskDAG> {
    val taskIds = dag.tasks.map { it.id }.toSet()
    // 检查所有依赖引用的任务 id 是否存在
    dag.dependencies.values.flatten().forEach { depId ->
        if (depId !in taskIds) return Result.failure(IllegalStateException("依赖 $depId 不存在"))
    }
    // 检查无环
    if (hasCycle(dag)) return Result.failure(IllegalStateException("存在循环依赖"))
    return Result.success(dag)
}
```

校验失败的规划结果不要直接丢弃，而是把错误信息注入下一轮规划 prompt——模型往往能自动修正。这个「校验—反馈—重规划」的小闭环比直接报错更符合 Agent 的自主决策理念。

结构化输出方面，端侧模型对 JSON Schema 约束的支持还不成熟。我更倾向于用较弱的约束——在 prompt 中描述格式要求，解析后做上述校验——而不是依赖 model-level 的 constrained decoding。后者的推理速度损失在端侧太明显了。

## 落地实践中的三条准则

规划层的抽象程度决定了 Agent 的泛化能力和运行稳定性的平衡点。做得太少，还是靠模型即兴发挥；做得太多，业务接入成本陡增。三条实践准则：

**工具粒度对齐任务分解粒度**。「搜索照片」这种粗粒度工具会让规划层无事可做，而「读取相册」「筛选日期」「降采样」「OCR 识别」这种拆分又过度暴露实现细节。把工具定义为一个可独立完成且有明确输出的操作单元，通常就是对的粒度。

**规划缓存是端侧的必备优化**。相似的用户 intent——「把昨天的表发给 XX」和「把前天的表发给 YY」——DAG 结构完全一致，只差参数。对规划结果做语义相似度匹配后复用，能省掉一次完整的模型推理。

**日志即 observability**。端侧 Agent 运行在用户设备上，出了问题没法远程排查。每一步的 thought、action、observation 全部落盘，同时暴露一个最小的性能面板——每步耗时、token 消耗、工具调用成功率。这些数据直接指导 prompt 迭代和模型选型。

---

规划层不是银弹。对于单步查询类任务，多加一层 DAG 解析反而是负优化。判断是否需要的标准很朴素：你的 Agent 是否经常因为多步依赖而「忘记」上一步的结果？如果是，那就是时候了。
