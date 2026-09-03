# Contributing to Filura

## Local setup

```bash
npm install
npm run verify
```

Use the fixture catalog for a quick end-to-end loop:

```bash
npx tsx src/cli.ts ingest fixtures/*.json
npx tsx src/cli.ts build
npx tsx src/cli.ts eval
```

## Engineering expectations

- Keep the default path offline: schema text must not leave a machine unless a
  user explicitly configures a hosted embedding or adjudication provider.
- Prefer high precision over a speculative composition hint. Unconfirmed
  candidates belong in the pending/adjudication path, never in default agent
  guidance or release-blocking policy.
- Add a regression test for every behavior change. Run `npm run verify` before
  opening a pull request.
- Keep the HTTP server localhost by default. Do not add externally reachable
  behavior without authentication and threat-model documentation.

## Evaluation data

`eval/ground-truth.json` is hand-labeled from fixture schemas. Do not generate
or update labels from Filura output: that would make the evaluator circular.

When adding a fixture:

1. label identifier-shaped required inputs and all legitimate producer fields;
2. add goal-level closure expectations where retrieval is relevant;
3. update the regression floor only with an explanation of why the previous
   target is no longer appropriate.

## Changes that affect compatibility

Run the release gate against a baseline and inspect every finding:

```bash
filura check <approved-snapshot> latest --format text
```

Use `--warn-only` only for an advisory rollout or an explicitly documented
waiver. It should not become the default in CI.
