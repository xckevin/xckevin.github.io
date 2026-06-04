---
title: AI Development Tools
lang: en
translationKey: ai-dev-tools
seo:
  title: AI Development Tools and Agent Engineering
  description: Notes on Codex, prompt engineering, Ollama, OpenClaw, local models, tool orchestration, and AI agent engineering practices.
---

This topic covers AI-assisted development tools and agent engineering.

AI tooling in real engineering work is more than chat. Useful systems need to read code, edit files, run tests, respect permissions, summarize project knowledge, and fit team workflows. This page collects notes about Codex, prompt engineering, local models, OpenClaw, tool orchestration, memory design, and multi-agent engineering.

The focus is practical: how to use AI tools without losing code quality, review discipline, or ownership of engineering decisions.

## Core Articles

- [How to use OpenAI Codex in real development workflows](/blog/openai-如何使用-codex/)
- [Prompt engineering: from core principles to modern practice](/blog/提示词工程从核心原则到前沿实践/)
- [Ollama on Apple Silicon: moving toward MLX-backed local inference](/blog/ollama-在-apple-silicon-上全面转向-mlx-驱动预览版/)
- [Android Studio Gemini code assistant: context-aware completion and multi-file refactoring](/blog/2026-03-12-深入_android_studio_gemini_代码助手_从上下文感知补全到多文件重构的_ai_辅/)
- [OpenClaw architecture: Node, Tool, and Skill as executable AI systems](/blog/openclaw-架构拆解nodetoolskill-如何把-ai-变成可执行系统/)
- [OpenClaw agents: runtime communication and multi-agent engineering](/blog/openclaw-agent-体系深度解析运行时通信与多-agent-工程实践/)
- [OpenClaw memory design: file-based memory and extensible retrieval](/blog/openclaw-memory-设计解析从文件化记忆到可扩展检索架构/)

## What Matters in Practice

- Context quality: project files, recent changes, logs, and tests matter more than long generic prompts.
- Tool boundaries: AI agents need clear permissions for reading, editing, running commands, and touching external systems.
- Review discipline: AI-generated code still needs normal engineering review, tests, and ownership.
- Memory design: persistent project knowledge should be deliberate, versioned, and easy to inspect.
- Local models: useful for privacy, latency, and offline tasks, but still constrained by capability, context length, and evaluation quality.

## Next Step

For CI, testing, release gates, and team-level mobile engineering practices, continue with [Mobile Engineering](/en/android-engineering/). For AI features running inside Android apps, continue with [Android On-device AI](/en/android-on-device-ai/).
