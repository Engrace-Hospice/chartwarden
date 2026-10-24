// apps/backend/src/modules/22-documents/render-pdf/audit-response-doc.ts — the `audit_response_packet` template: M25's
// typed AuditResponsePacketRenderPayload -> a {@link DocModel} (hospice ADR/TPE/QIC PRD, milestone 7a-2). Pure. Like
// the appeal and ADR packets, a payload that fails its schema THROWS (the render consumer retries then dead-letters):
// this is the retained record of what went to an audit contractor, and a silently half-empty one is worse than a
// visible failed render.
//
// What it carries: the cover sheet (the authority as a label, the request reference, dates, when and how it was filed,
// the proof reference, whether it was late), the due dates exactly as the person typed them (or the statement that the
// request letter states none), the checklist as typed, the claims and the enclosure index. The enclosures are NAMED
// (title, date, kind); the documents themselves are delivered separately and are never merged in here. No requirement
// of any audit contractor is stated.
import {
  type AuditResponsePacketRenderPayload,
  assertAuditResponsePacketRenderPayload,
} from "@chartwarden/types";
import type { Block, DocModel } from "./doc-model";
import { fmtDate, fmtInstant, humanize, shortId } from "./shared";

export function buildAuditResponseDoc(payload: unknown): DocModel {
  const p: AuditResponsePacketRenderPayload = assertAuditResponsePacketRenderPayload(payload);
  const to = p.authorityName ?? humanize(p.authorityKind);
  const title = "Audit Response Packet";
  const blocks: Block[] = [
    { kind: "title", text: title, subtitle: `To: ${to}` },
    {
      kind: "facts",
      rows: [
        ["Audit request", shortId(p.auditRequestId)],
        ["Authority", humanize(p.authorityKind)],
        ["Request reference", p.requestReference ?? "-"],
        ["Date on the request letter", p.requestDatedOn ? fmtDate(p.requestDatedOn) : "-"],
        ["Received", fmtDate(p.receivedOn)],
        ["Filed", fmtInstant(p.filedAt)],
        ["Filed by", humanize(p.filingChannel)],
        ["Confirmation reference", p.filingConfirmationRef],
        ["Reviewed", fmtInstant(p.reviewedAt)],
      ],
    },
  ];
  if (p.filedLate) {
    blocks.push({ kind: "banner", tone: "warn", text: "Filed after a recorded due date" });
  }
  blocks.push(
    { kind: "heading", level: 1, text: "Due dates" },
    p.deadlines.length > 0
      ? {
          kind: "table",
          columns: [
            { header: "For", weight: 6 },
            { header: "Due (as typed from the notice)", weight: 3 },
            { header: "Satisfied", weight: 3 },
          ],
          rows: p.deadlines.map((d) => [
            d.label,
            fmtDate(d.dueOn),
            d.satisfiedOn ? fmtDate(d.satisfiedOn) : "-",
          ]),
          emptyText: "",
        }
      : {
          kind: "banner",
          tone: "info",
          text: p.noDeadlineStatedAttested
            ? "The request letter states no due date (attested by the person who filed)."
            : "No due date was recorded.",
        },
    { kind: "heading", level: 1, text: "Response checklist (as typed from the request)" },
    {
      kind: "table",
      columns: [
        { header: "Item", weight: 6 },
        { header: "Status", weight: 3 },
      ],
      rows: p.checklist.map((c) => [c.label, humanize(c.state)]),
      emptyText: "No checklist items were recorded.",
    },
    { kind: "heading", level: 1, text: "Claims" },
    {
      kind: "table",
      columns: [
        { header: "Claim", weight: 3 },
        { header: "Control number", weight: 6 },
      ],
      rows: p.claims.map((c) => [shortId(c.claimId), c.claimControlNumber ?? "-"]),
      emptyText: "No claims were listed.",
    },
    { kind: "heading", level: 1, text: "Enclosures" },
    {
      kind: "table",
      columns: [
        { header: "#", weight: 1 },
        { header: "Document", weight: 6 },
        { header: "Type", weight: 3 },
        { header: "Dated", weight: 3 },
        { header: "Claim", weight: 3 },
      ],
      rows: p.enclosures.map((d) => [
        String(d.ordinal),
        d.title,
        humanize(d.documentKind),
        fmtDate(d.documentDate),
        shortId(d.claimId),
      ]),
      emptyText: "No documents were attached.",
    },
  );
  return { title, createdAtIso: p.filedAt, blocks };
}
