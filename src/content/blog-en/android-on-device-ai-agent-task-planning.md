---
title: "On-Device AI Agent Task Planning: Beyond Function Calling"
lang: en
translationKey: android-on-device-ai-agent-task-planning
slug: android-on-device-ai-agent-task-planning
excerpt: "Why Function Calling alone is not enough for multi-step on-device AI agents, and how ReAct loops and DAG-based task planning improve reliability under mobile constraints."
publishDate: '2026-07-18'
tags:
- "Android"
- "On-Device AI"
- "LLM"
- "Agent"
seo:
  title: "On-Device AI Agent Task Planning Beyond Function Calling"
  description: "A practical look at ReAct loops and DAG-based task planning for multi-step on-device AI agents under memory and latency constraints."
  pageType: article
---

While building an on-device AI agent, I hit a classic pitfall: a user said, "Help me convert the table photo I took yesterday into an Excel file, then send it to the work group." The model successfully called the image search and file conversion APIs through Function Calling, but at the send-to-group step it passed an empty path—because the conversion hadn't finished, and the file path was never returned.

The essence of this problem is not that the model isn't smart enough; it's that **Function Calling solves tool invocation but not task orchestration**. An on-device agent needs an independent planning layer to manage state, dependencies, and error recovery in multi-step reasoning.

## The Limits of Function Calling

The standard Function Calling flow is linear: user input → model decides whether to call a tool → call the tool → return the result for the model to continue generating. This pipeline runs smoothly for single-step operations, but multi-step tasks quickly expose three shortcomings:

**Broken dependency chains.** Tool A's output is the input for Tool B, but the model may decide Tool B's parameters before Tool A's result comes back—it doesn't understand "wait."

**No branching paths.** A user's intent may have multiple possible implementations: sending a file could use email, IM, or a cloud drive link. A single-round decision can't fall back to alternative approaches.

**Context bloat.** Each round stuffs all previous tool results into the prompt; after five steps, token consumption doubles and on-device inference latency climbs sharply.

Running a 7B quantized model on a Mate 60 Pro, tool-chain calls beyond three steps already feel noticeably janky. The on-device planning layer can't just copy a cloud solution; it has to confront memory and compute constraints directly.

## ReAct: Letting the Model Think and Act as It Goes

The first viable approach for a planning layer is the ReAct (Reasoning + Acting) paradigm. The core idea: at every step, have the model output a triple—Thought, Action, Observation—then continue to the next round of thinking based on the observation.

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

This loop is the entire skeleton of ReAct. Each round of inference explicitly records "what it's thinking—what it did—what it got back," and the model uses that to decide the next step.

In my project, this structure successfully ran through five typical scenarios, raising the success rate from roughly 40% with single-round Function Calling to 75%. But it also exposed problems: a simple loop can't handle subtasks that require parallel calls, and the serial "think then act" execution feels poor on-device as latency accumulates.

## Layered Task Decomposition: Plan First, Execute Later

The practical improvement is to add a **Task Planning** layer before ReAct. Split the model's inference into two phases:

1. **Planning phase**: analyze user intent and output a directed acyclic graph (DAG) of subtasks
2. **Execution phase**: schedule execution in DAG topological order, injecting intermediate results

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

The planning-phase prompt emphasizes outputting structured tasks instead of directly calling tools:

```
分析用户请求，拆解为原子子任务。每个子任务包含：
- id: 数字编号
- description: 任务描述
- tool: 所需工具（如需）
- depends_on: 依赖的子任务 id 列表

要求：子任务粒度尽可能小，无依赖关系的子任务可以并行执行。
```

After this decomposition, the model only needs to perform one deep inference during the planning phase; subsequent execution is handed to a deterministic scheduler. Comparing one planning inference versus inference at every step for a 7B model, latency drops from 3 seconds × 4 steps to 3 seconds × 1 plus tool execution time—a huge difference in user experience.

## On-Device Optimizations for the DAG Scheduling Engine

Having a DAG doesn't mean everything is solved. During actual execution, I ran into several problems that only become amplified on-device.

**Parallel scheduling under memory constraints.** In the cloud you can blindly parallelize all independent tasks, but on-device running three tools at once—say image classification + OCR + file transcoding—blows up memory immediately. The scheduler needs to be aware of each task's compute type:

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

**Fallback paths for dependency failures.** On-device tools fail more easily—file permission issues, abnormal sensor data, model inference timeouts. If DAG dependencies are fixed, one leaf node failure breaks the entire chain. Each task needs a defined fallback:

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

**Partial execution and incremental returns.** Waiting for all subtasks to finish before returning a result leaves users staring at a blank screen for a long time. My approach: immediately push displayable intermediate results to the UI—status updates like "Found the photo" and "Recognizing the table"—which essentially surfaces the agent's thinking process.

## Model Selection and Inference Strategy

On-device planning imposes two additional requirements on the model: **instruction following** and **structured output**.

Models with poor instruction following tend to hallucinate during planning—inventing nonexistent tools, getting parameter types wrong, generating circular dependencies. I ran comparison tests on four on-device models. The 7B-level Qwen and Gemma series could consistently output task lists in JSON format, but some insufficiently fine-tuned models wrote nonexistent taskIds in `depends_on`.

I added a lightweight validation layer in the project:

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

Don't discard a planning result just because validation fails; instead, inject the error message into the next planning prompt—the model can often correct itself. This small "validate–feedback–replan" loop fits the agent's autonomous decision-making philosophy better than simply raising an error.

For structured output, on-device model support for JSON Schema constraints is still immature. I prefer weaker constraints—describe the format requirements in the prompt, then run the validation above after parsing—rather than relying on model-level constrained decoding. The inference speed penalty of the latter is too noticeable on-device.

## Three Guidelines for Production Practice

The abstraction level of the planning layer determines the balance between the agent's generalization ability and runtime stability. Do too little and you're still relying on the model to improvise; do too much and integration costs for each feature shoot up. Three practical guidelines:

**Align tool granularity with task decomposition granularity.** A coarse-grained tool like "search photos" leaves the planning layer with nothing to do, while splitting it into "read the photo album," "filter by date," "downsample," and "OCR recognition" over-exposes implementation details. Defining a tool as an operation unit that can complete independently and has a clear output is usually the right granularity.

**Planning cache is a required on-device optimization.** Similar user intents—"send the table from yesterday to XX" and "send the table from the day before yesterday to YY"—have exactly the same DAG structure; only the parameters differ. Reusing a planning result after semantic similarity matching saves a full model inference.

**Logs are observability.** An on-device agent runs on the user's device, so problems can't be diagnosed remotely. Persist every step's thought, action, and observation to disk, and also expose a minimal performance panel—time per step, token consumption, tool call success rate. This data directly guides prompt iteration and model selection.

---

The planning layer is not a silver bullet. For single-step query tasks, adding a DAG parsing layer is actually a negative optimization. The criterion for deciding whether you need it is simple: does your agent frequently "forget" the result of the previous step because of multi-step dependencies? If so, then it's time.
