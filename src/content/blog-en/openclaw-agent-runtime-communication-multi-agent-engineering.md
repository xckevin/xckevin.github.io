---
title: "OpenClaw Agent Deep Dive: From Prompt Container to Schedulable Execution Unit"
lang: en
translationKey: openclaw-agent-runtime-communication-multi-agent-engineering
slug: openclaw-agent-runtime-communication-multi-agent-engineering
excerpt: "A systematic breakdown of the OpenClaw Agent object model, runtime state machine, Session tree, scheduling budgets, tool boundaries, and failure recovery."
publishDate: 2026-03-11
tags:
  - OpenClaw
  - Agent
  - LLM
  - AI
  - Architecture
seo:
  title: "OpenClaw Agent Runtime, Sessions, Budgets, and Tool Governance"
  description: "Analyze OpenClaw Agent as a schedulable execution unit across object models, run loops, Session trees, budgets, tool permissions, and recovery."
  pageType: article
---



Most people understand an Agent as "prompt + model + tools." That definition can explain demos, but it cannot explain production systems. The real question is how an Agent is created, scheduled, constrained, observed, and reclaimed inside a system.

This is where OpenClaw's value lies. It elevates an Agent from a "chat persona" into a runnable and governable Execution Unit.

## 1. Start with the Right Abstraction: An Agent Is Not a Prompt File

In OpenClaw, an Agent can be abstracted as a six-part tuple:

```text
Agent = Identity + Policy + Toolset + Memory + Runtime + Session
```

These six parts solve different problems:

- `Identity`: Who am I, what am I responsible for, and what am I not responsible for?
- `Policy`: Which behaviors are allowed, and which are prohibited?
- `Toolset`: The boundary of callable capabilities.
- `Memory`: State accumulated across turns.
- `Runtime`: The execution engine and lifecycle control.
- `Session`: The context and event trace for this run.

Many problems that look like "the model is not smart enough" are actually caused by one of these parts not being engineered.

## 2. Agent Runtime State Machine: What Happens in One Request?

An OpenClaw Agent is closer to an event processor with a state machine. A minimal run loop can be split into these stages:

```text
RECV -> CONTEXT BUILD -> PLAN -> TOOL SELECT -> EXECUTE -> REFLECT -> EMIT -> PERSIST
```

The key responsibilities of each stage are:

1. `RECV`: Receive the message and bind it to a session.
2. `CONTEXT BUILD`: Assemble system instructions, session history, and memory snippets.
3. `PLAN`: Form the action plan for the current turn.
4. `TOOL SELECT`: Decide whether to call a tool and which tool to call.
5. `EXECUTE`: Execute the tool and collect results.
6. `REFLECT`: Revise the answer or trigger the next step based on execution results.
7. `EMIT`: Output the user-visible result.
8. `PERSIST`: Save traces and state for later turns.

The important point is not that there are more steps. It is that every step can be governed: timeout, retry, audit, and circuit breaking.

## 3. Session Tree Model: Why Multi-Agent Systems Can Stay Controllable

OpenClaw's multi-agent model is not a flat set of conversations. It is more like a Session tree:

```text
main session
  -> subagent session A
  -> subagent session B
  -> acp session C
```

### The Engineering Meaning of Session

- It is a state boundary, not an ordinary chat record.
- It is a permission boundary that determines which tools the session can call.
- It is a failure boundary, so a child session failure does not need to pollute the main session.
- It is an audit boundary, so issues can be replayed down to the specific session.

### Hard Design Constraints

Without depth and width limits, a Session tree can quickly get out of control. In engineering practice, I recommend:

- Depth limit: `maxSpawnDepth = 2`
- Width limit: `maxChildrenPerAgent = 3~5`
- Lifecycle: child sessions must have timeouts and automatic cleanup

## 4. Sub-agent and ACP: Both Are "Doubles," but They Are Fundamentally Different

Many teams mix these two concepts, which eventually makes the scheduling and permission model messy.

### Sub-agent

- Belongs to the OpenClaw internal runtime.
- Has session isolation and relatively controllable scheduling.
- Fits internal task splitting such as parallel retrieval, summarization, and verification.

### ACP Agent

- Belongs to external runtime delegation.
- Strong in ecosystem reuse, weaker in link complexity.
- Fits code execution, external harnesses, and cross-toolchain tasks.

One-line distinction:

```text
Sub-agent = internal compute plane
ACP = external compute plane
```

## 5. Scheduler Perspective: The Core of a Multi-Agent System Is Not Parallelism, but Budget

Most failures are not caused by "it cannot compute the answer," but by "it computes too slowly, too expensively, and too unstably."

OpenClaw Agent scheduling must manage at least four kinds of budget:

1. `Token Budget`: token limits per turn and per task.
2. `Time Budget`: the time window each subtask can occupy.
3. `Concurrency Budget`: the maximum number of concurrent subtasks.
4. `Risk Budget`: quotas and approval budgets for high-risk tool calls.

A deployable scheduling strategy:

```text
Main Agent: low concurrency, high quality
Child Agents: high concurrency, low budget
ACP Agent: low frequency, high value
```

This is much more stable than giving every Agent a high-end model configuration.

## 6. Tool Invocation Protocol: From "Can Call Tools" to "Auditable Tool Calls"

Agent executability comes from tools, but system risk also mainly comes from tools.

I recommend splitting tool policy into three layers:

1. Capability allowlist: expose only the tools required by the task.
2. Invocation constraints: parameter validation, path restrictions, and network domain restrictions.
3. Audit tracing: record `who/why/what/result` for every call.

Example configuration:

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

### Key Principle

`deny > allow > profile`

This priority must be fixed as team-wide consensus. Otherwise, troubleshooting will keep circling around the same ambiguity.

## 7. Context Engineering: Agent Quality Is Not a Model Function, but a Context Function

With the same model and the same tools, quality differences often come from the context assembly strategy.

Use layered context:

```text
L0: System/Policy (stable layer)
L1: Role/Task (task layer)
L2: Session Summary (session compression layer)
L3: Fresh Evidence (latest evidence layer)
```

This solves two practical problems:

- Long sessions exploding the token budget.
- Old context interfering with new tasks.

In engineering practice, `Session Summary` should be a structured summary, not simple truncation.

## 8. Failure Recovery: Design for Exceptions as the Normal Case

The most common failures in multi-agent systems are not model errors, but local link failures:

- Child Agent timeout.
- Tool invocation failure.
- Semantically inconsistent ACP return values.
- Result conflicts that cannot be aggregated.

Recommended recovery strategies:

1. Idempotent retry: retry only idempotent tasks.
2. Partial degradation: subtask failure should not block the entire chain.
3. Structured fallback: return "completed / incomplete / risk items."
4. Human handoff points: allow human confirmation for high-risk steps.

This determines whether the system hard-crashes under pressure or can degrade and recover.

## 9. Observability: Without Observation, There Is No Production-Grade Agent

After an Agent goes online, you need to monitor at least these five metric categories:

1. Per-turn latency: `P50 / P95 / P99`
2. Per-task tokens: main session + child sessions + ACP
3. Tool success rate: broken down by tool
4. Child session lifecycle: created count, timeout count, cleanup count
5. Failure attribution: model, tool, network, and permission

Generate a `trace_id` for every task and use it to connect the main session with all child sessions. Without a unified trace, complex failures are almost impossible to locate.

## 10. A Production Template You Can Reuse Directly

If you want to build a stable Agent system, start from this template:

```text
Controller
  -> Planner
  -> Worker.Search
  -> Worker.Code
  -> Worker.Test
  -> Reviewer
```

Recommended governance parameters:

- `maxSpawnDepth = 2`
- `maxChildrenPerAgent = 3`
- Single-subtask timeout: `30~90s`
- High-risk tools default to deny
- Use ACP only for high-return steps

I recommend a unified output protocol:

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

This significantly reduces the problem of multi-agent output that cannot be aggregated.

## 11. Final Conclusion: The Essence of an OpenClaw Agent Is a Schedulable Execution Unit

As a schedulable execution unit, OpenClaw depends on:

- Whether the runtime state machine is controllable.
- Whether Session boundaries are clear.
- Whether scheduling budgets are stable.
- Whether Tool permissions are auditable.
- Whether failure recovery is predictable.

This is the core of "OpenClaw Agent," and it is also the dividing line that lets Agent systems move from demos to production.
