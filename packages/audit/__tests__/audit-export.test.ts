// @chartwarden/audit — M4-T11 compliance-export renderer tests (M4 spec §4.3, §4.4; M04-F04).
//
// Every format (csv/ndjson/pdf) carries the SEC-052 watermark, emits provenance metadata only
// (never PHI values), and escapes correctly.
import { describe, expect, it } from "vitest";
import { type AuditEventRecord, renderAuditExport } from "../src/index";

const WATERMARK = "CONFIDENTIAL — org_1 — req by user_7 — 2026-06-15 — reason: HIPAA audit";

function record(over: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: "evt_1",
    createdAt: "2026-06-15T12:00:00.000Z",
    organizationId: "org_1",
    actorUserId: "user_7",
    actorKind: "user",
    actorRole: "compliance_officer",
    eventType: "patient.viewed",
    resourceKind: "patient",
    resourceId: "pt_9",
    outcome: "success",
    severity: "info",
    before: { ssn: "<changed>" }, // present on the row, but exports never surface before/after
    after: { ssn: "<changed>" },
    context: { fields: ["ssn"] },
    retentionClass: "compliance",
    ...over,
  };
}

describe("renderAuditExport — watermark + format", () => {
  it("embeds the watermark in CSV and never leaks before/after PHI", () => {
    const artifact = renderAuditExport({ format: "csv", watermark: WATERMARK, records: [record()] });
    expect(artifact.contentType).toBe("text/csv; charset=utf-8");
    expect(artifact.recordCount).toBe(1);
    expect(artifact.body).toContain(`# ${WATERMARK}`);
    expect(artifact.body).toContain("id,createdAt,actorUserId");
    expect(artifact.body).toContain("evt_1");
    // before/after snapshots are deliberately omitted from the provenance export.
    expect(artifact.body).not.toContain("<changed>");
    expect(artifact.body).not.toContain("ssn");
  });

  it("embeds the watermark as the first NDJSON line and one object per record", () => {
    const artifact = renderAuditExport({
      format: "ndjson",
      watermark: WATERMARK,
      records: [record(), record({ id: "evt_2" })],
    });
    expect(artifact.contentType).toBe("application/x-ndjson; charset=utf-8");
    const lines = artifact.body.trimEnd().split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({ _watermark: WATERMARK });
    expect(JSON.parse(lines[1]!).id).toBe("evt_1");
    expect(JSON.parse(lines[2]!).id).toBe("evt_2");
    expect(lines).toHaveLength(3);
  });

  it("embeds the watermark in the PDF text layout", () => {
    const artifact = renderAuditExport({ format: "pdf", watermark: WATERMARK, records: [record()] });
    expect(artifact.contentType).toBe("application/pdf");
    expect(artifact.body).toContain(`WATERMARK: ${WATERMARK}`);
    expect(artifact.body).toContain("RECORDS: 1");
  });

  it("RFC-4180-escapes CSV cells containing commas/quotes", () => {
    const artifact = renderAuditExport({
      format: "csv",
      watermark: WATERMARK,
      records: [record({ actorRole: 'nurse, "RN"' })],
    });
    expect(artifact.body).toContain('"nurse, ""RN"""');
  });

  it("renders an empty record set with just the watermark + header", () => {
    const artifact = renderAuditExport({ format: "csv", watermark: WATERMARK, records: [] });
    expect(artifact.recordCount).toBe(0);
    const lines = artifact.body.trimEnd().split("\n");
    expect(lines).toEqual([`# ${WATERMARK}`, expect.stringContaining("id,createdAt")]);
  });
});
