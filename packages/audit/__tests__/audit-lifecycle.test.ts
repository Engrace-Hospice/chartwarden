// @wardenx/audit — M4-T08 unit tests (M4 spec §6, §10.5–10.6; W-M4-08, W-M4-09).
//
// The retention-driven destruction path: the eraser enforcing legal-hold supremacy + Part 2
// lifetime retention, and the destruction-certificate workflow that runs an approved certificate.
import { describe, expect, it } from "vitest";
import {
  type EraseInput,
  createInMemoryEraserPorts,
  eraseAuditRows,
  isPartTwoRetention,
  runDestruction,
} from "../src/index";

const ORG = "org_1";

/** Build an EraseInput with sensible defaults, overriding what a case cares about. */
function eraseInput(over: Partial<EraseInput> = {}): EraseInput {
  return {
    retentionClass: "compliance",
    resourceKind: "audit_event",
    resourceId: "evt_1",
    organizationId: ORG,
    destructionCertificateId: "cert_1",
    ...over,
  };
}

describe("W-M4-08 — Part 2 audit row carries the compliance_42cfr_part2 retention class", () => {
  it("recognizes the Part 2 class that drives the §6 lifetime check", () => {
    expect(isPartTwoRetention("compliance_42cfr_part2")).toBe(true);
    expect(isPartTwoRetention("compliance")).toBe(false);
    expect(isPartTwoRetention("operational")).toBe(false);
    expect(isPartTwoRetention("legal_hold")).toBe(false);
  });

  it("routes a Part 2-classed row through the lifetime check (refuses a living patient)", async () => {
    const { ports, erasedCalls } = createInMemoryEraserPorts({
      patients: { pt_1: { status: "active" } },
    });
    const outcome = await eraseAuditRows(
      eraseInput({ retentionClass: "compliance_42cfr_part2", patientId: "pt_1" }),
      ports,
    );
    expect(outcome.kind).toBe("refused_part_two_retention");
    expect(erasedCalls()).toBe(0); // the correct class kept the row out of performErasure
  });
});

describe("eraseAuditRows — §6 Part 2 lifetime retention + §10.6 legal-hold supremacy", () => {
  it("refuses a Part 2 row while the patient is alive (W-M4-09 core)", async () => {
    const { ports } = createInMemoryEraserPorts({ patients: { pt_1: { status: "active" } } });
    const outcome = await eraseAuditRows(
      eraseInput({ retentionClass: "compliance_42cfr_part2", patientId: "pt_1" }),
      ports,
    );
    expect(outcome).toEqual({ kind: "refused_part_two_retention", reason: "patient_alive" });
  });

  it("refuses a Part 2 row within 6 years of the patient's death", async () => {
    const { ports } = createInMemoryEraserPorts({
      now: "2026-06-15T00:00:00.000Z",
      patients: { pt_1: { status: "deceased", deceasedDate: "2024-01-01" } },
    });
    const outcome = await eraseAuditRows(
      eraseInput({ retentionClass: "compliance_42cfr_part2", patientId: "pt_1" }),
      ports,
    );
    expect(outcome).toEqual({
      kind: "refused_part_two_retention",
      reason: "within_6yr_post_death",
    });
  });

  it("erases a Part 2 row once the patient is > 6 years deceased", async () => {
    const { ports, erasedCalls } = createInMemoryEraserPorts({
      now: "2026-06-15T00:00:00.000Z",
      patients: { pt_1: { status: "deceased", deceasedDate: "2018-01-01" } },
    });
    const outcome = await eraseAuditRows(
      eraseInput({ retentionClass: "compliance_42cfr_part2", patientId: "pt_1" }),
      ports,
    );
    expect(outcome).toEqual({ kind: "erased", rowsErased: 1 });
    expect(erasedCalls()).toBe(1);
  });

  it("refuses a Part 2 row that resolves to no patient (defensive)", async () => {
    const { ports } = createInMemoryEraserPorts();
    const outcome = await eraseAuditRows(
      eraseInput({ retentionClass: "compliance_42cfr_part2" }),
      ports,
    );
    expect(outcome).toEqual({ kind: "refused_part_two_retention", reason: "patient_alive" });
  });

  it("refuses ANY row under an active legal hold — the hold wins over the certificate (§10.6)", async () => {
    const { ports, erasedCalls } = createInMemoryEraserPorts({
      legalHolds: { evt_held: "hold_42" },
    });
    const outcome = await eraseAuditRows(
      eraseInput({ resourceId: "evt_held", retentionClass: "compliance" }),
      ports,
    );
    expect(outcome).toEqual({ kind: "refused_legal_hold", legalHoldId: "hold_42" });
    expect(erasedCalls()).toBe(0);
  });

  it("legal hold beats Part 2 — a held Part 2 row reports the hold, not the lifetime refusal", async () => {
    const { ports } = createInMemoryEraserPorts({
      legalHolds: { evt_1: "hold_7" },
      patients: { pt_1: { status: "active" } },
    });
    const outcome = await eraseAuditRows(
      eraseInput({ retentionClass: "compliance_42cfr_part2", patientId: "pt_1" }),
      ports,
    );
    expect(outcome).toEqual({ kind: "refused_legal_hold", legalHoldId: "hold_7" });
  });

  it("never erases a legal_hold-classed row (§10.5 nothing in legal_hold is touched)", async () => {
    const { ports, erasedCalls } = createInMemoryEraserPorts();
    const outcome = await eraseAuditRows(eraseInput({ retentionClass: "legal_hold" }), ports);
    expect(outcome).toEqual({ kind: "refused_class_not_eligible", class: "legal_hold" });
    expect(erasedCalls()).toBe(0);
  });

  it("erases an ordinary operational/compliance row", async () => {
    const { ports, erasedCalls } = createInMemoryEraserPorts({ rowsPerErase: 3 });
    const outcome = await eraseAuditRows(eraseInput({ retentionClass: "operational" }), ports);
    expect(outcome).toEqual({ kind: "erased", rowsErased: 3 });
    expect(erasedCalls()).toBe(1);
  });
});

describe("runDestruction — W-M4-09 destruction certificate workflow (§6, §10.5)", () => {
  it("erases non-Part-2 rows but refuses the live-patient Part 2 row → partial_refused", async () => {
    const { ports } = createInMemoryEraserPorts({ patients: { pt_alive: { status: "active" } } });
    const result = await runDestruction(
      {
        certificateId: "cert_9",
        dataClass: "audit_event",
        organizationId: ORG,
        rows: [
          eraseInput({ resourceId: "evt_a", retentionClass: "compliance" }),
          eraseInput({ resourceId: "evt_b", retentionClass: "operational" }),
          eraseInput({
            resourceId: "evt_sud",
            retentionClass: "compliance_42cfr_part2",
            patientId: "pt_alive",
          }),
        ],
      },
      ports,
    );

    expect(result.status).toBe("partial_refused");
    expect(result.rowsErased).toBe(2); // the two non-Part-2 rows ARE erased
    expect(result.refusedPartTwo).toBe(1);

    // A Part 2 refusal is recorded at the Part 2 class; the partial run is still certified.
    const refusal = result.auditEvents.find(
      (e) => e.action === "audit.destruction_refused_part_two",
    );
    expect(refusal?.retentionClass).toBe("compliance_42cfr_part2");
    expect(refusal?.payload.refusedCount).toBe(1);
    const certified = result.auditEvents.find((e) => e.action === "data.destruction_certified");
    expect(certified?.payload).toMatchObject({ rowsErased: 2, status: "partial_refused" });
  });

  it("erases a clean batch and emits data.destruction_certified → executed", async () => {
    const { ports } = createInMemoryEraserPorts();
    const result = await runDestruction(
      {
        certificateId: "cert_ok",
        dataClass: "audit_event",
        organizationId: ORG,
        rows: [
          eraseInput({ resourceId: "evt_a", retentionClass: "compliance" }),
          eraseInput({ resourceId: "evt_b", retentionClass: "operational" }),
        ],
      },
      ports,
    );

    expect(result.status).toBe("executed");
    expect(result.rowsErased).toBe(2);
    expect(result.refusedPartTwo).toBe(0);
    expect(result.auditEvents.map((e) => e.action)).toEqual(["data.destruction_certified"]);
  });

  it("a fully legal-held batch lands `held` and certifies nothing", async () => {
    const { ports } = createInMemoryEraserPorts({
      legalHolds: { evt_a: "hold_1", evt_b: "hold_1" },
    });
    const result = await runDestruction(
      {
        certificateId: "cert_held",
        dataClass: "audit_event",
        organizationId: ORG,
        rows: [
          eraseInput({ resourceId: "evt_a" }),
          eraseInput({ resourceId: "evt_b" }),
        ],
      },
      ports,
    );

    expect(result.status).toBe("held");
    expect(result.rowsErased).toBe(0);
    expect(result.refusedLegalHold).toBe(2);
    expect(result.auditEvents).toEqual([]); // nothing erased ⇒ no certification event
  });
});
