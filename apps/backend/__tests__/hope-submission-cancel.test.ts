// apps/backend/__tests__/hope-submission-cancel.test.ts — R-08: cancelling a packaged/exported iQIES package
// that was never uploaded, so its signed assessments are packaged again. Pure rules + the in-memory slice
// (the DB backend shares hope-submission-cancel.ts / hope-submission-result.ts; the live suite proves it on
// Postgres).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOPE_SUBMISSION_CANCEL_REASON_CODES, type HopeSubmissionStatus } from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { isCancellableSubmissionStatus } from "../src/modules/10-hope/hope-submission-cancel";
import {
  isResultImportable,
  resolveRejectedItem,
  resultRefusalCode,
} from "../src/modules/10-hope/hope-submission-result";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/index";
import { CancelSubmissionSchema } from "../src/modules/10-hope/routes/hope-typebox";

const ORG = "org_a";
const PE = "pe_1";
const A1 = "90000000-0000-4000-8000-000000000001";
const A2 = "90000000-0000-4000-8000-000000000002";
const base = (id: string) => ({
  id,
  organizationId: ORG,
  patientId: "11111111-1111-4111-8111-111111111111",
  admissionId: "adm_1",
  rfaKind: "01_admission" as const,
  status: "signed" as const,
  providerEntityId: PE,
  regulatory: { specVersionId: "sv_1", isc: "HA" as const },
});
const setup = () =>
  createInMemoryHopeBackend({
    now: () => "2026-06-08T12:00:00.000Z",
    assessments: [base(A1), base(A2)],
  });
const code = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof ChartWardenError ? e.code : "OTHER"),
  );

const ALL_STATUSES: readonly HopeSubmissionStatus[] = [
  "ready",
  "queued",
  "packaged",
  "exported",
  "in_flight",
  "submitted_pending_result",
  "accepted",
  "rejected",
  "partially_accepted",
  "accepted_with_warnings",
  "file_error",
  "cancelled",
];

describe("pure rules", () => {
  it("offers a closed, PHI-free reason list", () => {
    expect([...HOPE_SUBMISSION_CANCEL_REASON_CODES]).toEqual([
      "package_lost",
      "never_uploaded",
      "generated_in_error",
      "other",
    ]);
    expect(Value.Check(CancelSubmissionSchema, { reasonCode: "package_lost" })).toBe(true);
    expect(Value.Check(CancelSubmissionSchema, { reasonCode: "patient John Doe lost it" })).toBe(
      false,
    );
    expect(Value.Check(CancelSubmissionSchema, {})).toBe(false);
    expect(Value.Check(CancelSubmissionSchema, { reasonCode: "other", note: "free text" })).toBe(
      false,
    );
  });

  it("the migration's CHECK list is the shared code list (no drift)", () => {
    const sql = readFileSync(
      join(__dirname, "../../../packages/db/migrations/1495_m10_hope_submission_cancel.sql"),
      "utf8",
    );
    const check = /cancel_reason_code" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const inSql = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inSql).toEqual([...HOPE_SUBMISSION_CANCEL_REASON_CODES]);
  });

  it("the migration ties a cancelled status to its provenance, all or none, and stays additive", () => {
    const sql = readFileSync(
      join(__dirname, "../../../packages/db/migrations/1495_m10_hope_submission_cancel.sql"),
      "utf8",
    );
    const code = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    // `status::text`, not the enum literal: the new enum label cannot be used inside the transaction that adds it.
    // Both directions: a cancelled row needs all three, every other row needs none (`= 3` vs `= 0`), so a
    // half-filled provenance on a packaged batch is refused too.
    expect(code).toMatch(
      /num_nonnulls\("cancelled_at", "cancelled_by_membership_id", "cancel_reason_code"\)\s*=\s*CASE WHEN "status"::text = 'cancelled' THEN 3 ELSE 0 END/,
    );
    // Both CHECKs are inline on the new column, so no DROP/ADD CONSTRAINT statement (arch:migration-compat reads that
    // as `contract`). Replay was verified by hand on PostgreSQL 18.6 with `psql -v ON_ERROR_STOP=1` (twice, in
    // BEGIN/COMMIT, over a table that already had the columns): it succeeded both times, the inline CHECKs were skipped
    // together with their already-existing column, and exactly two CHECKs remained. That is server behaviour, not
    // something this test can pin without a database (the live suite replays nothing).
    expect(code).not.toMatch(/\bDROP\s+CONSTRAINT|\bADD\s+CONSTRAINT/i);
    expect(sql.split("\n")[0]).toBe("-- compat: expand");
  });

  it("only a never-uploaded (packaged/exported) batch is cancellable", () => {
    const cancellable = ALL_STATUSES.filter(isCancellableSubmissionStatus);
    expect(cancellable).toEqual(["packaged", "exported"]);
  });

  it("a cancelled batch can never receive a CMS result, and says so with its own code", () => {
    expect(isResultImportable("cancelled")).toBe(false);
    expect(resultRefusalCode("cancelled")).toBe("M10_SUBMISSION_CANCELLED");
    expect(resultRefusalCode("packaged")).toBe("M10_SUBMISSION_RESULT_NOT_UPLOADED");
    expect(resultRefusalCode("accepted")).toBe("M10_SUBMISSION_RESULT_ALREADY_RECORDED");
  });

  it("a correction whose only batch item was cancelled is still in progress, not resubmitted", () => {
    expect(resolveRejectedItem({ itemStatus: "cancelled" })).toBe("correction_in_progress");
  });
});

describe("cancelSubmission (in-memory slice)", () => {
  it("cancels a packaged batch, records who/why/when, and frees its assessments for a NEW batch", async () => {
    const svc = setup();
    const first = await svc.assembleSubmission(ORG, PE);
    expect(first.itemCount).toBe(2);
    // While the package is live the assessments are locked in it.
    expect(await code(svc.assembleSubmission(ORG, PE))).toBe("CONFLICT");

    const cancelled = await svc.cancelSubmission(ORG, "m_1", first.id, {
      reasonCode: "package_lost",
    });
    expect(cancelled).toMatchObject({
      id: first.id,
      status: "cancelled",
      cancelReasonCode: "package_lost",
      cancelledAt: "2026-06-08T12:00:00.000Z",
    });
    const detail = await svc.getSubmission(ORG, first.id);
    expect(detail.items.map((i) => i.status)).toEqual(["cancelled", "cancelled"]);

    const second = await svc.assembleSubmission(ORG, PE);
    expect(second.id).not.toBe(first.id);
    expect(second.itemCount).toBe(2);
    expect(second.status).toBe("packaged");
  });

  it("also cancels an exported (downloaded, never uploaded) batch", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.downloadSubmissionPackage(ORG, b.id);
    expect((await svc.getSubmission(ORG, b.id)).status).toBe("exported");
    expect(
      (await svc.cancelSubmission(ORG, "m_1", b.id, { reasonCode: "never_uploaded" })).status,
    ).toBe("cancelled");
  });

  it("refuses once the batch was marked uploaded (409) and leaves it untouched", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "m_1", b.id, {});
    expect(await code(svc.cancelSubmission(ORG, "m_1", b.id, { reasonCode: "other" }))).toBe(
      "M10_SUBMISSION_CANCEL_NOT_ALLOWED",
    );
    expect((await svc.getSubmission(ORG, b.id)).status).toBe("submitted_pending_result");
  });

  it("replaying a cancel is safe: the original reason and time stand, and a cancel emits no event at all", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    svc.drainEvents(); // the assemble's own queued event is not under test
    const once = await svc.cancelSubmission(ORG, "m_1", b.id, { reasonCode: "package_lost" });
    const again = await svc.cancelSubmission(ORG, "m_2", b.id, { reasonCode: "other" });
    expect(again).toEqual(once);
    // Nothing downstream (M30/M33) saw the package go out, so neither the cancel nor its replay publishes.
    expect(svc.drainEvents()).toEqual([]);
  });

  it("a cancelled batch refuses mark-uploaded, results, download and retry (409)", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.cancelSubmission(ORG, "m_1", b.id, { reasonCode: "generated_in_error" });
    expect(await code(svc.markSubmissionUploaded(ORG, "m_1", b.id, {}))).toBe(
      "M10_SUBMISSION_CANCELLED",
    );
    expect(
      await code(
        svc.importSubmissionResult(ORG, "m_1", b.id, {
          results: [{ assessmentId: A1, status: "accepted" }],
        }),
      ),
    ).toBe("M10_SUBMISSION_CANCELLED");
    expect(await code(svc.downloadSubmissionPackage(ORG, b.id))).toBe("M10_SUBMISSION_CANCELLED");
    expect(await code(svc.retrySubmission(ORG, b.id))).toBe("M10_SUBMISSION_RETRY_NOT_REJECTED");
  });

  it("is invisible across tenants (404)", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    expect(
      await code(svc.cancelSubmission("org_b", "m_1", b.id, { reasonCode: "package_lost" })),
    ).toBe("NOT_FOUND");
  });
});
