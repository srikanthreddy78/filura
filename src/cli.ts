#!/usr/bin/env node
/**
 * filura — the tool-graph CLI.
 *
 *   filura ingest <files...>        normalize MCP dumps / OpenAPI specs into the catalog
 *   filura ingest-mcp <name> -- cmd connect to a live MCP server and ingest its tools
 *   filura build                    run edge inference, snapshot the graph
 *   filura query "<goal>"           retrieve the subgraph for a goal
 *   filura inspect                  dead tools, redundancy clusters, stats
 *   filura diff <hashA> <hashB>     blast radius between two snapshots
 *   filura serve                    HTTP API (POST /subgraph)
 */

import { Command } from "commander";
import { ingestFile } from "./ingest/files.js";
import { fetchMcpTools } from "./ingest/mcp.js";
import { normalizeMcpTools } from "./ir/normalize-mcp.js";
import type { ToolIR } from "./ir/types.js";
import { buildGraph } from "./graph/build.js";
import { GraphStore } from "./graph/store.js";
import { querySubgraph } from "./query/subgraph.js";
import { explainInput } from "./query/explain.js";
import { findDeadTools } from "./query/reachability.js";
import { findRedundantClusters } from "./query/redundancy.js";
import { diffGraphs } from "./query/diff.js";
import { checkGraphChange } from "./policy/check.js";
import {
  resolveAdjudicator,
  resolveEmbeddingProvider,
} from "./providers/resolve.js";
import { startServer } from "./server.js";
import { startMcpServer } from "./mcp-server.js";
import { readFile } from "node:fs/promises";
import { evaluateEdges } from "./eval/evaluate.js";
import { evaluateRetrieval, type RetrievalSpec } from "./eval/retrieval.js";
import { generateSyntheticCatalog } from "./eval/synthetic.js";
import type { GroundTruth } from "./eval/types.js";
import { FILURA_VERSION } from "./version.js";

const program = new Command();
program
  .name("filura")
  .description(
    "Tool dependency infrastructure for AI agents: selection, composition, change safety.",
  )
  .version(FILURA_VERSION);

program
  .command("ingest")
  .description("Ingest MCP tool dumps and/or OpenAPI specs into the catalog")
  .argument("<files...>", "JSON files (MCP dump or OpenAPI 3.x)")
  .option("--append", "add to the existing catalog instead of replacing it")
  .action(async (files: string[], options: { append?: boolean }) => {
    const store = new GraphStore();
    const tools: ToolIR[] = options.append ? await store.loadCatalog().catch(() => []) : [];
    const known = new Set(tools.map((tool) => tool.id));
    for (const file of files) {
      const ingested = await ingestFile(file);
      for (const tool of ingested) {
        if (known.has(tool.id)) continue;
        known.add(tool.id);
        tools.push(tool);
      }
      console.log(`  ${file}: ${ingested.length} tools`);
    }
    const path = await store.saveCatalog(tools);
    console.log(`Catalog: ${tools.length} tools → ${path}`);
  });

program
  .command("ingest-mcp")
  .description("Connect to a live MCP server and ingest its tools")
  .argument("<name>", "namespace for this server's tools")
  .option("--url <url>", "streamable HTTP endpoint")
  .option("--command <command>", "stdio server command")
  .option("--args <args>", "stdio server arguments (space separated)")
  .option("--append", "add to the existing catalog instead of replacing it")
  .action(
    async (
      name: string,
      options: { url?: string; command?: string; args?: string; append?: boolean },
    ) => {
      if (!options.url && !options.command) {
        console.error("Provide --url or --command");
        process.exitCode = 1;
        return;
      }
      const dump = await fetchMcpTools({
        server: name,
        url: options.url,
        command: options.command,
        args: options.args?.split(/\s+/).filter(Boolean),
      });
      const tools = normalizeMcpTools(dump);
      const store = new GraphStore();
      const existing: ToolIR[] = options.append
        ? await store.loadCatalog().catch(() => [])
        : [];
      const known = new Set(existing.map((tool) => tool.id));
      for (const tool of tools) {
        if (!known.has(tool.id)) {
          known.add(tool.id);
          existing.push(tool);
        }
      }
      const path = await store.saveCatalog(existing);
      console.log(`${name}: ${tools.length} tools → ${path}`);
    },
  );

program
  .command("build")
  .description("Run edge inference over the catalog and snapshot the graph")
  .option("--embeddings <provider>", "local | voyage | openai")
  .option("--no-adjudicate", "skip LLM adjudication even if a key is present")
  .action(async (options: { embeddings?: string; adjudicate: boolean }) => {
    const store = new GraphStore();
    const tools = await store.loadCatalog();
    const embeddingProvider = resolveEmbeddingProvider(options.embeddings);
    const adjudicator = resolveAdjudicator(!options.adjudicate);

    const started = performance.now();
    const { graph, stats } = await buildGraph(tools, {
      embeddingProvider,
      adjudicator,
    });
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    const hash = await store.saveGraph(graph);

    console.log(`Graph ${hash} built in ${elapsed}s`);
    console.log(`  tools: ${stats.tools}`);
    console.log(`  ordered tool pairs: ${stats.orderedPairs}`);
    console.log(`  field candidates after type pruning: ${stats.prunedCandidates}`);
    console.log(`  edges: ${stats.edges}`);
    console.log(`    structural:  ${stats.byProvenance.structural}`);
    console.log(`    semantic:    ${stats.byProvenance.semantic}`);
    console.log(`    adjudicated: ${stats.byProvenance.adjudicated} (LLM calls for ${stats.adjudicatedPairs} pairs)`);
    console.log(`    ambiguous:   ${stats.byProvenance.ambiguous}${stats.byProvenance.ambiguous > 0 ? "  ← unconfirmed, excluded from queries; set ANTHROPIC_API_KEY to adjudicate" : ""}`);
    console.log(`  embeddings: ${graph.embeddingProvider}`);
  });

program
  .command("query")
  .description("Retrieve the tool subgraph for a goal")
  .argument("<goal>", "what the agent needs to accomplish")
  .option("--max-tools <n>", "budget", "15")
  .option("--max-depth <n>", "dependency depth", "3")
  .option(
    "--include-ambiguous",
    "include unconfirmed ambiguous-band edges (noisy; excluded by default)",
  )
  .option("--json", "raw JSON output")
  .action(
    async (
      goal: string,
      options: {
        maxTools: string;
        maxDepth: string;
        includeAmbiguous?: boolean;
        json?: boolean;
      },
    ) => {
      const store = new GraphStore();
      const graph = await store.loadGraph();
      const result = await querySubgraph(graph, goal, {
        maxTools: Number(options.maxTools),
        maxDepth: Number(options.maxDepth),
        includeAmbiguous: options.includeAmbiguous,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Goal: ${goal}`);
      console.log(`Selected ${result.tools.length} tools:\n`);
      for (const selected of result.tools) {
        if (selected.reason.kind === "seed") {
          console.log(
            `  ${selected.id}  (seed, relevance ${selected.reason.score.toFixed(2)})`,
          );
        } else {
          const via = selected.reason.via;
          console.log(
            `  ${selected.id}  (feeds ${via.to} ← ${via.toField} via ${via.fromField}, ${via.provenance})`,
          );
        }
      }
      if (result.edges.length > 0) {
        console.log(`\nData flow inside the set:`);
        for (const edge of result.edges) {
          console.log(
            `  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField}  [${edge.provenance} ${edge.score.toFixed(2)}]`,
          );
        }
      }
    },
  );

program
  .command("inspect")
  .description("Catalog health: dead tools, redundancy clusters, stats")
  .option("--dead", "only dead tools")
  .option("--redundant", "only redundancy clusters")
  .action(async (options: { dead?: boolean; redundant?: boolean }) => {
    const store = new GraphStore();
    const graph = await store.loadGraph();
    const showAll = !options.dead && !options.redundant;

    if (showAll || options.dead) {
      const dead = findDeadTools(graph);
      console.log(`Dead tools (${dead.length}) — required identifier inputs nothing in the catalog produces:`);
      for (const tool of dead) {
        for (const input of tool.starvedInputs) {
          console.log(`  ${tool.id} — no producer for required "${input.field}" (${input.type})`);
        }
      }
    }
    if (showAll || options.redundant) {
      const clusters = findRedundantClusters(graph);
      console.log(`\nRedundancy clusters (${clusters.length}) — near-identical signatures:`);
      for (const cluster of clusters) {
        console.log(`  [similarity ≥ ${cluster.similarity}] ${cluster.tools.join(", ")}`);
      }
    }
    if (showAll) {
      console.log(`\nSnapshot: ${graph.tools.length} tools, ${graph.edges.length} edges, built ${graph.builtAt}`);
      console.log(`Snapshots on disk: ${(await store.listGraphs()).join(", ")}`);
    }
  });

program
  .command("explain")
  .description("Explain how a tool input is satisfied and whether the evidence is trusted")
  .argument("<tool>", "fully qualified tool id, for example jira.createIssue")
  .argument("<input>", "input path, for example issueTypeId")
  .option("--json", "raw JSON output")
  .action(async (tool: string, input: string, options: { json?: boolean }) => {
    const graph = await new GraphStore().loadGraph();
    const explanation = explainInput(graph, tool, input);
    if (options.json) {
      console.log(JSON.stringify(explanation, null, 2));
      return;
    }
    console.log(`${tool}.${input}`);
    console.log(`  status: ${explanation.status}`);
    console.log(`  ${explanation.guidance}`);
    if (explanation.trustedProducers.length > 0) {
      console.log("\nTrusted producers:");
      for (const producer of explanation.trustedProducers) {
        const edge = producer.edge;
        console.log(
          `  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField} ` +
            `[${edge.provenance} ${edge.score.toFixed(2)}]`,
        );
      }
    }
    if (explanation.pendingCandidates.length > 0) {
      console.log("\nPending adjudication (not used by default):");
      for (const candidate of explanation.pendingCandidates) {
        const edge = candidate.edge;
        console.log(
          `  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField} ` +
            `[${edge.provenance} ${edge.score.toFixed(2)}]`,
        );
      }
    }
  });

program
  .command("diff")
  .description("Blast radius between two graph snapshots")
  .argument("<before>", "snapshot hash (or 'latest')")
  .argument("<after>", "snapshot hash (or 'latest')")
  .action(async (before: string, after: string) => {
    const store = new GraphStore();
    const [graphBefore, graphAfter] = await Promise.all([
      store.loadGraph(before),
      store.loadGraph(after),
    ]);
    const diff = diffGraphs(graphBefore, graphAfter);

    if (diff.addedTools.length > 0) console.log(`Added tools: ${diff.addedTools.join(", ")}`);
    if (diff.removedTools.length > 0) console.log(`Removed tools: ${diff.removedTools.join(", ")}`);
    if (diff.fieldChanges.length > 0) {
      console.log("Field changes:");
      for (const change of diff.fieldChanges) {
        console.log(`  ${change.tool}: ${change.kind} "${change.field}"`);
      }
    }
    if (diff.brokenEdges.length > 0) {
      console.log(`\nBROKEN data flows (${diff.brokenEdges.length}):`);
      for (const broken of diff.brokenEdges) {
        const edge = broken.edge;
        console.log(
          `  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField}  [was ${edge.provenance} ${edge.score.toFixed(2)}]`,
        );
        console.log(`    blast radius: ${broken.affectedDownstream.join(", ")}`);
      }
    } else {
      console.log("\nNo broken data flows.");
    }
    if (diff.addedEdges.length > 0) {
      console.log(`\nNew data flows (${diff.addedEdges.length}):`);
      for (const edge of diff.addedEdges) {
        console.log(`  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField}`);
      }
    }
  });

program
  .command("check")
  .description("Enforce a release policy between graph snapshots; exits non-zero on trusted breaking changes")
  .argument("<before>", "approved baseline snapshot hash")
  .argument("<after>", "proposed snapshot hash, or 'latest'")
  .option("--format <format>", "text | json | github", "text")
  .option("--warn-only", "report findings without failing the process")
  .action(
    async (
      before: string,
      after: string,
      options: { format: string; warnOnly?: boolean },
    ) => {
      if (!["text", "json", "github"].includes(options.format)) {
        throw new Error(`Unknown format "${options.format}". Use text, json, or github.`);
      }
      const store = new GraphStore();
      const [baseline, proposed] = await Promise.all([
        store.loadGraph(before),
        store.loadGraph(after),
      ]);
      const check = checkGraphChange(baseline, proposed);

      if (options.format === "json") {
        console.log(JSON.stringify(check, null, 2));
      } else if (options.format === "github") {
        for (const finding of check.findings) {
          const command = finding.severity === "error" ? "error" : "warning";
          const title = `Filura ${finding.code}`.replace(/%/g, "%25");
          const message = finding.message
            .replace(/%/g, "%25")
            .replace(/\r/g, "%0D")
            .replace(/\n/g, "%0A");
          console.log(`::${command} title=${title}::${message}`);
        }
        console.log(
          `Filura check: ${check.summary.errors} errors, ${check.summary.warnings} warnings ` +
            `(${check.passed ? "passed" : "failed"})`,
        );
      } else {
        console.log(`Filura release check: ${before} → ${after}`);
        console.log(
          `  ${check.summary.errors} errors, ${check.summary.warnings} warnings, ` +
            `${check.summary.breakingEdges} broken trusted flows, ` +
            `${check.summary.newDeadInputs} newly unreachable inputs`,
        );
        if (check.findings.length === 0) {
          console.log("\nPASS — no release-blocking dependency regressions.");
        } else {
          for (const finding of check.findings) {
            console.log(`\n${finding.severity.toUpperCase()} [${finding.code}]`);
            console.log(`  ${finding.message}`);
          }
        }
      }
      if (!check.passed && !options.warnOnly) process.exitCode = 1;
    },
  );

program
  .command("serve")
  .description("Serve the graph over HTTP (POST /subgraph, GET /explain, GET /health)")
  .option("--port <port>", "port", "4114")
  .action(async (options: { port: string }) => {
    const store = new GraphStore();
    const graph = await store.loadGraph();
    const address = await startServer({ graph, port: Number(options.port) });
    console.log(`filura serving ${graph.tools.length} tools, ${graph.edges.length} edges at ${address}`);
    console.log(`  POST ${address}/subgraph  {"goal": "...", "maxTools": 15}`);
    console.log(`  GET  ${address}/explain?tool=jira.createIssue&input=issueTypeId`);
  });

program
  .command("mcp")
  .description(
    "Run Filura as an MCP server over stdio: agents call find_tools instead of loading every schema",
  )
  .action(async () => {
    const store = new GraphStore();
    const graph = await store.loadGraph();
    // stdout is the MCP transport — never log to it here.
    await startMcpServer({ graph });
  });

program
  .command("eval")
  .description(
    "Measure edge-inference accuracy against hand-labeled ground truth (precision/recall/F1)",
  )
  .option("--truth <path>", "ground truth file", "eval/ground-truth.json")
  .option("--include-ambiguous", "also judge unconfirmed ambiguous-band edges")
  .option("--show-errors", "list every missed and spurious edge")
  .option("--json", "raw JSON output")
  .action(
    async (options: {
      truth: string;
      includeAmbiguous?: boolean;
      showErrors?: boolean;
      json?: boolean;
    }) => {
      const truth = JSON.parse(
        await readFile(options.truth, "utf8"),
      ) as GroundTruth;
      const tools = (
        await Promise.all(truth.catalog.map((file) => ingestFile(file)))
      ).flat();
      const { graph } = await buildGraph(tools, {
        embeddingProvider: resolveEmbeddingProvider(),
        adjudicator: resolveAdjudicator(),
      });

      const retrievalSpec = (truth as unknown as { retrieval?: RetrievalSpec })
        .retrieval;
      const strict = evaluateEdges(graph, truth, { includeAmbiguous: false });
      const loose = evaluateEdges(graph, truth, { includeAmbiguous: true });
      const chosen = options.includeAmbiguous ? loose : strict;

      if (options.json) {
        console.log(JSON.stringify({ strict, loose }, null, 2));
        return;
      }

      const pct = (n: number) => (n * 100).toFixed(1) + "%";
      const row = (label: string, m: typeof strict) =>
        `  ${label.padEnd(22)} ${pct(m.precision).padStart(7)} ${pct(m.recall).padStart(8)} ${pct(m.f1).padStart(7)}   ${m.truePositives}/${m.falsePositives}/${m.falseNegatives}`;

      console.log(`Edge inference vs. ${truth.expectations.length} hand-labeled inputs (${tools.length} tools)\n`);
      console.log(`  ${"mode".padEnd(22)} ${"prec".padStart(7)} ${"recall".padStart(8)} ${"F1".padStart(7)}   TP/FP/FN`);
      console.log(row("trusted (default)", strict));
      console.log(row("+ ambiguous band", loose));
      console.log(
        `\n  Correctly unreachable: ${chosen.deadInputsCorrect}/${chosen.deadInputsTotal} inputs with no valid producer`,
      );

      if (retrievalSpec) {
        const retrieval = await evaluateRetrieval(graph, retrievalSpec);
        console.log(
          `\nGoal retrieval (budget ${retrievalSpec.maxTools} tools): ` +
            `${retrieval.goalsSolved}/${retrieval.goalsTotal} goals fully solved, ` +
            `${pct(retrieval.toolRecall)} of required tools retrieved`,
        );
        for (const result of retrieval.results.filter((r) => !r.solved)) {
          console.log(
            `    UNSOLVED "${result.goal}" — missing ${[
              ...result.missingRequired,
              ...result.unsatisfiedGroups.map((g) => `one of [${g.join(", ")}]`),
            ].join(", ")}`,
          );
        }
      }

      if (options.showErrors) {
        if (chosen.missed.length > 0) {
          console.log(`\n  Missed (${chosen.missed.length}):`);
          for (const m of chosen.missed) console.log(`    ${m.input} <- ${m.producer}`);
        }
        if (chosen.spurious.length > 0) {
          console.log(`\n  Spurious (${chosen.spurious.length}):`);
          for (const s of chosen.spurious) {
            console.log(`    ${s.input} <- ${s.producer}  [${s.provenance} ${s.score}]`);
          }
        }
      } else if (chosen.missed.length + chosen.spurious.length > 0) {
        console.log(`\n  ${chosen.missed.length} missed, ${chosen.spurious.length} spurious — rerun with --show-errors`);
      }
    },
  );

program
  .command("bench")
  .description("Benchmark build and query cost on a synthetic catalog at scale")
  .option("--tools <n>", "catalog size", "700")
  .option("--queries <n>", "queries to time", "20")
  .action(async (options: { tools: string; queries: string }) => {
    const size = Number(options.tools);
    const queryCount = Number(options.queries);
    const tools = generateSyntheticCatalog(size);

    const buildStart = performance.now();
    const { graph, stats } = await buildGraph(tools);
    const buildMs = performance.now() - buildStart;

    const goals = [
      "update a customer record",
      "find an invoice and update it",
      "escalate a support ticket",
      "look up a lead and update the deal",
      "check a failing deployment",
    ];
    const provider = resolveEmbeddingProvider();
    const latencies: number[] = [];
    for (let i = 0; i < queryCount; i++) {
      const goal = goals[i % goals.length]!;
      const start = performance.now();
      await querySubgraph(graph, goal, { maxTools: 10, embeddingProvider: provider });
      latencies.push(performance.now() - start);
    }
    latencies.sort((a, b) => a - b);
    const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]!;

    console.log(`Catalog: ${stats.tools} tools, ${new Set(tools.map((t) => t.source.server)).size} servers`);
    console.log(`\nBuild`);
    console.log(`  ordered tool pairs:        ${stats.orderedPairs.toLocaleString()}`);
    console.log(`  type-compatible candidates:${stats.prunedCandidates.toLocaleString().padStart(11)}`);
    console.log(`  edges inferred:            ${stats.edges.toLocaleString()}`);
    console.log(`  pairs needing an LLM call: ${(stats.byProvenance.ambiguous + stats.adjudicatedPairs).toLocaleString()}` +
      `  (${(((stats.byProvenance.ambiguous + stats.adjudicatedPairs) / Math.max(1, stats.prunedCandidates)) * 100).toFixed(2)}% of candidates)`);
    console.log(`  wall time:                 ${(buildMs / 1000).toFixed(2)}s`);
    console.log(`\nQuery latency over ${queryCount} runs (budget 200ms)`);
    console.log(`  p50 ${at(0.5).toFixed(1)}ms   p95 ${at(0.95).toFixed(1)}ms   max ${latencies[latencies.length - 1]!.toFixed(1)}ms`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
