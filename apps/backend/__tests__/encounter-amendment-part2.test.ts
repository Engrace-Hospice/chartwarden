import type { DbClient } from "@chartwarden/db";
// S1 PR E2b - an amendment of a note that holds 42 CFR Part 2 content needs an author who may read Part 2 content (ADR-0114 VN-D30, VN-D13). A
// viewer without disclosure drafts without the SUD sources, so their amendment would silently shorten the current view: it is refused at naming
// and again at sign (the verdict can change between the two), whichever section is named. Pure: a fake verdict, no database (the flow over fakes is
// `encounter-amendment-flow-part2.test.ts`, the store read is proved live).
import { describe, expect, it, vi } from "vitest";
import { assertMayAmendPart2 } from "../src/modules/08-encounters/drafting/amendment-part2";
import { noteHasPart2Version } from "../src/modules/08-encounters/drafting/amendment-store";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import { fakeDb } from "./_fake-drizzle";

const unavailable = (cause: unknown) =>
  new EncounterStateError(
    "COMPLIANCE_GATE_UNAVAILABLE",
    "the check could not be decided",
    undefined,
    {
      cause,
    },
  );

describe("assertMayAmendPart2", () => {
  it("asks nobody when the note holds no Part 2 content", async () => {
    const entitled = vi.fn(async () => false);
    await expect(
      assertMayAmendPart2({ noteHasPart2: false, entitled, unavailable }),
    ).resolves.toBeUndefined();
    expect(entitled).not.toHaveBeenCalled();
  });

  it("passes an entitled author, asking the verdict once", async () => {
    const entitled = vi.fn(async () => true);
    await assertMayAmendPart2({ noteHasPart2: true, entitled, unavailable });
    expect(entitled).toHaveBeenCalledTimes(1);
  });

  it("refuses an author without disclosure with 422 AMENDMENT_PART2_NOT_ENTITLED, naming no section and saying nothing of Part 2", async () => {
    const error = await assertMayAmendPart2({
      noteHasPart2: true,
      entitled: async () => false,
      unavailable,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EncounterStateError);
    expect(error).toMatchObject({ code: "AMENDMENT_PART2_NOT_ENTITLED", statusCode: 422 });
    const body = JSON.stringify({ message: (error as Error).message, ...(error as object) });
    expect(body).not.toContain("interventions");
    expect(body).not.toMatch(/section/i);
    // The refusal is the one fact a signer without disclosure must not learn from its wording (C6); the code is the client's key.
    expect((error as Error).message).not.toMatch(/part\s*2|42\s*cfr|protected/i);
    expect((error as Error).message).toBe("this note cannot be amended by this signer");
  });

  it("a verdict that cannot be decided is the caller's 503, never a denial and never a pass, and the cause stays on the error", async () => {
    const outage = new Error("synthetic M39 outage");
    const error = await assertMayAmendPart2({
      noteHasPart2: true,
      entitled: async () => {
        throw outage;
      },
      unavailable,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
    expect((error as { cause?: unknown }).cause).toBe(outage);
    expect((error as Error).message).not.toContain("synthetic");
  });
});

describe("noteHasPart2Version: one answer for the whole note (the store read over the recording fake; the SQL is proven live)", () => {
  const asked = (rows: Parameters<typeof fakeDb>[0]) =>
    (
      fakeDb(rows).db as unknown as {
        transaction: (fn: (tx: DbClient) => Promise<boolean>) => Promise<boolean>;
      }
    ).transaction((tx) => noteHasPart2Version(tx, "00000000-0000-4000-8000-000000000004"));
  const pin = (part2Derived: boolean) => ({
    hearthnote_assembled_output: [{ id: "pin", part2Derived }],
  });

  it("is false for a note that was never pinned", async () => {
    expect(await asked({})).toBe(false);
  });

  it("is true when the pin carries Part 2 text, whatever its rows say", async () => {
    expect(await asked({ ...pin(true), hearthnote_signed_section: [] })).toBe(true);
  });

  it("is true when a sealed row, an original or an amendment of any section, is Part 2 derived though the pin says not", async () => {
    expect(await asked({ ...pin(false), hearthnote_signed_section: [{ id: "row" }] })).toBe(true);
  });

  it("is false when neither the pin nor any row is Part 2 derived", async () => {
    expect(await asked({ ...pin(false), hearthnote_signed_section: [] })).toBe(false);
  });
});
