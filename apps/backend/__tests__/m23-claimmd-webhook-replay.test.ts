// CW-TX-02: the capture-and-replay harness against the REAL webhook route, in process (no network, no database), and the refusal
// trace that makes a refused first delivery readable. Synthetic captures and a synthetic key only.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLAIMMD_SIGNATURE_HEADER,
  CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED,
  type ClaimMdCapture,
  parseClaimMdCapture,
} from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import {
  replayCaptureThroughRoute,
  usageOfCapture,
} from "../src/modules/23-billing-medicare/claimmd-webhook/replay";

const KEY = "SYNTH99999_k#ey*not-real";
const FIXTURES = join(
  __dirname,
  "../../../packages/x12-837-client/src/clearinghouse/__fixtures__/claimmd-webhook",
);
const SWEEP = join(__dirname, "../src/modules/23-billing-medicare/claimmd-webhook/sweep.ts");

function fixture(name: string): { capture: ClaimMdCapture; rawBody: Buffer } {
  const parsed = parseClaimMdCapture(
    JSON.parse(readFileSync(join(FIXTURES, `${name}.capture.json`), "utf8")),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed;
}

describe("replaying a capture through the real route", () => {
  it.each([
    ["test-event", 1],
    ["enroll-event", 1],
    ["appeal-event", 1],
    ["mixed-batch", 4],
  ])("%s is accepted and would store %i receipt(s)", async (name, receipts) => {
    const replay = await replayCaptureThroughRoute({ ...fixture(name), accountKey: KEY });
    expect(replay).toEqual({
      statusCode: 200,
      errorCode: null,
      received: receipts,
      refusalTrace: null,
    });
  });

  it("refuses the same delivery under another key with the one 401, and leaves a PHI-free trace of why", async () => {
    const input = fixture("enroll-event");
    const replay = await replayCaptureThroughRoute({ ...input, accountKey: "SYNTH_other_key" });
    expect(replay).toEqual({
      statusCode: 401,
      errorCode: "INVALID_SIGNATURE",
      received: null,
      refusalTrace: { verdict: "mismatch", usage: "test", bodyBytes: input.rawBody.length },
    });
  });

  it("refuses a body changed by one byte, a missing signature and a malformed one, each with its own trace class", async () => {
    const input = fixture("test-event");
    const tampered = Buffer.from(input.rawBody);
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0x01;
    const withoutSignature = { ...input.capture.headers };
    delete withoutSignature[CLAIMMD_SIGNATURE_HEADER];
    const malformed = { ...input.capture.headers, [CLAIMMD_SIGNATURE_HEADER]: "x" };
    const cases: [string, ClaimMdCapture, Buffer, string][] = [
      ["tampered", input.capture, tampered, "mismatch"],
      ["missing", { ...input.capture, headers: withoutSignature }, input.rawBody, "header_missing"],
      ["malformed", { ...input.capture, headers: malformed }, input.rawBody, "header_malformed"],
    ];
    for (const [label, capture, rawBody, verdict] of cases) {
      const replay = await replayCaptureThroughRoute({ capture, rawBody, accountKey: KEY });
      expect(replay.statusCode, label).toBe(401);
      expect(replay.refusalTrace?.verdict, label).toBe(verdict);
    }
  });

  it("answers 413 above 1 MiB through the real route, before any signature is judged", async () => {
    const rawBody = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const replay = await replayCaptureThroughRoute({
      ...fixture("test-event"),
      rawBody,
      accountKey: KEY,
    });
    expect(replay.statusCode).toBe(413);
    expect(replay.refusalTrace).toBeNull();
  });

  it("writes no signature, key or body byte into the refusal trace", async () => {
    const input = fixture("appeal-event");
    const replay = await replayCaptureThroughRoute({ ...input, accountKey: "SYNTH_other_key" });
    const text = JSON.stringify(replay);
    for (const secret of [
      "SYNTH_other_key",
      KEY,
      "SYNTHCTRL0001",
      input.capture.headers[CLAIMMD_SIGNATURE_HEADER] as string,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("maps a capture's path to the usage it is replayed under", () => {
    expect(usageOfCapture({ path: "/api/v1/webhooks/claimmd/production" })).toEqual({
      usage: "production",
      mapped: false,
    });
    expect(usageOfCapture({ path: "/api/v1/webhooks/claimmd/test" })).toEqual({
      usage: "test",
      mapped: false,
    });
    expect(usageOfCapture({ path: "/somewhere/else" })).toEqual({ usage: "test", mapped: true });
  });
});

describe("the unverified field list stays in step with the sweep", () => {
  const source = readFileSync(SWEEP, "utf8");
  const start = source.indexOf("async function routeOf");
  const end = source.indexOf("async function settle");
  const routeOf = source.slice(start, end);

  it("still has the shape this guard reads (a rename or a new access style fails here, loudly, not silently)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // the two blocks the sweep reads fields from, under the variable names the field regex below keys on
    expect(routeOf).toContain("const e = obj(data.enroll)");
    expect(routeOf).toContain("const a = obj(data.appeal)");
    expect(routeOf).not.toMatch(/\b[ea]\[/); // bracket access would hide a field from the regex
  });

  it("every name the sweep reads under event_data.enroll / event_data.appeal is listed, and every listed name is read", () => {
    const readBy = (variable: string) =>
      [...routeOf.matchAll(new RegExp(`\\b${variable}\\.([a-z_]+)`, "g"))].map((m) => m[1]);
    const listed = CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.eventData;
    expect(new Set(readBy("e"))).toEqual(new Set(listed.enroll));
    expect(new Set(readBy("a"))).toEqual(new Set(listed.appeal));
  });

  it("the sweep routes the documented event types it knows about", () => {
    for (const type of ["enroll", "appeal"])
      expect(routeOf).toContain(`row.event_type === "${type}"`);
    expect(CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.eventTypes).toEqual(["enroll", "appeal", "test"]);
  });

  it("every committed fixture file is one the harness test covers", () => {
    expect(
      readdirSync(FIXTURES)
        .filter((f) => f.endsWith(".capture.json"))
        .sort(),
    ).toEqual([
      "appeal-event.capture.json",
      "enroll-event.capture.json",
      "mixed-batch.capture.json",
      "test-event.capture.json",
    ]);
  });
});
