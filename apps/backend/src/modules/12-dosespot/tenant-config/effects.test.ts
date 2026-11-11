// Slice 4 — the lost-service alert: each change is its OWN alert. `AlertEmitter.emit` collapses a repeat of (org, correlationId), and the
// correlation id is built from the payload's `...Id` keys plus the UTC day, so a payload with only the registration id would silence a
// second deactivation or rotation of the same registration on the same day.
import { describe, expect, it } from "vitest";
import { DEACTIVATED_ALERT, alertAfterCommit } from "./effects";

const reg = (version: number) => ({ id: "reg-1", environment: "sandbox" as const, version });

describe("alertAfterCommit", () => {
  it("dispatches only when the registration stopped being live", async () => {
    const sent: unknown[] = [];
    const alerts = { dispatch: async (a: unknown) => void sent.push(a) };
    await alertAfterCommit(alerts, "org-1", reg(3), null);
    await alertAfterCommit(alerts, "org-1", reg(3), { kind: "activated" });
    expect(sent).toHaveLength(0);
    await alertAfterCommit(alerts, "org-1", reg(3), { kind: "deactivated", cause: "deactivated" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      alertCode: DEACTIVATED_ALERT,
      organizationId: "org-1",
      severity: "warn",
    });
  });

  it("names the change in a key ending in Id, so two changes on one day are two alerts, and carries no credential", async () => {
    const sent: { payload: Record<string, unknown> }[] = [];
    const alerts = {
      dispatch: async (a: { payload: Record<string, unknown> }) => void sent.push(a),
    };
    await alertAfterCommit(alerts, "org-1", reg(3), { kind: "deactivated", cause: "deactivated" });
    await alertAfterCommit(alerts, "org-1", reg(5), {
      kind: "deactivated",
      cause: "credential_changed",
    });
    const ids = sent.map((a) => a.payload.changeId);
    expect(ids).toEqual(["reg-1:3", "reg-1:5"]);
    expect(new Set(ids).size).toBe(2);
    expect(Object.keys(sent[0]?.payload ?? {}).filter((k) => k.endsWith("Id"))).toContain(
      "changeId",
    );
    expect(JSON.stringify(sent)).not.toMatch(/key|secret/i);
  });
});
