// The notice views carry the "file with your biller" fact for a tenant that bills outside ChartWarden (owner decision D4), so the
// worklist and the detail can say so: parked = `filed_externally_pending`, recorded = `filed_externally` with the date.
import type { repositories } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";
import { mapNoe, mapNotr } from "./notice-views";

const created = new Date("2026-11-02T12:00:00.000Z");
const common = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-0000000000a1",
  providerEntityId: "00000000-0000-4000-8000-0000000000e1",
  patientId: "00000000-0000-4000-8000-0000000000b1",
  admissionId: "00000000-0000-4000-8000-0000000000d1",
  state: "ready",
  windowTargetAt: "2026-11-06",
  windowBreachedAt: null,
  acceptedAt: null,
  clearinghouseAcceptedAt: null,
  rejectedAt: null,
  rejectionStage: null,
  rejectionCodes: null,
  payerStatusDate: null,
  payerStatusDateSource: null,
  correctsNoticeId: null,
  correctionReason: null,
  latestSubmissionId: null,
  latestAcknowledgmentId: null,
  confirmationDocumentId: null,
  externalFilingStatus: null,
  filedExternallyOn: null,
  filedExternallyRecordedAt: null,
  filedExternallyByMembershipId: null,
  version: 3,
  createdAt: created,
  updatedAt: created,
};
const noeRow = {
  ...common,
  electionPeriodId: "00000000-0000-4000-8000-0000000000c1",
  electionEffectiveDate: "2026-11-01",
  noeControlNumber: "H00001-261101-0abcd-00",
  payerNoeControlNumber: null,
} as unknown as repositories.NoeRecord;
const notrRow = {
  ...common,
  triggerKind: "discharge",
  revocationEventId: null,
  transferEventId: null,
  dischargeEventId: "00000000-0000-4000-8000-0000000000f1",
  effectiveEndDate: "2026-11-01",
  notrControlNumber: "H00001-261101-0abcd-00",
  payerNotrControlNumber: null,
} as unknown as repositories.NotrRecord;

const recordedAt = new Date("2026-11-04T15:30:00.000Z");
const pending = { externalFilingStatus: "pending" } as const;
const filed = {
  externalFilingStatus: "filed",
  filedExternallyOn: "2026-11-04",
  filedExternallyRecordedAt: recordedAt,
  filedExternallyByMembershipId: "00000000-0000-4000-8000-0000000000aa",
} as const;

describe.each([
  ["NOE", (over: object) => mapNoe({ ...noeRow, ...over } as repositories.NoeRecord)],
  ["NOTR", (over: object) => mapNotr({ ...notrRow, ...over } as repositories.NotrRecord)],
])("%s view: externalFiling", (_kind, map) => {
  it("is null for a notice on ChartWarden's own path", () => {
    expect(map({}).externalFiling).toBeNull();
  });

  it("says filed_externally_pending for a parked notice, with no date", () => {
    expect(map(pending).externalFiling).toEqual({
      status: "filed_externally_pending",
      filedOn: null,
      recordedAt: null,
    });
  });

  it("says filed_externally with the tenant's date once recorded, and never who recorded it", () => {
    const view = map(filed).externalFiling;
    expect(view).toEqual({
      status: "filed_externally",
      filedOn: "2026-11-04",
      recordedAt: recordedAt.toISOString(),
    });
    expect(JSON.stringify(view)).not.toContain("0aa");
  });
});
