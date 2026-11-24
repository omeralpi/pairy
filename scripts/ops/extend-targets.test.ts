import fs from "node:fs";
import path from "node:path";

import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { docLinks } from "../evidence/archive-collect";
import { EVIDENCE_ESCROWS, TARGET, escrowEntries } from "./extend-targets";

const ROOT = path.join(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("TARGET", () => {
  it("is after day 30 (2026-12-23, O-46), not the cancelled reset", () => {
    expect(TARGET.getTime()).toBeGreaterThan(Date.parse("2026-12-24T00:00:00Z"));
  });
});

describe("escrowEntries", () => {
  it("are the escrow's instance, its [\"Escrow\"] entry and its USDC balance entry, the keys Soroban RPC answered for the Gate D2 escrow", () => {
    const recorded = JSON.parse(read("tests/fixtures/soroban-rpc/gate-d2.json"));
    const asked: string[] = recorded.calls[0].request.params.keys;
    const answered = recorded.calls[0].response.result.entries.map((e: { key: string }) => e.key);
    expect(answered).toEqual(asked);
    expect(escrowEntries(recorded.contractId).map((k) => k.toXDR("base64"))).toEqual(asked);
  });
});

describe("EVIDENCE_ESCROWS", () => {
  it("has every escrow that EVIDENCE.md and docs/phase2-gates.md link on Trustless Work's viewer", () => {
    const linked = ["EVIDENCE.md", "docs/phase2-gates.md"].flatMap((f) => docLinks(read(f)).escrows);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter((id) => !EVIDENCE_ESCROWS.includes(id))).toEqual([]);
  });

  it("names each escrow once, as a contract address", () => {
    expect(new Set(EVIDENCE_ESCROWS).size).toBe(EVIDENCE_ESCROWS.length);
    expect(EVIDENCE_ESCROWS.filter((id) => !StrKey.isValidContract(id))).toEqual([]);
  });
});
