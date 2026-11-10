// What a `dosespot_sync_queue` row becomes when its call throws (sync-outcome.ts): a paused tenant's rows wait, a transient failure backs off
// and ends, a deterministic one ends at once.
import { ConfigUnavailableError, DegradedError, NotEnabledError } from "@chartwarden/dosespot";
import { describe, expect, it } from "vitest";
import { SYNC_MAX_ATTEMPTS, classifySyncFault } from "./sync-outcome";

const notEnabled = () =>
  new NotEnabledError("dosespot", "upsertPatient", "E-prescribe is not enabled.", "c1");
const configFault = () =>
  new ConfigUnavailableError("dosespot", "upsertPatient", "Config unavailable.", "c2");
const transient = () => new DegradedError("dosespot", "upsertPatient", true, "Vendor busy.", "c3");
const rejected = () =>
  new DegradedError("dosespot", "upsertPatient", false, "Vendor rejected it.", "c4");

const REGISTERED = { attemptCount: 0, orgHasRegistration: true } as const;

describe("a tenant that registered DoseSpot but is not live yet", () => {
  it("leaves the row pending (defer) on `not enabled`: it did not fail", () => {
    expect(classifySyncFault(notEnabled(), REGISTERED)).toEqual({
      kind: "defer",
      error: "E-prescribe is not enabled.",
    });
  });

  it("defers however many attempts the row has spent: waiting is not an attempt", () => {
    expect(
      classifySyncFault(notEnabled(), { ...REGISTERED, attemptCount: SYNC_MAX_ATTEMPTS + 5 }).kind,
    ).toBe("defer");
  });
});

describe("a tenant that never registered anything", () => {
  it("keeps `not enabled` terminal: its rows are not parked for the day it switches DoseSpot on", () => {
    expect(classifySyncFault(notEnabled(), { attemptCount: 0, orgHasRegistration: false })).toEqual(
      { kind: "failed", error: "E-prescribe is not enabled." },
    );
  });
});

describe("a config the platform could not read", () => {
  it.each([true, false])("defers (the row is not at fault), registered=%s", (registered) => {
    expect(
      classifySyncFault(configFault(), { attemptCount: 3, orgHasRegistration: registered }),
    ).toEqual({ kind: "defer", error: "Config unavailable." });
  });
});

describe("a transient vendor failure", () => {
  it("requeues while the attempt budget lasts", () => {
    expect(
      classifySyncFault(transient(), {
        attemptCount: SYNC_MAX_ATTEMPTS - 2,
        orgHasRegistration: true,
      }).kind,
    ).toBe("requeue");
  });

  it("ends the row on its last attempt, and says why (it is not retried every tick forever)", () => {
    const out = classifySyncFault(transient(), {
      attemptCount: SYNC_MAX_ATTEMPTS - 1,
      orgHasRegistration: true,
    });
    expect(out).toEqual({
      kind: "failed",
      error: `Vendor busy. (gave up after ${SYNC_MAX_ATTEMPTS} attempts)`,
    });
  });
});

describe("a failure the same call would repeat", () => {
  it("a non-retryable vendor rejection ends the row", () => {
    expect(classifySyncFault(rejected(), REGISTERED)).toEqual({
      kind: "failed",
      error: "Vendor rejected it.",
    });
  });

  it("a plain error is reported as it is and ends the row", () => {
    expect(classifySyncFault(new Error("no such patient"), REGISTERED)).toEqual({
      kind: "failed",
      error: "no such patient",
    });
    expect(classifySyncFault("weird", REGISTERED)).toEqual({ kind: "failed", error: "weird" });
  });
});
