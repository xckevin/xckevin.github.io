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
- [Prompt engineering: from core principles to modern practice](/blog/prompt-engineering-core-principles/)
- [Ollama on Apple Silicon: moving toward MLX-backed local inference](/blog/ollama-在-apple-silicon-上全面转向-mlx-驱动预览版/)
- [Android Studio Gemini code assistant: context-aware completion and multi-file refactoring](/blog/android-studio-gemini-ai-assistant/)
- [OpenClaw architecture: Node, Tool, and Skill as executable AI systems](/blog/openclaw-architecture-node-tool-skill-executable-ai-system/)
- [OpenClaw agents: runtime communication and multi-agent engineering](/blog/openclaw-agent-runtime-communication-multi-agent-engineering/)
- [OpenClaw memory design: file-based memory and extensible retrieval](/blog/openclaw-memory-file-based-memory-scalable-retrieval/)

## What Matters in Practice

- Context quality: project files, recent changes, logs, and tests matter more than long generic prompts.
- Tool boundaries: AI agents need clear permissions for reading, editing, running commands, and touching external systems.
- Review discipline: AI-generated code still needs normal engineering review, tests, and ownership.
- Memory design: persistent project knowledge should be deliberate, versioned, and easy to inspect.
- Local models: useful for privacy, latency, and offline tasks, but still constrained by capability, context length, and evaluation quality.

## Next Step

For CI, testing, release gates, and team-level mobile engineering practices, continue with [Mobile Engineering](/en/android-engineering/). For AI features running inside Android apps, continue with [Android On-device AI](/en/android-on-device-ai/).
