# Changelog

All notable changes to Filura are documented here.

## 0.2.0 — 2026-09-03

### Added

- `filura explain <tool> <input>` plus `GET /explain` and the MCP
  `explain_input` tool. Every dependency now has an inspectable safety state:
  trusted, pending adjudication, agent-suppliable, or unresolved.
- `filura check <baseline> <candidate>`, a machine-readable CI release gate
  for removed tools/outputs, broken trusted data flows, and newly unreachable
  required identifiers. Supports text, JSON, and GitHub Actions annotations.
- Hand-labeled edge and retrieval evaluation harness, synthetic 700-tool
  benchmark, regression floors, and CI coverage.

### Changed

- Retrieval includes the source-server name in seed text, improving matching
  for goals such as "a Jira ticket" where the tool description omits Jira.
- Missing graph snapshots now produce actionable CLI guidance instead of a raw
  filesystem error.

## 0.1.0 — 2026-08-21

- Initial release: MCP and OpenAPI ingestion, three-pass dependency inference,
  content-addressed graph snapshots, subgraph retrieval, catalog health,
  graph diffs, HTTP API, and MCP serving surface.
