// GAP-140 / GAP-141 — the M22 worker helpers that need no database: failure classification, the fan-out's
// per-org failure isolation, and the nightly ai-block tick (alert-then-fail).
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { UnknownTemplateError } from "../seams/renderer";
import { runAiBlockValidatorTick } from "./ai-block-validator-worker";
import {
  failureReasonOf,
  isPermanentRenderFailure,
  runFormRenderFanout,
} from "./form-render-worker";
import { runRetentionRotationFanout } from "./retention-rotation-worker";

const throwingDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db down");
    },
  },
) as DbClient;
const orgs = (...ids: string[]) => ({
  listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
});

describe("form-render failure classification", () => {
  it("treats an unknown template as permanent and anything else as transient", () => {
    expect(isPermanentRenderFailure(new UnknownTemplateError("nope"))).toBe(true);
    expect(isPermanentRenderFailure(new Error("socket hang up"))).toBe(false);
  });

  it("builds a bounded, payload-free reason", () => {
    const reason = failureReasonOf(new Error("x".repeat(2000)));
    expect(reason.startsWith("Error: ")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(500);
  });
});

describe("fan-outs isolate orgs and re-raise every failure together", () => {
  it("form-render attempts every org, then raises one AggregateError", async () => {
    const attempted: string[] = [];
    await expect(
      runFormRenderFanout({
        db: throwingDb,
        renderer: { render: async () => ({ documentId: "d" }) },
        activeOrgs: {
          listActiveOrgs: async () => {
            attempted.push("listed");
            return [{ organizationId: "a" }, { organizationId: "b" }];
          },
        },
      }),
    ).rejects.toMatchObject({ errors: [expect.anything(), expect.anything()] });
    expect(attempted).toEqual(["listed"]);
  });

  it("retention-rotation does the same", async () => {
    await expect(
      runRetentionRotationFanout({ db: throwingDb, activeOrgs: orgs("a", "b", "c") }),
    ).rejects.toMatchObject({ errors: [expect.anything(), expect.anything(), expect.anything()] });
  });

  it("an org enumeration failure is loud, not an empty tick", async () => {
    await expect(
      runRetentionRotationFanout({
        db: throwingDb,
        activeOrgs: {
          listActiveOrgs: async () => {
            throw new Error("platform pool unavailable");
          },
        },
      }),
    ).rejects.toThrow("platform pool unavailable");
  });
});

describe("nightly ai-block validator tick", () => {
  const targeting = (zone: string) => ({
    getActivePromptsTargeting: async (prefix: string) =>
      zone.startsWith(prefix)
        ? [{ promptTemplateId: "p", templateKey: "bad", outputEntityTargetPrefix: zone }]
        : [],
  });

  it("passes on a clean registry and with none", async () => {
    await expect(
      runAiBlockValidatorTick({ registry: () => targeting("encounter_narrative") }),
    ).resolves.toBeUndefined();
    await expect(runAiBlockValidatorTick({ registry: () => null })).resolves.toBeUndefined();
  });

  it("alerts and then fails the job when a template targets the human-decision zone", async () => {
    const alerts: string[] = [];
    await expect(
      runAiBlockValidatorTick({
        registry: () => targeting("extraction_decision_x"),
        onViolation: (m) => void alerts.push(m),
      }),
    ).rejects.toThrow(/D7/);
    expect(alerts).toHaveLength(1);
  });

  it("still fails the job when the alert path itself throws", async () => {
    await expect(
      runAiBlockValidatorTick({
        registry: () => targeting("extraction_review_x"),
        onViolation: () => {
          throw new Error("alert outage");
        },
      }),
    ).rejects.toThrow(/D7/);
  });
});
