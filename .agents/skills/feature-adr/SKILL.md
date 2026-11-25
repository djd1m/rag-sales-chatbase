---
name: feature-adr
description: Run the project's feature-adr pipeline for a feature, ADR-backed change, or explicit full-QE request.
---

# Feature ADR in Суфлёр

From the repository root, read `.claude/skills/feature-adr/SKILL.md`, `.claude/shards/feature-adr.shard.md`, and `tools/feature-process/README.md`. Use the vendored modules and references under `.claude/skills/feature-adr/`.

Use `tools/feature-process/run` for the pinned `dz`, OpenSpec, and AQE commands and for the workspace K1 and stage checks. Apply the upstream review protocol at ideation and QE, and use actual review evidence for each checkpoint. If the host has not loaded project hooks or MCP tools, follow the project README for native readiness checks and direct stdio AQE recall.
