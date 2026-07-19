# Documentation Index

This directory separates product architecture, implementation modules, validation status, and developer notes.

## Start here

- [Module Map](module-map.md): how the project is decomposed and which files own each module.
- [Validation Status](validation-status.md): what has been verified, what is partially verified, and what is still unbuilt.
- [Developer Guide](developer-guide.md): local workflow, APIs, events, and development conventions.
- [Phone, Tailscale And HPC Guide](phone-tailscale-hpc-guide.md): phone access, Tailscale setup, and HPC connector onboarding.

## Existing design docs

- [Architecture](mobile-codex-remote-architecture.md): product-level architecture and communication model.
- [Remodex Comparison](remodex-comparison.md): what we can borrow from Remodex for phone-to-PC pairing and live connectivity.
- [Session Discovery And Control](session-discovery-and-control.md): how imported history and live managed sessions differ.
- [Host Onboarding](host-onboarding.md): how a PC or HPC host joins the relay.
- [HPC Connectors](hpc-connectors.md): saved HPC/gateway/MFA connector model.
- [Codex Capability Inventory](codex-capability-inventory.md): known Codex app-server and CLI capabilities.
- [MVP Plan](mvp-plan.md): first milestone scope and success criteria.
- [Large File Transfer Design](large-file-transfer-design.md): chunked upload and download design for files that should not travel through JSON/base64.
- [Multi-Host Skills Registry Design](superpowers/specs/2026-07-12-multi-host-skills-registry-design.md): host-specific skill states, central downloadable sources, Adopt, complete-directory distribution, and composer `/` integration.
- [Multi-Host Skills Phase 1 Plan](superpowers/plans/2026-07-12-multi-host-skills-phase-1.md): cached multi-scope Host inventory, asynchronous refresh, Skills SSE, and the read-only status matrix.
- [Multi-Host Skills Phase 2 Plan](superpowers/plans/2026-07-13-multi-host-skills-phase-2.md): complete-directory artifacts, persistent registry, Host Adopt, bounded GitHub import, and manager actions.
- [Multi-Host Skills Phase 3 Plan](superpowers/plans/2026-07-13-multi-host-skills-phase-3.md): durable desired state, safe Host activation, offline reconciliation, explicit per-Host actions, and deployment progress.

## Operational analyses

- [Realtime Session Sync Performance Fix](realtime-session-sync-performance.md): reproduction, root causes, batching and idempotency design, performance results, and remaining P1 work for the 14-second sync incident.

## Module developer docs

- [Relay](modules/relay.md)
- [Host Agent](modules/host-agent.md)
- [Mobile Web](modules/mobile-web.md)
- [Shared Libraries](modules/shared.md)
- [HPC And Gateway](modules/hpc-and-gateway.md)
