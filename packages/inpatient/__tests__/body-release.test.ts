// @wardenx/inpatient — M37-T09 unit tests for the §2.11 D12 body-release coordination machine.
import { describe, expect, it } from "vitest";
import {
  BODY_RELEASE_GRAPH,
  isBodyReleaseClosed,
  planOpenBodyRelease,
  transitionBodyRelease,
} from "../src/machines/ipu-body-release";
import { IpuStateError } from "../src/errors";

const kinds = (t: { effects: readonly { kind: string }[] }) => t.effects.map((e) => e.kind);
const outbox = (t: { effects: readonly { kind: string; event?: string }[] }) =>
  t.effects.filter((e) => e.kind === "outbox").map((e) => e.event);

describe("body-release machine (§2.11 D12)", () => {
  it("auto-opens at pending and alerts", () => {
    const t = planOpenBodyRelease();
    expect(t.to).toBe("pending");
    expect(t.from).toBeNull();
    expect(outbox(t)).toEqual(["m37.body_release.pending"]);
  });

  it("identifyFuneralHome emits the magic-link + document-render triggers", () => {
    const t = transitionBodyRelease("pending", { type: "identifyFuneralHome", funeralHomeResolved: true });
    expect(t.to).toBe("funeral_home_identified");
    expect(outbox(t)).toEqual(["m37.body_release.funeral_home_identified", "m37.body_release.document_requested"]);
  });

  it("identifyFuneralHome requires a resolved M40 funeral home", () => {
    try {
      transitionBodyRelease("pending", { type: "identifyFuneralHome", funeralHomeResolved: false });
    } catch (e) {
      expect((e as IpuStateError).code).toBe("BODY_RELEASE_FUNERAL_HOME_UNRESOLVED");
      expect((e as IpuStateError).statusCode).toBe(422);
    }
  });

  it("releaseBody requires the signed document and THEN resumes the bed cleaning cycle", () => {
    // No document → 412.
    try {
      transitionBodyRelease("funeral_home_identified", { type: "releaseBody", hasReleaseDocument: false });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as IpuStateError).code).toBe("BODY_RELEASE_DOCUMENT_REQUIRED");
    }
    const t = transitionBodyRelease("funeral_home_identified", { type: "releaseBody", hasReleaseDocument: true });
    expect(t.to).toBe("released");
    // The deferred bed-cleaning transition fires only now (the body was in the room until release).
    expect(t.effects).toContainEqual({ kind: "source_bed_cleaning", event: "dischargeDirty" });
    expect(outbox(t)).toContain("m37.body_release.completed");
  });

  it("postClose is system-only and terminal", () => {
    expect(() => transitionBodyRelease("released", { type: "postClose", isSystemActor: false })).toThrow(IpuStateError);
    const t = transitionBodyRelease("released", { type: "postClose", isSystemActor: true });
    expect(t.to).toBe("closed");
    expect(isBodyReleaseClosed("closed")).toBe(true);
    expect(BODY_RELEASE_GRAPH.closed).toEqual([]);
  });

  it("rejects out-of-order transitions", () => {
    expect(() => transitionBodyRelease("pending", { type: "releaseBody", hasReleaseDocument: true })).toThrow(
      /ILLEGAL_BODY_RELEASE_TRANSITION|cannot releaseBody/,
    );
    // The bed does NOT dirty before release completes.
    const identify = transitionBodyRelease("pending", { type: "identifyFuneralHome", funeralHomeResolved: true });
    expect(kinds(identify)).not.toContain("source_bed_cleaning");
  });
});
