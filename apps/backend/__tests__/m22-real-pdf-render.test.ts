// apps/backend/__tests__/m22-real-pdf-render.test.ts — M22 real PDF rendering for the M14 templates
// (`idg_minutes`, `idg_patient_packet`): pure layout-builder tests + golden-ish tests that PARSE the produced
// PDF bytes (structure, xref offsets, page count, extracted text, determinism, Part 2 elision by ABSENCE of
// the secret strings, glyph sanitising, pagination).
import { describe, expect, it } from "vitest";
import {
  buildIdgMinutesDoc,
  buildIdgPacketDoc,
  layoutDocument,
  renderDocModelToPdf,
  renderRegisteredPdf,
} from "../src/modules/22-documents/render-pdf";
import { wrapText } from "../src/modules/22-documents/render-pdf/text";
import { createDocumentRenderer } from "../src/modules/22-documents/seams/renderer";

// ── a tiny PDF reader, enough to prove validity and pull the drawn text back out ──────────────────────
function parsePdf(bytes: Uint8Array): { text: string[]; pages: number; raw: string } {
  const raw = Buffer.from(bytes).toString("latin1");
  expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
  expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
  // xref: every entry's offset must land on "<n> 0 obj".
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(raw)?.[1]);
  expect(raw.slice(startxref, startxref + 4)).toBe("xref");
  const [, header, ...rest] = raw.slice(startxref).split("\n");
  const size = Number(header?.split(" ")[1]);
  const entries = rest.slice(1, size); // skip the free entry
  expect(entries).toHaveLength(size - 1);
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    expect(raw.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
  // every stream's /Length is exact
  for (const m of raw.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
    expect((m[2] as string).length).toBe(Number(m[1]));
  }
  const pages = Number(/\/Type \/Pages \/Count (\d+)/.exec(raw)?.[1]);
  expect((raw.match(/\/Type \/Page /g) ?? []).length).toBe(pages);
  const text: string[] = [];
  for (const m of raw.matchAll(/\((?:\\.|[^\\)])*\) Tj/g)) {
    const inner = m[0].slice(1, -4);
    text.push(
      inner
        .replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)))
        .replace(/\\(.)/g, "$1")
        .replace(/\u0097/g, "\u2014"), // WinAnsi 0x97 = em dash
    );
  }
  return { text, pages, raw };
}
const allText = (b: Uint8Array): string => parsePdf(b).text.join("\n");

const SECRET_BODY = "SUD-SECRET-BODY-xyzzy";
const SECRET_REASON = "SUD-SECRET-REASON-plugh";
const SECRET_PATIENT = "e2222222-2222-4222-8222-222222222222";

const minutesPayload = {
  meeting: {
    meetingId: "aaaaaaaa-0000-4000-8000-000000000001",
    organizationName: "Sunrise Hospice",
    locationName: "North Campus",
    scheduledStart: "2026-09-29T14:00:00.000Z",
    actualStart: "2026-09-29T14:02:00.000Z",
    actualEnd: "2026-09-29T15:10:00.000Z",
  },
  memberNames: { m1: "Dana Reyes", m2: "Lee Park" },
  patientLabels: { p1: "Maria G." },
  attendanceSnapshot: [
    {
      membershipId: "m1",
      discipline: "rn",
      status: "present",
      checkInAt: "2026-09-29T14:01:00.000Z",
    },
    {
      membershipId: "m2",
      discipline: "msw",
      status: "tardy",
      checkInAt: "2026-09-29T14:20:00.000Z",
    },
  ],
  decisionListSnapshot: [
    {
      decisionId: "d1",
      patientId: "p1",
      decisionKind: "level_of_care_change",
      status: "recorded",
      wasQuorate: true,
      recordedAt: "2026-09-29T14:40:00.000Z",
      supersededByDecisionId: null,
    },
  ],
  actionItemListSnapshot: [
    {
      actionItemId: "a1",
      decisionId: "d1",
      patientId: "p1",
      assignedToMembershipId: "m1",
      assignedToDiscipline: "rn",
      status: "open",
      dueDate: "2026-10-02T00:00:00.000Z",
    },
  ],
  disciplineNoteSnapshot: [
    {
      noteId: "n1",
      patientId: "p1",
      discipline: "rn",
      bodyText: "Pain controlled on current regimen.",
      bodyWithheld: false,
      reason: null,
      authorMembershipId: "m1",
      version: 1,
      createdAt: "2026-09-29T14:30:00.000Z",
      updatedAt: "2026-09-29T14:30:00.000Z",
    },
    {
      noteId: "n2",
      patientId: SECRET_PATIENT,
      discipline: "msw",
      bodyText: SECRET_BODY, // a producer bug leaving text on a withheld entry must still not print
      bodyWithheld: true,
      reason: SECRET_REASON,
      authorMembershipId: "m2",
      version: 1,
      createdAt: "2026-09-29T14:35:00.000Z",
      updatedAt: "2026-09-29T14:35:00.000Z",
    },
  ],
  disciplineAddenda: [
    {
      noteId: "ad1",
      patientId: "p1",
      discipline: "rn",
      authorMembershipId: "m1",
      authorName: "Dana Reyes",
      recordedAt: "2026-09-30T09:00:00.000Z",
      reason: "Missed dose confirmed after the meeting",
      bodyText: "Addendum: dose was given at 13:50.",
      bodyWithheld: false,
    },
    {
      noteId: "ad2",
      patientId: SECRET_PATIENT,
      discipline: "msw",
      authorMembershipId: "m2",
      recordedAt: "2026-09-30T09:30:00.000Z",
      reason: SECRET_REASON,
      bodyText: SECRET_BODY,
      bodyWithheld: true,
    },
  ],
};

describe("idg_minutes doc model (pure)", () => {
  it("has the sections in order, Final status, no amendment banner", () => {
    const doc = buildIdgMinutesDoc(minutesPayload);
    const headings = doc.blocks.flatMap((b) => (b.kind === "heading" ? [b.text] : []));
    expect(headings.slice(0, 4)).toEqual([
      "Attendance",
      "Decisions",
      "Action items",
      "Discipline notes",
    ]);
    expect(headings).toContain("Appendix: Addenda");
    const facts = doc.blocks.find((b) => b.kind === "facts");
    expect(facts && facts.kind === "facts" && facts.rows.find((r) => r[0] === "Status")?.[1]).toBe(
      "Final",
    );
    expect(doc.blocks.some((b) => b.kind === "banner" && b.text.startsWith("AMENDED"))).toBe(false);
  });

  it("marks amended minutes and derives the creation date from the payload", () => {
    const doc = buildIdgMinutesDoc({
      ...minutesPayload,
      minutesStatus: "amended",
      amendmentCount: 1,
    });
    expect(doc.blocks.some((b) => b.kind === "banner" && b.text.startsWith("AMENDED"))).toBe(true);
    expect(doc.createdAtIso).toBe("2026-09-30T09:30:00.000Z");
  });

  it("never carries withheld text, reason or patient identity into the model", () => {
    const json = JSON.stringify(buildIdgMinutesDoc(minutesPayload));
    for (const secret of [SECRET_BODY, SECRET_REASON, SECRET_PATIENT])
      expect(json).not.toContain(secret);
    expect(json).toContain("Withheld \\u2014 42 CFR Part 2".replace("\\u2014", "—"));
  });

  it("degrades on an empty / malformed payload instead of throwing", () => {
    for (const bad of [
      undefined,
      null,
      {},
      { attendanceSnapshot: "x", disciplineAddenda: [1, null] },
    ]) {
      expect(() => buildIdgMinutesDoc(bad)).not.toThrow();
    }
  });
});

describe("idg_minutes PDF bytes", () => {
  const bytes = renderRegisteredPdf("idg_minutes", minutesPayload) as Uint8Array;

  it("is a structurally valid PDF whose text round-trips", () => {
    const { pages, text } = parsePdf(bytes);
    expect(pages).toBeGreaterThanOrEqual(2); // the appendix starts on its own page
    const all = text.join("\n");
    for (const s of [
      "Interdisciplinary Group (IDG) Meeting Minutes",
      "Sunrise Hospice - North Campus",
      "2026-09-29",
      "Final",
      "Dana Reyes",
      "Lee Park",
      "Registered Nurse (RN)",
      "Level of Care Change",
      "Maria G.",
      "Pain controlled on current regimen.",
      "Appendix: Addenda",
      "Reason: Missed dose confirmed after the meeting",
      "Addendum: dose was given at 13:50.",
      "Withheld — 42 CFR Part 2",
    ]) {
      expect(all, s).toContain(s);
    }
    expect(all).toMatch(/Page 1 of \d+/);
  });

  it("proves Part 2 elision by absence of the secrets anywhere in the file", () => {
    const raw = Buffer.from(bytes).toString("latin1");
    for (const secret of [SECRET_BODY, SECRET_REASON, SECRET_PATIENT, "SECRET"]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("is byte-deterministic and carries the payload-derived date, no wall clock", () => {
    const again = renderRegisteredPdf("idg_minutes", structuredClone(minutesPayload)) as Uint8Array;
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
    expect(parsePdf(bytes).raw).toContain("/CreationDate (D:20260930093000Z)");
  });

  it("shows the amendment banner and Amended status when amended", () => {
    const t = allText(
      renderRegisteredPdf("idg_minutes", {
        ...minutesPayload,
        minutesStatus: "amended",
      }) as Uint8Array,
    );
    expect(t).toContain("Amended");
    expect(t).toContain("AMENDED - these minutes were amended");
  });

  it("omits the appendix when there are no addenda", () => {
    const t = allText(
      renderRegisteredPdf("idg_minutes", {
        ...minutesPayload,
        disciplineAddenda: [],
      }) as Uint8Array,
    );
    expect(t).not.toContain("Appendix: Addenda");
  });

  it("wraps and paginates long text; sanitises non-Latin glyphs without crashing", () => {
    const long = `${"word ".repeat(1500)}${"U".repeat(400)} 日本語 café — “quoted”`;
    const big = {
      ...minutesPayload,
      disciplineAddenda: Array.from({ length: 12 }, (_, i) => ({
        ...minutesPayload.disciplineAddenda[0],
        noteId: `x${i}`,
        bodyText: long,
      })),
    };
    const out = renderRegisteredPdf("idg_minutes", big) as Uint8Array;
    const { pages, text } = parsePdf(out);
    expect(pages).toBeGreaterThan(5);
    const all = text.join("\n");
    expect(all).toContain("café");
    expect(all).toContain("???"); // CJK -> "?" (visible degradation)
    expect(all).not.toContain("日");
    // no line overflows the text column
    for (const page of layoutDocument(buildIdgMinutesDoc(big)))
      for (const op of page.ops) if (op.op === "text") expect(op.x).toBeLessThan(612);
  });

  it("paginates a large attendance table with a repeated header", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      membershipId: `m${i}`,
      discipline: "rn",
      status: "present",
      checkInAt: "2026-09-29T14:01:00.000Z",
    }));
    const out = renderRegisteredPdf("idg_minutes", {
      ...minutesPayload,
      attendanceSnapshot: many,
    }) as Uint8Array;
    const { text, pages } = parsePdf(out);
    expect(pages).toBeGreaterThan(3);
    expect(text.filter((s) => s === "Discipline").length).toBeGreaterThanOrEqual(3);
  });
});

const packetPayload = {
  snapshot: {
    schemaVersion: "2026-01-v1",
    meta: {
      builtAt: "2026-09-28T14:00:00.000Z",
      sinceCursorIso: "2026-09-21T14:00:00.000Z",
      sinceContext: "prior_idg",
      appliedSudRedaction: true,
    },
    patientCover: {
      fullNameRedacted: "Maria G.",
      age: 81,
      primaryDiagnosisIcd10: "C34.90",
      primaryDiagnosisLabel: "Lung cancer",
      daysOnService: 42,
      levelOfCare: "routine_home_care",
      nextRecertDueAt: "2026-11-01T00:00:00.000Z",
      f2fWindowState: "window_open",
      activeDpoa: null,
      activeSudFlag: true,
    },
    sinceLastIdg: {
      encounters: [
        {
          encounterId: "e",
          encounterType: "routine_visit",
          signedAt: "2026-09-25T10:00:00.000Z",
          authorDiscipline: "rn",
        },
      ],
      significantAssessmentChanges: [],
      j2051Triggers: [
        {
          hopeAssessmentId: "h",
          triggerKind: "symptom_impact",
          firedAt: "2026-09-26T10:00:00.000Z",
        },
      ],
      ordersChanged: [],
      medicationsChanged: [
        {
          medicationOrderId: "o",
          drugLabel: "Morphine 5 mg",
          changeKind: "dose_change",
          changedAt: "2026-09-27T10:00:00.000Z",
        },
      ],
      flaggedEvents: [
        { kind: "fall", sourceId: "s", occurredAt: "2026-09-24T10:00:00.000Z", severity: "urgent" },
      ],
    },
    carePlanSummary: {
      activeProblemCount: 3,
      activeGoalCount: 4,
      activeInterventionCount: 9,
      lastSignedAt: "2026-09-20T10:00:00.000Z",
      nextReviewDueAt: "2026-10-05T10:00:00.000Z",
      isReviewOverdue: false,
    },
    hopeContext: {
      upcomingTimepoints: [{ timepoint: "hope_a_within_7d", dueAt: "2026-10-01T00:00:00.000Z" }],
      openSfvCount: 1,
    },
    carryForwardActionItems: [
      {
        actionItemId: "act12345-x",
        assignedToMembershipId: "m1",
        dueDate: "2026-09-20T00:00:00.000Z",
        carryForwardCount: 2,
      },
    ],
    flagsForDiscussion: [{ kind: "recert_due", detail: "Recert due in 33 days" }],
  },
  disciplineViews: {
    rn: {
      oneLineSummary: "Stable; one fall.",
      highlightedEntries: [
        {
          sourceKind: "flag",
          sourceId: "s",
          label: "Fall",
          summary: "Fall in bathroom",
          severity: "urgent",
        },
      ],
      openQuestions: ["Home safety eval?"],
      layer2Polished: null,
    },
    msw: {
      oneLineSummary: "Family coping well.",
      highlightedEntries: [],
      openQuestions: [],
      layer2Polished: null,
    },
  },
  memberNames: { m1: "Dana Reyes" },
};

describe("idg_patient_packet PDF bytes", () => {
  const bytes = renderRegisteredPdf("idg_patient_packet", packetPayload) as Uint8Array;
  it("is valid and contains cover, discipline sections, change tables, HOPE, carry-forward, Part 2 notice", () => {
    const all = allText(bytes);
    for (const s of [
      "IDG Patient Packet",
      "Maria G.",
      "C34.90 - Lung cancer",
      "Routine Home Care",
      "Cover summary",
      "Registered Nurse (RN)",
      "Social Work (MSW)",
      "Stable; one fall.",
      "Home safety eval?",
      "Signed encounters",
      "Morphine 5 mg",
      "Fall",
      "HOPE assessment context",
      "HOPE A Within 7d",
      "Carry-forward action items",
      "Dana Reyes",
      "Recert Due: Recert due in 33 days",
      "42 CFR Part 2: substance use disorder (SUD) treatment content",
      "42 CFR Part 2 notice",
    ])
      expect(all, s).toContain(s);
  });
  it("omits the Part 2 notice for a non-SUD packet and is deterministic", () => {
    const clean = structuredClone(packetPayload);
    clean.snapshot.meta.appliedSudRedaction = false;
    clean.snapshot.patientCover.activeSudFlag = false;
    const t = allText(renderRegisteredPdf("idg_patient_packet", clean) as Uint8Array);
    expect(t).not.toContain("42 CFR Part 2");
    expect(
      Buffer.from(renderRegisteredPdf("idg_patient_packet", packetPayload) as Uint8Array).equals(
        Buffer.from(bytes),
      ),
    ).toBe(true);
    expect(() => buildIdgPacketDoc({})).not.toThrow();
  });
  it("prints HOPE 'not captured' when the context is null", () => {
    const p = structuredClone(packetPayload) as Record<string, any>;
    p.snapshot.hopeContext = null;
    expect(allText(renderDocModelToPdf(buildIdgPacketDoc(p)))).toContain(
      "HOPE context was not captured",
    );
  });
});

describe("wrapText", () => {
  it("hard-breaks tokens wider than the column and honours newlines", () => {
    const lines = wrapText(`${"W".repeat(200)}\nsecond`, "F1", 10, 100);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[lines.length - 1]).toBe("second");
  });
});

describe("renderer registry wiring", () => {
  const store = {
    async upsertRenderedDocument(u: Record<string, unknown>) {
      captured.push(u);
      return { documentId: "doc-1" };
    },
  };
  const captured: Array<Record<string, unknown>> = [];
  const written: Array<{ objectKey: string; bytes: Uint8Array }> = [];
  const objects = {
    async putObject(a: { objectKey: string; bytes: Uint8Array }) {
      written.push(a);
      return { sha256Hex: "00" };
    },
  };
  const make = (extra = {}) =>
    createDocumentRenderer({
      store: store as never,
      objects: objects as never,
      now: () => "2026-09-30T00:00:00.000Z",
      shortId: () => "abcdef012345",
      ...extra,
    });
  it("real PDF for M14 templates, unchanged stand-in for every other template, PHI-free keys", async () => {
    await make().render({ orgId: "11111111-1111-4111-8111-111111111111" }, "idg_minutes", {
      ...minutesPayload,
      aggregateId: "min-1",
      patientId: null,
    });
    await make().render({ orgId: "11111111-1111-4111-8111-111111111111" }, "consent_record", {
      aggregateId: "c-1",
      patientId: null,
    });
    const [minutes, other] = written;
    expect(
      Buffer.from((minutes as { bytes: Uint8Array }).bytes)
        .toString("latin1")
        .startsWith("%PDF-1.4"),
    ).toBe(true);
    expect(Buffer.from((other as { bytes: Uint8Array }).bytes).toString("latin1")).toContain(
      "% wardenx-render",
    );
    expect((minutes as { objectKey: string }).objectKey).not.toContain("Sunrise");
    expect(captured[0]?.mimeType).toBe("application/pdf");
  });
  it("pdfRenderers: {} forces the stand-in", async () => {
    written.length = 0;
    await make({ pdfRenderers: {} }).render(
      { orgId: "11111111-1111-4111-8111-111111111111" },
      "idg_minutes",
      { aggregateId: "min-2", patientId: null },
    );
    expect(Buffer.from((written[0] as { bytes: Uint8Array }).bytes).toString("latin1")).toContain(
      "% wardenx-render",
    );
  });
});
