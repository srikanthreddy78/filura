# Filura

[![CI](https://github.com/srikanthreddy78/filura/actions/workflows/ci.yml/badge.svg)](https://github.com/srikanthreddy78/filura/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

**Dependency intelligence and change safety for AI agent tools.** Nodes are tools; an edge `A → B` means an output field of A can satisfy a required input of B.

MCP standardized how to *call* a tool. Nothing standardizes how tools *connect* — so an agent discovers that `createIssue` needs the `issueTypeId` only `listIssueTypes` produces by calling, failing, reading the error, and retrying. Filura infers those relationships statically and serves them.

## Measured results

Not projections — `npm test` enforces regression floors, and CI runs the suite,
evaluation, benchmark, and a deliberately failing schema-change gate on every push.

**Edge inference** against 45 hand-labeled required inputs (97 correct producer pairs, labeled by reading the schemas, never recorded from Filura's own output):

| mode | precision | recall | F1 |
|---|---|---|---|
| **trusted (default)** | **100.0%** | **88.7%** | **94.0%** |
| including ambiguous band | 88.1% | 99.0% | 93.2% |

Plus 4/4 genuinely unreachable inputs correctly left starved, and **9/10 goals** fully solved within an 8-tool budget.

**Scale** — reproduce with `filura bench --tools 700`:

| metric | 700 tools, 20 servers |
|---|---|
| ordered tool pairs | 489,300 |
| type-compatible candidates | 434,778 |
| edges inferred | 26,974 |
| pairs needing an LLM call | 0 on this structural synthetic workload |
| build wall time | 2.0s |
| query latency | p50 18.5ms, p95 26.2ms |

## What it solves

**Selection.** Tool schemas consume context. At 500+ tools they dominate it and selection accuracy degrades. Filura returns the ~10 tools a task needs — as the *transitive closure* of what's required, not top-k by similarity.

**Composition.** Which tool produces the value this required parameter consumes? Filura declares it instead of letting the agent discover it by failing.

**Change safety.** Rename `assignee` to `assignee_id` and Filura diffs two graph snapshots to report which data flows broke and everything downstream of them.

## Use it from an agent

Instead of loading 900 schemas into context, connect one MCP server and call `find_tools`:

```bash
filura mcp
```

```jsonc
{ "mcpServers": { "filura": { "command": "npx", "args": ["tsx", "src/cli.ts", "mcp"], "cwd": "/path/to/filura" } } }
```

`find_tools("create a jira issue in the right project")` returns schemas **and** the data flow between them:

```
## Data flow — where required inputs come from
jira.createIssue.projectId    ← call jira.getProject first and use its projectId
jira.listIssueTypes.projectId ← call jira.getProject first and use its projectId
jira.createIssue.issueTypeId  ← call jira.listIssueTypes first and use its issueTypes[].issueTypeId

Suggested call order: jira.getProject → jira.listIssueTypes → jira.createIssue
```

That last block is what vector search over tool descriptions cannot produce.

## Quickstart

```bash
npm install
npm run verify
```

```bash
npx tsx src/cli.ts ingest fixtures/*.json
```

```bash
npx tsx src/cli.ts build
```

```bash
npx tsx src/cli.ts query "create a jira ticket for a bug and assign it to someone"
```

| command | what it does |
|---|---|
| `ingest` / `ingest-mcp` | normalize MCP dumps, live MCP servers, or OpenAPI 3.x specs |
| `build` | run edge inference, snapshot the graph |
| `query` | retrieve the dependency closure for a goal |
| `explain` | show evidence, provenance, and safety state for one input |
| `inspect` | dead tools, redundancy clusters, catalog stats |
| `diff` | blast radius between two snapshots |
| `check` | CI policy gate for trusted breaking changes |
| `eval` | precision/recall/F1 against ground truth |
| `bench` | build + query cost at scale |
| `serve` / `mcp` | HTTP API / MCP server |

## How inference works

Three passes, ordered by cost, each gated by the one before it:

| pass | mechanism | catches | cost |
|---|---|---|---|
| 1. Structural | exact / normalized / parent-context name+type match | `projectId` ← `projects[].id`, `userId` ← `user_id` | free |
| 2. Semantic | field embeddings + cosine thresholds | naming variance across servers | cheap |
| 3. Adjudication | LLM on the 0.60–0.85 band only, batched | confirms `commit_sha` → `from_sha`, rejects `issue_number` → `issueTypeId` | bounded |

Every edge carries provenance and a confidence score. **Unconfirmed `ambiguous` edges are excluded from queries by default** — a wrong composition hint costs an agent more than a missing one. They remain as a build-time worklist of what adjudication would resolve.

**Zero-config runs fully offline.** The default embedder is a deterministic lexical vectorizer — no API keys, no schema names leaving the machine, which matters because internal tool names leak org structure. `ANTHROPIC_API_KEY` enables pass 3; `FILURA_EMBEDDINGS=voyage|openai` swaps in hosted embeddings.

## Change safety

```

## Release policy and explainability

`diff` answers “what changed?”; `check` answers “may this release ship?”
It exits non-zero for removed tools/outputs, broken **trusted** data flows, and
newly unreachable required identifiers. It reports removed inputs as warnings,
because callers may need review even when the changed tool remains callable.

```bash
filura check <approved-snapshot> latest --format github
```

Every inferred dependency is inspectable instead of opaque:

```bash
filura explain jira.createIssue issueTypeId
```

```text
jira.createIssue.issueTypeId
  status: satisfied

Trusted producers:
  jira.listIssueTypes.issueTypes[].issueTypeId → jira.createIssue.issueTypeId
    [structural 1.00]

Pending adjudication (not used by default):
  github.create_issue.issue_number → jira.createIssue.issueTypeId [ambiguous 0.67]
```

The same read-only explanation is available from `GET /explain` and the
`explain_input` MCP tool. Pending candidates are visible to reviewers but are
never handed to agents as trusted guidance.
BROKEN data flows (2):
  github.get_issue.assignee → github.create_issue.assignee  [was structural 1.00]
    blast radius: github.create_issue, github.add_issue_comment, jira.assignIssue, …
```

## Design notes

Two decisions that shaped the system, both driven by measurement:

**Precision over recall in the hot path.** Unadjudicated edges were originally surfaced to agents, producing hints like `issueTypeId ← issue_number`. Excluding them took precision from 88.1% to 100.0% at a cost of 10 points of recall — the right trade when the consumer is an autonomous agent.

**Seeds and dependencies compete in one queue.** Admitting all similarity seeds up front spent the budget before any dependency was considered, so a weakly-relevant seed crowded out a tool that actually produced a required input. A single best-first queue fixed it, and the retrieval eval caught the regression.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and
evaluation methodology. See [docs/ENTERPRISE_READINESS.md](docs/ENTERPRISE_READINESS.md)
for the client assessment, rollout plan, technical decisions, and explicit
production gaps.

## Limitations

The default embedder is lexical, not semantic: it cannot connect "move a ticket to a done state" with `transitionIssue`, which is the one retrieval failure in the eval set. Hosted embeddings target exactly that gap.

Accuracy is measured against fixtures authored alongside the system. Performance on a large real-world catalog with inconsistent cross-team naming is unknown, and is the most important open question.

The local server is intentionally a single-process localhost service. Hosted
multi-tenancy, authentication, audit logs, waivers, and runtime-observed output
contracts are planned production capabilities, not claims this repository makes.

## Project layout

| path | contents |
|---|---|
| `src/ir/` | IR types + schema flattening (`$ref`, nesting, arrays, `anyOf`/`oneOf`/`allOf`, cycles) |
| `src/match/` | the three inference passes |
| `src/graph/` | build orchestration, content-addressed snapshot store |
| `src/query/` | subgraph retrieval, reachability, redundancy, diff |
| `src/policy/` | deterministic CI release gate |
| `src/eval/` | ground-truth evaluation harness and synthetic benchmark |
| `src/mcp-server.ts` | Filura as an MCP server |
| `eval/ground-truth.json` | hand-labeled correctness data |

## License

MIT
