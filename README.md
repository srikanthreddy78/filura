# Filura

**A directed tool graph for AI agents.** Nodes are tools; an edge `A → B` means an output field of A can satisfy a required input of B. The graph answers three questions no MCP server or OpenAPI spec answers on its own:

1. **Selection** — which 12 of my 900 tools does this task actually need? Not top-k by similarity: the *transitive closure* of what's needed, so `createIssue` always arrives with the `listIssueTypes` that produces its required `issueTypeId`.
2. **Composition** — which tool produces the value this required parameter consumes? Agents discover this today by calling, failing, reading the error, and retrying. Filura declares it up front.
3. **Change safety** — someone renames `assignee` to `assignee_id`. Which data flows break, and what's downstream? Filura diffs two graph snapshots and reports the blast radius.

## Quickstart

```bash
npm install
npm test
```

```bash
npx tsx src/cli.ts ingest fixtures/github.json fixtures/jira.json fixtures/slack.json fixtures/acme-crm.json
```

```bash
npx tsx src/cli.ts build
```

```bash
npx tsx src/cli.ts query "create a jira ticket for a bug and assign it to someone"
```

```bash
npx tsx src/cli.ts inspect
```

Live MCP servers ingest directly, and mix freely with OpenAPI specs:

```bash
npx tsx src/cli.ts ingest-mcp github --command npx --args "-y @modelcontextprotocol/server-github"
```

## Use it from an agent

This is the point of the whole thing. Instead of loading 900 schemas into context, an agent connects to Filura as a **single MCP server** and calls `find_tools` with its goal:

```bash
npx tsx src/cli.ts mcp
```

```jsonc
// claude_desktop_config.json / any MCP client
{ "mcpServers": { "filura": { "command": "npx", "args": ["tsx", "src/cli.ts", "mcp"], "cwd": "/path/to/Filura" } } }
```

`find_tools("create a jira issue in the right project")` returns the tools *and* how they connect:

```
## Tools
### jira.getProject … outputs: projectId, projectKey, projectName
### jira.listIssueTypes … outputs: issueTypes[].issueTypeId, …
### jira.createIssue … required inputs: projectId, summary, issueTypeId

## Data flow — where required inputs come from
jira.createIssue.projectId    ← call jira.getProject first and use its projectId
jira.listIssueTypes.projectId ← call jira.getProject first and use its projectId
jira.createIssue.issueTypeId  ← call jira.listIssueTypes first and use its issueTypes[].issueTypeId

Suggested call order: jira.getProject → jira.listIssueTypes → jira.createIssue
```

That last block is what a vector search over tool descriptions cannot give you, and it's what ends the call → fail → retry loop.

There's also an HTTP surface for non-MCP runtimes (`POST /subgraph`, `GET /health`, ~2ms locally against the demo catalog against a 200ms budget):

```bash
npx tsx src/cli.ts serve
```

## Change safety

Rebuild after a schema change and diff the snapshots:

```bash
npx tsx src/cli.ts ingest fixtures/v2/github.json fixtures/jira.json fixtures/slack.json fixtures/acme-crm.json && npx tsx src/cli.ts build
```

```
BROKEN data flows (2):
  github.get_issue.assignee → github.create_issue.assignee  [was structural 1.00]
    blast radius: github.create_issue, github.add_issue_comment, jira.assignIssue, …
```

## How edge inference works

Three passes, ordered by cost. On the 40-tool demo catalog: 1,560 ordered tool pairs → 5,370 type-compatible field candidates → ~20 pairs in the LLM band. That pruning *is* the cost model — naive all-pairs adjudication at 900 tools (~800K pairs) is infeasible, so type gating and embedding thresholds make pass 3 a rounding error.

| Pass | Mechanism | Catches | Cost |
|------|-----------|---------|------|
| 1. Structural | Exact / normalized / parent-context name+type match | `projectId` ← `projects[].id`, `userId` ← `user_id` | free |
| 2. Semantic | Field embeddings + cosine thresholds | naming variance across servers | cheap |
| 3. Adjudication | Claude on the 0.6–0.85 band only, batched JSON | confirms `commit_sha` → `from_sha`, rejects `issue_number` → `issueTypeId` | small, bounded |

Every edge carries provenance (`structural` / `semantic` / `adjudicated` / `ambiguous`) and a confidence score.

**Precision in the hot path.** Unconfirmed `ambiguous` edges are a build-time diagnostic, not something agents are told to act on — they're excluded from queries by default (`--include-ambiguous` to inspect them). A wrong composition hint costs an agent more than a missing one. Set `ANTHROPIC_API_KEY` and those pairs get adjudicated instead of dropped.

**Zero-config runs fully offline.** The default embedder is a deterministic lexical vectorizer (identifier splitting, alias folding, hashed n-grams) — no API keys, no schema names leaving the machine, which matters because internal tool names leak org structure. `FILURA_EMBEDDINGS=voyage|openai` swaps in hosted embeddings for better recall on description matching. Keys upgrade precision; they're never required.

## Architecture

```
ingest (MCP stdio/HTTP · OpenAPI 3.x · JSON dumps)
  → IR              normalized tools: typed, dotted-path, required-flagged fields
  → inference       3 passes → provenance-tagged edges
  → snapshots       .filura/graph-<hash>.json, content-addressed
  → queries         subgraph · reachability · redundancy · diff
  → surfaces        MCP server · HTTP API · CLI
```

| Path | What's there |
|------|--------------|
| `src/ir/` | IR types + schema flattening (`$ref`, nesting, arrays, `anyOf/oneOf/allOf`, cycles) |
| `src/match/` | the three inference passes |
| `src/graph/` | build orchestration, snapshot store |
| `src/query/` | subgraph retrieval, dead tools, redundancy, blast-radius diff |
| `src/mcp-server.ts` | Filura as an MCP server (`find_tools`, `describe_catalog`) |
| `src/server.ts` | HTTP serving layer |

## Status

51 tests green. Working end to end on a 40-tool demo catalog spanning three MCP servers and one OpenAPI spec, with dead nodes, redundant pairs, and a breaking rename planted in the fixtures to exercise each claim.

What's proven: the pipeline works and the cost model holds. What's unproven: accuracy against a large real-world catalog — that needs design partners with 100+ tools in production, which is the next milestone rather than a later one.

## License

MIT
