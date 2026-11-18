// ADR-0113 — what the closure banner says. The server decided the stage and the verdict; these tests pin the WORDING rules: nothing
// for mode off or an ok stage, severity by state, and no claim that access is limited unless the clinician is blocked (or the tenant
// is on `block`).
import { describe, expect, it } from "vitest";
import { formatClosureInstant } from "./closure-instant";
import type { NoteClosureStatus } from "./note-closure";
import { closureBannerModel } from "./note-closure-banner-model";

const NOW = new Date("2026-11-17T12:00:00.000Z");
const OLDEST = "e0000000-0000-4000-8000-000000000001";

const status = (over: Partial<NoteClosureStatus> = {}): NoteClosureStatus => ({
  mode: "warn",
  thresholdHours: 24,
  verdict: "clear",
  stage: "ok",
  encounterId: null,
  deadlineAt: null,
  hoursOverdue: 0,
  overdueCount: 0,
  overrideExpiresAt: null,
  ...over,
});

const text = (model: NonNullable<ReturnType<typeof closureBannerModel>>): string =>
  `${model.title} ${model.detail}`;

describe("closureBannerModel", () => {
  it("says nothing before the first answer", () => {
    expect(closureBannerModel(null, NOW)).toBeNull();
  });

  it("says nothing for mode off, whatever the stage", () => {
    expect(
      closureBannerModel(status({ mode: "off", stage: "overdue", verdict: "warn" }), NOW),
    ).toBeNull();
  });

  it("says nothing while every note is ok", () => {
    expect(closureBannerModel(status(), NOW)).toBeNull();
  });

  it("at risk is an info notice carrying the deadline, and never mentions limits", () => {
    const model = closureBannerModel(
      status({ stage: "at_risk", encounterId: OLDEST, deadlineAt: "2026-11-17T18:00:00.000Z" }),
      NOW,
    );
    expect(model).toMatchObject({ tone: "info", blocked: false });
    expect(text(model!)).toMatch(/due/i);
    expect(text(model!)).not.toMatch(/limit|block|refus/i);
  });

  it.each(["overdue", "escalated"] as const)(
    "%s in warn mode is a warning that does NOT claim access is limited",
    (stage) => {
      const model = closureBannerModel(
        status({
          stage,
          verdict: "warn",
          overdueCount: 2,
          encounterId: OLDEST,
          deadlineAt: "2026-11-17T06:00:00.000Z",
        }),
        NOW,
      );
      expect(model).toMatchObject({ tone: "warning", blocked: false });
      expect(model?.title).toBe("2 visit notes are overdue");
      expect(text(model!)).not.toMatch(/limit|block|refus|access/i);
    },
  );

  it("a single overdue note is worded in the singular", () => {
    const model = closureBannerModel(
      status({ stage: "overdue", verdict: "warn", overdueCount: 1 }),
      NOW,
    );
    expect(model?.title).toBe("A visit note is overdue");
    expect(model?.detail).toContain("Close it");
  });

  it("overdue in block mode inside the grace window warns that other work is limited, without saying it already is", () => {
    const model = closureBannerModel(
      status({ mode: "block", stage: "overdue", verdict: "warn", overdueCount: 1 }),
      NOW,
    );
    expect(model).toMatchObject({ tone: "warning", blocked: false });
    expect(model?.detail).toMatch(/limits other work while a note stays overdue/);
  });

  it("blocked is an error that says access is limited, names the oldest note and points to a supervisor override", () => {
    const model = closureBannerModel(
      status({
        mode: "block",
        verdict: "blocked",
        stage: "overdue",
        overdueCount: 3,
        encounterId: OLDEST,
        deadlineAt: "2026-11-17T06:00:00.000Z",
      }),
      NOW,
    );
    expect(model).toMatchObject({ tone: "error", blocked: true, encounterId: OLDEST });
    expect(text(model!)).toMatch(/access is limited/i);
    expect(text(model!)).toContain("3 visit notes are past the deadline");
    expect(text(model!)).toMatch(/ask a supervisor for a temporary override/i);
  });

  it("an active override shows its expiry instead of the blocking wording", () => {
    const expiresAt = "2026-11-17T15:30:00.000Z";
    const model = closureBannerModel(
      status({
        mode: "block",
        verdict: "warn",
        stage: "overdue",
        overdueCount: 1,
        encounterId: OLDEST,
        overrideExpiresAt: expiresAt,
      }),
      NOW,
    );
    expect(model).toMatchObject({ tone: "warning", blocked: false });
    expect(model?.title).toMatch(/temporarily lifted/);
    expect(model?.detail).toContain(formatClosureInstant(expiresAt));
  });

  it("an override that has already expired no longer counts: the overdue wording returns", () => {
    const model = closureBannerModel(
      status({
        mode: "block",
        verdict: "warn",
        stage: "overdue",
        overdueCount: 1,
        overrideExpiresAt: "2026-11-17T11:59:59.000Z",
      }),
      NOW,
    );
    expect(model?.title).toBe("A visit note is overdue");
  });

  it("blocked wins over an override expiry the server still reports", () => {
    const model = closureBannerModel(
      status({
        mode: "block",
        verdict: "blocked",
        stage: "overdue",
        overdueCount: 1,
        overrideExpiresAt: "2026-11-17T15:30:00.000Z",
      }),
      NOW,
    );
    expect(model?.blocked).toBe(true);
  });
});
