# Agent Swarm Design

## Goal

Build an agent swarm harness on top of the existing relay, host-agent, and
managed Codex session system.

The first target is not a fully autonomous multi-agent research platform. The
first target is a practical control layer that can:

- turn a useful conversation into a reusable agent case;
- run one case as a specialized single agent;
- run several cases or roles together as a coordinated swarm;
- show each agent's live state, transcript, files, and artifacts;
- stop, queue, resume, export, and archive the run.

## Core idea

There are three different concepts that should stay separate.

### Role

A role is a generic job description:

- explorer;
- implementer;
- reviewer;
- tester;
- summarizer;
- release captain.

Roles are reusable templates. They should be small and predictable.

### Agent Case

An agent case is a reusable capability distilled from a real conversation.

Example:

- "HPC relay debugger";
- "large file transfer maintainer";
- "Codex app-server log interpreter";
- "mobile UI export-flow tester".

An agent case is not a model and not a long-running process. It is a
versioned prompt bundle plus metadata that can be injected into a new managed
Codex session.

### Swarm Run

A swarm run is a live harness execution. It creates one or more managed Codex
sessions, assigns each one a role or agent case, streams their runtime state
back to the UI, and collects the final outputs.

## Agent Case lifecycle

### 1. Save a session as a case

From a useful conversation, the user clicks:

`Save as Agent Case`

The relay uses the existing session detail/export data:

- session metadata;
- transcript;
- diagnostics;
- runtime snapshots;
- cached received files;
- exported markdown/json bundle.

MVP behavior:

- create a draft case with session id, cwd, title, and source bundle;
- prefill a draft identity from the session title/path;
- let the user edit the useful parts manually.

Later behavior:

- ask a Codex summarizer to distill the transcript into a clean case;
- extract playbooks, common commands, failure modes, and success criteria;
- redact secrets before saving.

### 2. Edit the case

An agent case should be user-editable. Suggested fields:

```json
{
  "caseId": "case_...",
  "name": "HPC relay debugger",
  "description": "Debugs relay/host-agent connectivity and stale heartbeat issues.",
  "source": {
    "hostId": "illuin",
    "sessionId": "019...",
    "cwd": "D:/project/cursor_english_dev/remote_codex",
    "exportedAt": "2026-05-31T..."
  },
  "identity": "You are a careful relay/agent debugging specialist...",
  "strengths": [
    "Diagnose local-agent offline states",
    "Read relay and host-agent logs",
    "Prefer non-destructive process restarts"
  ],
  "guardrails": [
    "Do not kill unrelated processes",
    "Do not expose auth tokens in final output",
    "Ask before destructive filesystem operations"
  ],
  "defaultRole": "debugger",
  "defaultModel": "",
  "defaultEffort": "medium",
  "writeScope": [
    "apps/relay/",
    "apps/host-agent/",
    "scripts/"
  ],
  "promptTemplate": "Use the source case as prior experience. Solve the new task...",
  "artifacts": [
    {
      "kind": "session-export",
      "path": "tmp/agent-cases/case_.../session.md"
    }
  ],
  "createdAt": "...",
  "updatedAt": "..."
}
```

### 3. Run a case as a single agent

This is the "single body" mode.

The user picks one saved case and starts:

`Run Case`

The harness creates one managed Codex session with a prompt envelope:

```text
You are running as agent case: <case name>.

Identity:
<case.identity>

Useful prior experience:
<case.summary / selected transcript excerpts>

Project instructions:
<AGENTS.md and selected repo guidance>

Task:
<new user objective>

Output contract:
- state what you changed;
- list files changed;
- list verification commands;
- call out risks.
```

This is useful before full swarm mode because it lets a proven conversation
become a reusable specialist.

### 4. Use cases inside a swarm

The user can add several members:

- role-only member: generic reviewer;
- case member: HPC relay debugger;
- case member: frontend export-flow implementer;
- role-only member: tester.

The harness starts one managed session per member and tracks them under one
swarm run.

## Data model

### AgentCase

Persistent object. Suggested storage for MVP:

`tmp/agent-cases.json`

Bundle files can live under:

`tmp/agent-cases/<caseId>/`

Later we can support repo-local, shareable cases:

`agent_cases/<caseId>/case.json`

### SwarmRun

```json
{
  "swarmId": "swarm_...",
  "title": "Fix export bundle and add docs",
  "objective": "Implement zip bundle export and document behavior.",
  "hostId": "illuin",
  "cwd": "D:/project/cursor_english_dev/remote_codex",
  "state": "running",
  "members": ["member_1", "member_2"],
  "createdAt": "...",
  "updatedAt": "...",
  "completedAt": null
}
```

### SwarmMember

```json
{
  "memberId": "member_...",
  "swarmId": "swarm_...",
  "name": "Export implementer",
  "kind": "case",
  "caseId": "case_...",
  "roleId": "implementer",
  "hostId": "illuin",
  "sessionId": "019...",
  "state": "running",
  "writeScope": ["apps/relay/server.js", "apps/mobile-web/public/"],
  "createdAt": "...",
  "updatedAt": "..."
}
```

### SwarmEvent

Swarm events should mostly be views over existing session events:

- session transcript;
- runtime updates;
- diagnostics;
- alerts;
- file artifacts.

The relay should not duplicate all transcript data. It can map:

`swarmId -> memberId -> hostId/sessionId`

and reuse the existing session detail and SSE machinery.

## Backend API draft

### Agent cases

- `GET /api/agent-cases`
- `POST /api/agent-cases`
- `GET /api/agent-cases/:caseId`
- `PATCH /api/agent-cases/:caseId`
- `DELETE /api/agent-cases/:caseId`
- `POST /api/sessions/:sessionId/agent-case?hostId=...`

The last endpoint creates a draft case from an existing session.

### Swarms

- `GET /api/swarms`
- `POST /api/swarms`
- `GET /api/swarms/:swarmId`
- `POST /api/swarms/:swarmId/members`
- `POST /api/swarms/:swarmId/start`
- `POST /api/swarms/:swarmId/stop`
- `POST /api/swarms/:swarmId/members/:memberId/input`
- `POST /api/swarms/:swarmId/members/:memberId/stop`
- `GET /api/swarms/:swarmId/export`

MVP implementation can internally call the existing session start/input/stop
paths instead of inventing a second session runtime.

## Frontend design

### Session actions

Add a session action:

`Save as Agent Case`

This opens a draft editor:

- case name;
- description;
- identity;
- strengths;
- guardrails;
- default role;
- write scope;
- source session;
- include export bundle checkbox.

### Agent Case Library

Add a library panel:

- saved cases;
- source session/cwd;
- last used;
- run as single agent;
- add to swarm;
- edit/delete/export.

### Swarm Builder

A guided creation flow:

1. Objective.
2. Host and cwd.
3. Add members:
   - choose role;
   - choose agent case;
   - set write scope;
   - set model/effort.
4. Start swarm.

### Swarm Dashboard

One page with:

- member cards;
- live status chips;
- transcript preview per member;
- shared timeline;
- artifacts/diffs/files;
- stop all;
- stop member;
- queue prompt to member;
- broadcast note to all.

## Prompt envelope

Every swarm member should start with a structured prompt envelope.

Recommended sections:

1. Swarm run objective.
2. Member identity or case.
3. Role-specific responsibilities.
4. Project instructions from `AGENTS.md` if present.
5. Workspace and host information.
6. Write scope.
7. Coordination rules.
8. Output contract.

Coordination rules for MVP:

- do not assume other members are idle;
- do not revert unrelated changes;
- list files changed;
- if blocked, report the blocker clearly;
- if assigned read-only, do not edit files.

## RAG and memory

RAG is useful, but it should not be the first dependency.

MVP memory:

- saved agent case summaries;
- selected transcript excerpts;
- export bundle artifacts;
- `AGENTS.md`;
- repo README/docs;
- current user objective.

Later RAG:

- index case summaries;
- index docs and selected source files;
- retrieve relevant prior case snippets when starting a member;
- retrieve failure patterns and validation commands.

This can start with plain text search before vector search.

## Safety and conflict control

MVP controls:

- write scope per member;
- role can be read-only;
- visible owner per changed file;
- stop all;
- export swarm bundle;
- no automatic commit unless user asks.

Later controls:

- per-member git worktree;
- patch review before applying;
- merge queue;
- file locks;
- automatic reviewer after implementer completes.

## Implementation phases

### Phase 1: Agent Case MVP

- Add `AgentCase` storage.
- Add "Save as Agent Case" from a session.
- Add case editor.
- Add "Run Case" as a single managed session.

### Phase 2: Swarm Run MVP

- Add `SwarmRun` and `SwarmMember` storage.
- Create swarm from objective + selected members.
- Start one managed session per member.
- Show member cards and live status.

### Phase 3: Coordination

- Queue prompt to one member.
- Broadcast note to all members.
- Stop member and stop all.
- Export swarm bundle.

### Phase 4: Better memory

- Add case distillation.
- Add searchable case library.
- Add lightweight RAG over docs/cases.

### Phase 5: Safer parallel coding

- Add file ownership and write-scope warnings.
- Add optional per-member worktrees.
- Add merge/review flow.

## Key design decision

An "agent case" should be a reusable prompt and artifact bundle distilled from
a real conversation, not a running process. A swarm member is the running
process that uses that case.

This keeps the system simple:

- conversations become reusable knowledge;
- cases can be edited and versioned;
- one case can run alone;
- multiple cases can run together in a swarm.
