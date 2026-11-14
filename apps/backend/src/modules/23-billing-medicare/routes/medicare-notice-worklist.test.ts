import { describe, expect, it, vi } from "vitest";
import { encodeCursor } from "@chartwarden/billing";
import { buildMedicareNoticeWorklistService } from "./medicare-notice-worklist";
import type { M23ReadRouteService, NoeView, NotrView } from "./read-service";
import type { TransferNoticeService, TransferNoticeView } from "../services/transfer-notice-service";

const actor = { organizationId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", roles: [] };
const acceptedDeadline = {
  applies: true, basis: "CMS verified policy", policyVersion: "CMS-100-04-Ch11-20.1.1-20.1.2-2024-06-03" as const,
  triggerDate: "2026-11-10", dueDate: "2026-11-15", risk: "approaching" as const, lifecycle: "ready" as const,
  acceptance: "not_verified" as const, acceptedAt: null, timeliness: "unknown" as const, followUp: "Review.",
};
function noe(id: string, createdAt: string): NoeView {
  return { noeId: id, organizationId: actor.organizationId, providerEntityId: actor.organizationId, patientId: id, admissionId: id,
    electionPeriodId: id, state: "ready", electionEffectiveDate: "2026-11-10", windowTargetAt: "2026-11-15", windowBreachedAt: null,
    deadline: acceptedDeadline, evidenceTimeline: [], externalFiling: null, noeControlNumber: "n", payerNoeControlNumber: null,
    acceptedAt: null, rejectedAt: null, rejectionStage: null, rejectionCodes: [], payerStatusDate: null, payerStatusDateSource: null,
    correctionOf: null, correctedBy: [], latestSubmissionId: null, latestAttempt: null, latestAcknowledgmentId: null,
    confirmationDocumentId: null, version: 1, createdAt, updatedAt: createdAt } as unknown as NoeView;
}
function notr(id: string, createdAt: string): NotrView {
  return { ...noe(id, createdAt), notrId: id, triggerKind: "revocation", revocationEventId: id, transferEventId: null,
    dischargeEventId: null, effectiveEndDate: "2026-11-10", notrControlNumber: "r" } as unknown as NotrView;
}
function transfer(id: string, action: "original" | "void", createdAt: string): TransferNoticeView {
  return { transferNoticeId: id, organizationId: actor.organizationId, providerEntityId: actor.organizationId,
    patientId: id, admissionId: id, transferEventId: id, action, supersedesNoticeId: null, state: "ready", tob: action === "void" ? "81D" : "81C",
    statementFromDate: "2026-11-10", originalTransferDate: null, admissionDate: "2026-11-10", benefitPeriodSequence: 1,
    benefitPeriodStartDate: null, priorHospiceName: "Prior", priorHospiceCcn: null, priorHospiceNpi: null, providerCcn: "123456",
    priorBillingConfirmedAt: null, priorHospiceThroughDate: null, priorHospicePatientStatus: null, controlNumber: "t", payerControlNumber: null,
    latestSubmissionId: null, latestSubmissionOutcome: null, latestSubmissionDispatchState: null, cancelReason: null,
    blockers: [], warnings: [], conditionCodes: [], occurrenceCodes: [], allowedActions: [], followUp: null, version: 1, createdAt, updatedAt: createdAt };
}

describe("Medicare notice unified worklist", () => {
  it("uses type-qualified identity and stable global pagination across source cursors", async () => {
    const created = "2026-11-13T12:00:00.000Z";
    const noeRows = [noe("00000000-0000-4000-8000-000000000010", created)];
    const notrRows = [notr("00000000-0000-4000-8000-000000000010", created)];
    const transferRows = [transfer("00000000-0000-4000-8000-000000000011", "original", created), transfer("00000000-0000-4000-8000-000000000012", "void", "2026-11-12T12:00:00.000Z")];
    const paged = <T extends { createdAt: string; [key: string]: unknown }>(rows: readonly T[], cursor?: string, limit = 100, key = "id") => {
      const anchor = cursor ? JSON.parse(Buffer.from(cursor.split(".")[0]!, "base64url").toString("utf8")) as { createdAt: string; id: string } : null;
      const rest = anchor ? rows.filter((row) => row.createdAt < anchor.createdAt || (row.createdAt === anchor.createdAt && String(row[key]) < anchor.id)) : [...rows];
      const items = rest.slice(0, limit);
      const last = items.at(-1);
      return { items, hasMore: rest.length > items.length, nextCursor: rest.length > items.length && last ? encodeCursor(actor.organizationId, { createdAt: last.createdAt, id: String(last[key]) }) : null };
    };
    // Real repository cursors are HMAC-signed; this fake only reads the service-provided opaque cursor state.
    // For deterministic test pages, provide the first source page only and assert the merged page boundary.
    const read = {
      listNoes: vi.fn(async (_a, _f, cursor?: string, limit?: number) => paged(noeRows, cursor, limit ?? 100, "noeId")),
      listNotrs: vi.fn(async (_a, _f, cursor?: string, limit?: number) => paged(notrRows, cursor, limit ?? 100, "notrId")),
    };
    const transfers = { list: vi.fn(async (_a, _f, cursor?: string, limit?: number) => paged(transferRows, cursor, limit ?? 100, "transferNoticeId")) };
    const service = buildMedicareNoticeWorklistService({ readService: read as unknown as M23ReadRouteService, transferNoticeService: transfers as unknown as TransferNoticeService, pageSize: 2 });
    const first = await service.list(actor, {}, ["noe", "notr", "transfer", "cancellation"], undefined, 2);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.identity).not.toEqual(first.items[1]?.identity);
    expect(first.hasMore).toBe(true);
    const second = await service.list(actor, {}, ["noe", "notr", "transfer", "cancellation"], first.nextCursor ?? undefined, 2);
    expect(second.items.map((item) => item.identity.type)).toContain("cancellation");
    expect(second.items.some((item) => first.items.some((prior) => prior.identity.type === item.identity.type && prior.identity.noticeId === item.identity.noticeId))).toBe(false);
    expect(read.listNoes).toHaveBeenCalled();
  });

  it("keeps transfer cancellation deadline not-applicable and transport blocked", async () => {
    const v = transfer("00000000-0000-4000-8000-000000000012", "void", "2026-11-12T12:00:00.000Z");
    const read = { listNoes: vi.fn(), listNotrs: vi.fn() };
    const transfers = { list: vi.fn(async () => ({ items: [v], hasMore: false, nextCursor: null })) };
    const service = buildMedicareNoticeWorklistService({ readService: read as unknown as M23ReadRouteService, transferNoticeService: transfers as unknown as TransferNoticeService });
    const page = await service.list(actor, { types: ["cancellation"] }, ["cancellation"], undefined, 10);
    expect(page.items[0]?.identity.type).toBe("cancellation");
    expect(page.items[0]?.deadline.risk).toBe("not_applicable");
    expect(page.items[0]?.readiness.find((check) => check.key === "transport")?.state).toBe("blocked");
  });

  it("projects exception provenance without treating an operator-attested decision as acceptance", async () => {
    const id = "00000000-0000-4000-8000-000000000020";
    const read = { listNoes: vi.fn(async () => ({ items: [noe(id, "2026-11-13T12:00:00.000Z")], hasMore: false, nextCursor: null })), listNotrs: vi.fn() };
    const transfers = { list: vi.fn() };
    const reviews = { summaries: vi.fn(async () => new Map([[id, { status: "external_approved_recorded", externalDecisionProvenance: "operator_attested_document" as const, updatedAt: "2026-11-13T12:00:00.000Z", evidenceDocumentIds: ["evidence"] }]])) };
    const service = buildMedicareNoticeWorklistService({ readService: read as unknown as M23ReadRouteService, transferNoticeService: transfers as unknown as TransferNoticeService, exceptionReviews: reviews as never });
    const page = await service.list(actor, { types: ["noe"] }, ["noe"], undefined, 10);
    expect(page.items[0]?.exceptionReview?.decisionProvenance).toBe("operator_attested_document");
    expect(page.items[0]?.macAcceptance).toBe("not_verified");
    expect(page.items[0]?.deadline.risk).toBe("approaching");
  });
});
