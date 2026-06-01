# Multi-Agent and Agent Swarm GitHub Index

This document groups the repositories mentioned earlier by practical use:

- research and mechanism study
- engineering and production workflows
- swarm and handoff style systems

## Research and Mechanism-Oriented

| Repo | Positioning | Why Read It | Notes |
| --- | --- | --- | --- |
| [camel-ai/camel](https://github.com/camel-ai/camel) | role-playing multi-agent framework | Good for studying roles, agent dialogue, and agent society style collaboration. | Matches the CAMEL paper. |
| [microsoft/autogen](https://github.com/microsoft/autogen) | programmable multi-agent conversation framework | Good for understanding how agents, tools, and humans are composed into reusable conversation patterns. | Important paper lineage; the repo is now in maintenance mode, so new projects should also evaluate newer options. |
| [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | SOP-driven software company style agents | Good for task decomposition and structured intermediate artifacts. | Matches the MetaGPT paper. |
| [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | software development agent team | Good for chat-chain collaboration and coding-agent team design. | Matches the ChatDev paper. |
| [agentscope-ai/agentscope](https://github.com/agentscope-ai/agentscope) | robust multi-agent platform | Good for runtime design, messaging, concurrency, and fault tolerance. | Matches the AgentScope paper. |
| [OpenBMB/AgentVerse](https://github.com/OpenBMB/AgentVerse) | agent simulation and task-solving sandbox | Useful when you want the simulation and agent-society angle. | More research-oriented than production-oriented. |

## Engineering and Production-Oriented

| Repo | Positioning | Why Read It | Notes |
| --- | --- | --- | --- |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | graph-based orchestration runtime | Good for state persistence, approval steps, resumability, and traces. | More workflow engineering than paper-driven research. |
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | Microsoft production-grade agent framework | Good for sequential, concurrent, handoff, and group collaboration workflows. | Strong candidate for new Microsoft-stack projects. |
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | lightweight agent SDK with tools and handoffs | Good for practical tool-using and handoff-based agent systems. | One of the current official OpenAI paths. |
| [google/adk-python](https://github.com/google/adk-python) | Google Agent Development Kit | Good for Gemini, A2A, and multi-agent service integration. | Worth tracking if protocol and deployment matter. |
| [strands-agents/sdk-python](https://github.com/strands-agents/sdk-python) | model-agnostic agent SDK | Good for graph, workflow, and A2A style implementations. | Newer ecosystem option. |

## Swarm and Handoff-Oriented

| Repo | Positioning | Why Read It | Notes |
| --- | --- | --- | --- |
| [openai/swarm](https://github.com/openai/swarm) | lightweight educational swarm example | Good for learning routines and handoffs with minimal machinery. | Best treated as a teaching or experiment repo, not a default production base. |
| [langchain-ai/langgraph-swarm-py](https://github.com/langchain-ai/langgraph-swarm-py) | swarm library on top of LangGraph | Good for combining dynamic handoff with graph-state management. | Useful if you want a resumable swarm design. |
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | handoff-capable agent SDK | Useful for both light swarm patterns and formal tool-calling systems. | A more formal continuation of the same design space. |
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | handoff and group collaboration | Useful for more structured multi-agent workflows with review and enterprise constraints. | Production-oriented. |

## Software-Team Workflow Focus

| Repo | Positioning | Why Read It | Notes |
| --- | --- | --- | --- |
| [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | software company SOP | Good for product, architecture, coding, and testing role splits. | Strong structured-output bias. |
| [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | chat-chain software team | Good for studying conversational collaboration from design through implementation. | Stronger dialogue-chain emphasis. |
| [microsoft/autogen](https://github.com/microsoft/autogen) | general multi-agent conversation | Good for adding tools, humans, and custom agent types to the workflows above. | Still useful to read, but check maintenance status before adopting it. |

## Suggested Reading Order

1. Start with `camel-ai/camel`, `microsoft/autogen`, `FoundationAgents/MetaGPT`, and `OpenBMB/ChatDev` to build intuition for distinct collaboration patterns.
2. Then move to `agentscope-ai/agentscope`, `langchain-ai/langgraph`, and `microsoft/agent-framework` to understand what a stronger runtime adds.
3. If your focus is swarm or dynamic handoff, finish with `openai/swarm`, `openai/openai-agents-python`, and `langchain-ai/langgraph-swarm-py`.

## Practical Selection Hints

- For papers and mechanism research, start with `camel-ai/camel`, `microsoft/autogen`, `FoundationAgents/MetaGPT`, `OpenBMB/ChatDev`, and `agentscope-ai/agentscope`.
- For resumable, traceable, approval-heavy workflows, start with `langchain-ai/langgraph` and `microsoft/agent-framework`.
- For handoff and swarm style systems, start with `openai/openai-agents-python` and `langchain-ai/langgraph-swarm-py`.
- For Microsoft ecosystem workflows, start with `microsoft/agent-framework`.
- For Gemini and A2A, start with `google/adk-python`.
