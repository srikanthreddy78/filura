# Enterprise readiness assessment

## Bottom line

**Filura is worth a constrained design-partner pilot today. It is not yet a
drop-in production control plane.**

The prototype has the right technical wedge: it converts disconnected tool
schemas into an explainable dependency graph, retrieves dependency closure
rather than only similar tools, and catches schema changes before they reach
an agent. The evaluation harness and policy gate make those claims testable.

For an initial customer, the right scope is a single platform team with an
existing MCP/OpenAPI catalog, a non-production environment, and a CI pipeline
where human owners can review findings. Do not make it a release-blocking gate
for a new customer until that customer's catalog has been labeled and its
precision measured.

## What a customer gets now

| Capability | Status | Evidence |
|---|---|---|
| Normalize MCP and OpenAPI tools | available | common `ToolIR`, nested schemas, `$ref`, arrays |
| Infer producer → required-input data flow | available | provenance and confidence on every edge |
| Retrieve a context-budgeted dependency closure | available | MCP, HTTP, and CLI surfaces |
| Explain why an input is satisfied | available | `filura explain`, `GET /explain`, MCP `explain_input` |
| Flag unreachable tools and redundant signatures | available | `filura inspect` |
| Detect schema blast radius | available | content-addressed graph snapshots + `diff` |
| Enforce a CI release policy | available | `filura check`, JSON/GitHub annotation output |
| Tenant isolation, SSO, audit logs | not implemented | required for a hosted control plane |
| Runtime proof that an inferred edge carries valid data | not implemented | required before autonomous production use |

## Why the release gate is deliberately conservative

`filura check` fails only on deterministic, high-signal findings:

1. a tool disappears;
2. an output disappears;
3. a **trusted** producer → consumer flow disappears; or
4. a new required identifier has no catalog producer.

It warns, rather than fails, when an input disappears. A removed input may
break a caller that still sends it, but it does not prove that the agent cannot
call the changed tool. The report still makes that review obligation visible.

Unadjudicated semantic candidates never block or guide an agent by default.
That is intentional: a false dependency can cause a costly invalid action;
a missing hint can be recovered by asking for input or using another tool.

## Pilot plan

### Phase 1 — read-only inventory (week 1)

- Ingest one team's MCP servers and OpenAPI specs locally.
- Run `inspect`, `explain`, and `eval` against a small hand-labeled sample.
- Have domain owners label 50–100 important required inputs and adjudicate
  sampled edges. Measure precision before enabling any agent integration.
- Success criterion: owners find at least one unknown dead tool, duplicate,
  or dependency; trusted-edge precision is at least the customer-agreed floor
  (start at 95%).

### Phase 2 — advisory CI (weeks 2–3)

- Store an approved snapshot hash in the repository or release metadata.
- Build a candidate snapshot in CI and run `filura check <baseline> latest`.
- Publish the report as a pull-request annotation, but use `--warn-only` for
  the first two weeks. Track false-positive findings and adjust labels/
  adjudication rather than lowering the default trust standard.

### Phase 3 — selected blocking rules (after calibration)

- Block only removed outputs and structurally/adjudicated broken flows owned
  by the team. Keep semantic-only findings advisory until measured.
- Add an explicit owner/waiver workflow with an expiry date; never silently
  suppress a finding.

## Reference CI integration

```bash
# baseline is the approved hash from the prior release
filura ingest specs/*.json
filura build
filura check "$FILURA_BASELINE" latest --format github
```

The exit status is non-zero on errors. `--format json` is for build systems;
`--format github` produces native GitHub Actions error/warning annotations.

## Technical decisions for a hosted version

### 1. Keep the control plane separate from the data plane

Catalog metadata contains sensitive organizational information. The default
local deployment sends no schema text anywhere. A hosted edition should make
remote embeddings/adjudication opt-in per tenant, encrypt catalog snapshots,
and offer a self-hosted embedding/adjudication worker for regulated customers.

### 2. Use Postgres as the system of record, not a graph database first

Store versioned tools, fields, edges, policy findings, and approvals in
Postgres. Use `pgvector` for semantic candidates and a precomputed adjacency
cache for low-latency traversal. This gives backups, row-level tenancy,
migrations, and operational familiarity without adding a specialized graph
database before traversal scale actually demands one. The current in-memory
graph remains the query-serving representation.

### 3. Add runtime evidence before increasing automation

MCP does not require output schemas, and static schemas do not prove values
are semantically compatible. Instrument agent tool calls with an OpenTelemetry
or proxy integration, capture shape-only/redacted output observations, and
mark edges as `observed` only after successful data flow. In a future version,
the trust order should be: observed > structural > adjudicated > semantic >
pending. Runtime capture needs explicit retention, redaction, and consent
controls; do not log raw customer payloads by default.

### 4. Make policy-as-code the paid workflow

Version a small policy file alongside the catalog: owner mappings, approved
waivers with expiry, trusted provenance requirements, and severity thresholds.
The value is not simply graph visualization; it is preventing an unowned API
change from silently breaking agents in CI.

### 5. Authenticate every hosted request and audit every policy decision

Use OIDC/SAML at the UI/API boundary, service tokens scoped to a tenant and
catalog, immutable audit events for snapshot build/check/waiver actions, and
least-privilege source connectors. The local server intentionally binds to
`127.0.0.1`; it is not an internet-facing production service.

## Current risks and how they are handled

| Risk | Current treatment | Next step |
|---|---|---|
| False positive dependency | pending candidates excluded by default | customer-specific calibration + human/LLM adjudication |
| False negative dependency | explanation says unresolved instead of inventing a producer | runtime observations + hosted embeddings |
| Model/vendor privacy | local lexical provider is default | tenant-selected/self-hosted providers |
| Large catalogs | 700-tool synthetic benchmark is reproducible | benchmark real anonymized catalogs |
| Change safety false blocks | CI starts advisory | provenance-specific policy and waivers |
| Missing MCP output schemas | represent no outputs rather than fabricate them | observed output contracts |

## Customer decision

Buy or pilot Filura if the team already manages tens to hundreds of tools,
experiences agent retries caused by missing IDs, and owns schemas that change
independently of agent workflows. Do not buy it merely for generic tool search:
model and framework vendors will increasingly provide that feature. The durable
value is dependency intelligence, evidence, and schema-change governance.
