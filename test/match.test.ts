import { describe, expect, it } from "vitest";
import {
  sharedRareIdentifierSuffix,
  structuralMatch,
} from "../src/match/structural.js";
import { localEmbed, splitIdentifier } from "../src/providers/embeddings/local.js";
import { cosine } from "../src/providers/embeddings/types.js";
import { parseVerdicts } from "../src/providers/adjudicator/anthropic.js";
import type { Field } from "../src/ir/types.js";
import type { CandidatePair } from "../src/match/adjudicate.js";

function field(path: string, type: Field["type"] = "string"): Field {
  const name = path.replace(/\[\]/g, "").split(".").pop()!;
  return { path, name, type, required: true };
}

describe("structuralMatch", () => {
  it("matches exact names", () => {
    expect(structuralMatch(field("project_id"), field("project_id"))).toMatchObject({
      reason: "exact",
    });
  });

  it("matches across naming conventions (userId vs user_id)", () => {
    expect(structuralMatch(field("userId"), field("user_id"))).toMatchObject({
      reason: "normalized",
    });
  });

  it("folds aliases (customerIdentifier vs customer_id)", () => {
    expect(
      structuralMatch(field("customerIdentifier"), field("customer_id")),
    ).toMatchObject({ reason: "normalized" });
  });

  it("matches parent context: projects[].id satisfies project_id", () => {
    expect(structuralMatch(field("projects[].id"), field("project_id"))).toMatchObject({
      reason: "contextual",
    });
  });

  it("does not match unrelated names", () => {
    expect(structuralMatch(field("channel_id"), field("user_id"))).toBeUndefined();
  });
});

describe("sharedRareIdentifierSuffix", () => {
  it("links commit_sha and from_sha", () => {
    expect(sharedRareIdentifierSuffix(field("commit_sha"), field("from_sha"))).toBe(true);
  });
  it("links message_ts and thread_ts via the ts→timestamp alias", () => {
    expect(sharedRareIdentifierSuffix(field("message_ts"), field("thread_ts"))).toBe(true);
  });
  it("does not link on ubiquitous suffixes like id", () => {
    expect(sharedRareIdentifierSuffix(field("channel_id"), field("user_id"))).toBe(false);
  });
});

describe("local embedder", () => {
  it("splits identifiers across conventions", () => {
    expect(splitIdentifier("customerIdentifier")).toEqual(["customer", "id"]);
    expect(splitIdentifier("user_id")).toEqual(["user", "id"]);
    expect(splitIdentifier("HTTPServerURL")).toEqual(["httpserverurl"].flatMap(() => ["http", "server", "url"]));
  });

  it("scores naming variants of the same concept above unrelated names", () => {
    const userId = localEmbed("userId");
    const userUnderscore = localEmbed("user_id");
    const channel = localEmbed("channel_name");
    expect(cosine(userId, userUnderscore)).toBeGreaterThan(0.95);
    expect(cosine(userId, channel)).toBeLessThan(0.4);
  });

  it("is deterministic", () => {
    expect(localEmbed("project_id")).toEqual(localEmbed("project_id"));
  });
});

describe("parseVerdicts", () => {
  const batch: CandidatePair[] = [
    {
      id: "0",
      fromTool: "a",
      fromToolDescription: "",
      fromField: "x",
      fromFieldDescription: "",
      toTool: "b",
      toToolDescription: "",
      toField: "y",
      toFieldDescription: "",
      similarity: 0.7,
    },
    {
      id: "1",
      fromTool: "c",
      fromToolDescription: "",
      fromField: "x",
      fromFieldDescription: "",
      toTool: "d",
      toToolDescription: "",
      toField: "y",
      toFieldDescription: "",
      similarity: 0.7,
    },
  ];

  it("parses a clean JSON array", () => {
    const verdicts = parseVerdicts('[{"id":"0","match":true},{"id":"1","match":false}]', batch);
    expect(verdicts).toEqual([
      { id: "0", match: true },
      { id: "1", match: false },
    ]);
  });

  it("extracts JSON from surrounding prose and defaults missing ids to no-match", () => {
    const verdicts = parseVerdicts('Sure! Here you go:\n[{"id":"0","match":true}]\nDone.', batch);
    expect(verdicts).toEqual([
      { id: "0", match: true },
      { id: "1", match: false },
    ]);
  });

  it("defaults everything to no-match on garbage output", () => {
    const verdicts = parseVerdicts("I cannot help with that.", batch);
    expect(verdicts.every((v) => !v.match)).toBe(true);
  });
});
