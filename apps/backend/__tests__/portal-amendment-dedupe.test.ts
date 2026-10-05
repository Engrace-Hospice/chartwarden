/**
 * GAP-006 follow-up — a portal amendment resubmitted under a NEW Idempotency-Key must not open a second
 * §164.526 request while the first is still open. The intake inserts ON CONFLICT DO NOTHING against
 * migration 0323's partial unique index and reads the open row back; this fake models that index
 * (unique on patient + dedupe key over `pending` rows only) so the orchestration is pinned without a DB.
 * The real index and the concurrent case are proven as `wardenx_app` in auth.live.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  PORTAL_DEDUPE_KEY_FIELD,
  type PortalAmendmentWriteOps,
  normalizeRequestedChange,
  portalAmendmentDedupeKey,
  submitDedupedPortalAmendment,
} from "../src/modules/05-patient/portal-amendment-intake";

type Ops = PortalAmendmentWriteOps;
type NewRow = Parameters<Ops["insertUnlessOpenDuplicate"]>[0];
type Row = NonNullable<Awaited<ReturnType<Ops["insertUnlessOpenDuplicate"]>>>;

const keyOf = (r: { requestedChanges: unknown }) =>
  (r.requestedChanges as Record<string, string>)[PORTAL_DEDUPE_KEY_FIELD];

/** In-memory `patient_amendment_request` with 0323's partial unique index. */
function fakeTable(hooks: { beforeFind?: (rows: Row[]) => void } = {}) {
  const rows: Row[] = [];
  const ops: Ops = {
    async insertUnlessOpenDuplicate(v: NewRow) {
      const clash = rows.some(
        (r) => r.status === "pending" && r.patientId === v.patientId && keyOf(r) === keyOf(v),
      );
      if (clash) return null;
      const row = {
        id: `amd-${rows.length + 1}`,
        providerEntityId: null,
        locationId: null,
        reviewerUserId: null,
        denialReason: null,
        statementOfDisagreement: null,
        receivedAt: new Date("2026-10-04T12:00:00Z"),
        decidedAt: null,
        ...v,
        status: v.status ?? "pending",
      } as Row;
      rows.push(row);
      return row;
    },
    async findOpenDuplicate({ patientId, dedupeKey }) {
      hooks.beforeFind?.(rows);
      return (
        rows.find(
          (r) => r.status === "pending" && r.patientId === patientId && keyOf(r) === dedupeKey,
        ) ?? null
      );
    },
  };
  const close = (id: string, status: Row["status"]) => {
    const i = rows.findIndex((r) => r.id === id);
    rows[i] = { ...(rows[i] as Row), status, decidedAt: new Date() };
  };
  return { rows, ops, close };
}

const base = {
  organizationId: "org-1",
  patientId: "pat-1",
  requestedByUserId: "user-1",
  portalAccountId: "acct-1",
  targetKind: "patient_demographic" as const,
  targetRef: "dateOfBirth",
  requestedChange: "Date of birth should be 1960-01-01",
};

describe("portal amendment dedupe (open duplicates)", () => {
  it("a resubmit of the same open change returns the EXISTING request — one row, same id", async () => {
    const t = fakeTable();
    const first = await submitDedupedPortalAmendment(t.ops, base);
    const again = await submitDedupedPortalAmendment(t.ops, {
      ...base,
      requestedChange: "  Date of birth   should be\n1960-01-01 ",
    });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("pending");
    expect(t.rows).toHaveLength(1);
  });

  it("different text, a different target ref, or a different target kind each create a new request", async () => {
    const t = fakeTable();
    const a = await submitDedupedPortalAmendment(t.ops, base);
    const b = await submitDedupedPortalAmendment(t.ops, {
      ...base,
      requestedChange: "Date of birth should be 1961-01-01",
    });
    const c = await submitDedupedPortalAmendment(t.ops, { ...base, targetRef: "legalName" });
    const d = await submitDedupedPortalAmendment(t.ops, {
      ...base,
      targetKind: "encounter_narrative",
    });
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4);
    expect(t.rows).toHaveLength(4);
  });

  it("another patient's identical change is not a duplicate", async () => {
    const t = fakeTable();
    const a = await submitDedupedPortalAmendment(t.ops, base);
    const b = await submitDedupedPortalAmendment(t.ops, { ...base, patientId: "pat-2" });
    expect(b.id).not.toBe(a.id);
  });

  it("once the open request is decided (or withdrawn), the same change may be requested again", async () => {
    const t = fakeTable();
    const first = await submitDedupedPortalAmendment(t.ops, base);
    t.close(first.id, "denied");
    const second = await submitDedupedPortalAmendment(t.ops, base);
    expect(second.id).not.toBe(first.id);
    t.close(second.id, "withdrawn");
    const third = await submitDedupedPortalAmendment(t.ops, base);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it("the open row closing between conflict and read-back → inserts a fresh request (no lost submit)", async () => {
    let closedOnce = false;
    const t = fakeTable({
      beforeFind: (rows) => {
        if (closedOnce) return;
        closedOnce = true;
        rows[0] = { ...(rows[0] as Row), status: "accepted" };
      },
    });
    const first = await submitDedupedPortalAmendment(t.ops, base);
    const second = await submitDedupedPortalAmendment(t.ops, base);
    expect(second.id).not.toBe(first.id);
    expect(t.rows.filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("stores the key on the row, and normalization is trim + whitespace-collapse only", () => {
    expect(normalizeRequestedChange("  a \t b\n\nc  ")).toBe("a b c");
    expect(portalAmendmentDedupeKey(base)).toBe(
      portalAmendmentDedupeKey({ ...base, requestedChange: `\n${base.requestedChange}  ` }),
    );
    // Case is meaningful in a requested correction — not folded.
    expect(portalAmendmentDedupeKey(base)).not.toBe(
      portalAmendmentDedupeKey({ ...base, requestedChange: base.requestedChange.toUpperCase() }),
    );
  });
});
