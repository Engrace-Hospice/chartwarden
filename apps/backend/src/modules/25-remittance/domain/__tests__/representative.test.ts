// M25 milestone 13a - the appointment-of-representative pure rules. Record-keeping only: every date is typed, nothing is
// computed from a period, and no CMS form, element list or validity period appears here (the element labels below are
// made-up fixtures).
import { describe, expect, it } from "vitest";
import {
  REPRESENTATIVE_KINDS,
  appointmentStatus,
  checkActivation,
  checkAppointmentDraft,
  checkFormVersionInput,
  checkRevocation,
  confirmElements,
  snapshotElements,
} from "../representative";

const TODAY = "2026-06-15";
const draft = (over: Record<string, unknown> = {}) => ({
  instrumentKind: "org_form" as const,
  formVersionId: "11111111-1111-1111-1111-111111111111",
  instrumentNote: null,
  representativeName: "Fixture Person",
  relationshipLabel: "daughter",
  representativeKind: "family_or_friend" as const,
  beneficiarySignedOn: "2026-06-01",
  representativeSignedOn: "2026-06-02",
  validThroughOn: null,
  validitySourceNote: null,
  ...over,
});

describe("representative kinds", () => {
  it("has no hospice_staff kind: staff may assist but never act as the representative", () => {
    expect([...REPRESENTATIVE_KINDS]).toEqual([
      "family_or_friend",
      "legal_representative",
      "attorney",
      "other",
    ]);
    expect(checkAppointmentDraft(draft({ representativeKind: "hospice_staff" }), TODAY)).toBe(
      "KIND_INVALID",
    );
  });
});

describe("checkAppointmentDraft", () => {
  it("accepts a complete org-form draft", () => {
    expect(checkAppointmentDraft(draft(), TODAY)).toBeNull();
  });
  it("requires a form version for org_form and forbids one otherwise", () => {
    expect(checkAppointmentDraft(draft({ formVersionId: null }), TODAY)).toBe(
      "FORM_VERSION_REQUIRED",
    );
    expect(
      checkAppointmentDraft(
        draft({ instrumentKind: "other_written_instrument", instrumentNote: "letter" }),
        TODAY,
      ),
    ).toBe("FORM_VERSION_NOT_ALLOWED");
  });
  it("requires a note for another written instrument", () => {
    expect(
      checkAppointmentDraft(
        draft({ instrumentKind: "other_written_instrument", formVersionId: null }),
        TODAY,
      ),
    ).toBe("INSTRUMENT_NOTE_REQUIRED");
    expect(
      checkAppointmentDraft(
        draft({
          instrumentKind: "other_written_instrument",
          formVersionId: null,
          instrumentNote: "signed letter",
        }),
        TODAY,
      ),
    ).toBeNull();
  });
  it("requires a name, and a label when the kind is other", () => {
    expect(checkAppointmentDraft(draft({ representativeName: "  " }), TODAY)).toBe("NAME_REQUIRED");
    expect(
      checkAppointmentDraft(draft({ representativeKind: "other", relationshipLabel: null }), TODAY),
    ).toBe("LABEL_REQUIRED_FOR_OTHER");
  });
  it("refuses a signature date that is not real or is in the future", () => {
    expect(checkAppointmentDraft(draft({ beneficiarySignedOn: "2026-02-30" }), TODAY)).toBe(
      "DATE_INVALID",
    );
    expect(checkAppointmentDraft(draft({ representativeSignedOn: "2026-06-16" }), TODAY)).toBe(
      "DATE_IN_FUTURE",
    );
  });
  it("takes the validity end only as a typed date WITH its source note, or neither", () => {
    expect(checkAppointmentDraft(draft({ validThroughOn: "2027-01-01" }), TODAY)).toBe(
      "VALIDITY_PAIR_REQUIRED",
    );
    expect(checkAppointmentDraft(draft({ validitySourceNote: "form p.2" }), TODAY)).toBe(
      "VALIDITY_PAIR_REQUIRED",
    );
    expect(
      checkAppointmentDraft(
        draft({ validThroughOn: "2027-01-01", validitySourceNote: "form p.2" }),
        TODAY,
      ),
    ).toBeNull();
    // a validity end already in the past is allowed to be recorded (it is what the paper says); it is flagged on read
    expect(
      checkAppointmentDraft(
        draft({ validThroughOn: "2026-01-01", validitySourceNote: "form p.2" }),
        TODAY,
      ),
    ).toBeNull();
  });
  it("rejects a Medicare number typed into any free-text field (never stored)", () => {
    const mbi = "1EG4-TE5-MK73";
    for (const field of [
      "representativeName",
      "relationshipLabel",
      "instrumentNote",
      "validitySourceNote",
    ]) {
      expect(
        checkAppointmentDraft(
          draft({
            validThroughOn: "2027-01-01",
            validitySourceNote: "form",
            [field]: `see ${mbi}`,
          }),
          TODAY,
        ),
      ).toBe("MBI_IN_FREE_TEXT");
    }
  });
  it("bounds text length", () => {
    expect(checkAppointmentDraft(draft({ representativeName: "x".repeat(201) }), TODAY)).toBe(
      "TEXT_TOO_LONG",
    );
  });
});

describe("checkFormVersionInput", () => {
  const form = (over: Record<string, unknown> = {}) => ({
    label: "Org form A",
    formIdentifier: "as entered",
    editionText: "as entered",
    sourceNote: "compliance binder p.3",
    verifiedOn: "2026-06-01",
    requiredElements: ["element one", "element two"],
    ...over,
  });
  it("accepts a version with a source note and labelled elements", () => {
    expect(checkFormVersionInput(form(), TODAY)).toBeNull();
  });
  it("requires a label and a source note: an untraceable form version is not recorded", () => {
    expect(checkFormVersionInput(form({ label: " " }), TODAY)).toBe("LABEL_REQUIRED");
    expect(checkFormVersionInput(form({ sourceNote: "" }), TODAY)).toBe("SOURCE_NOTE_REQUIRED");
  });
  it("refuses blank or duplicate elements and too many of them", () => {
    expect(checkFormVersionInput(form({ requiredElements: ["a", " "] }), TODAY)).toBe(
      "ELEMENT_BLANK",
    );
    expect(checkFormVersionInput(form({ requiredElements: ["a", "A"] }), TODAY)).toBe(
      "ELEMENT_DUPLICATE",
    );
    expect(
      checkFormVersionInput(
        form({ requiredElements: Array.from({ length: 31 }, (_, i) => `e${i}`) }),
        TODAY,
      ),
    ).toBe("ELEMENTS_TOO_MANY");
  });
  it("a verified-on date must be real and not in the future", () => {
    expect(checkFormVersionInput(form({ verifiedOn: "2026-13-01" }), TODAY)).toBe(
      "VERIFIED_ON_INVALID",
    );
    expect(checkFormVersionInput(form({ verifiedOn: "2026-06-16" }), TODAY)).toBe(
      "VERIFIED_ON_INVALID",
    );
  });
});

describe("element checklist", () => {
  it("snapshots every configured label as missing and ticks only known labels", () => {
    const snap = snapshotElements(["a", "b"]);
    expect(snap).toEqual([
      { label: "a", state: "missing" },
      { label: "b", state: "missing" },
    ]);
    const ticked = confirmElements(snap, ["b"]);
    expect(ticked).toEqual({
      ok: true,
      elements: [
        { label: "a", state: "missing" },
        { label: "b", state: "confirmed" },
      ],
    });
    expect(snap[1]?.state).toBe("missing"); // immutable: the input is not changed
    expect(confirmElements(snap, ["zzz"])).toEqual({ ok: false, unknown: "zzz" });
  });
});

describe("checkActivation (second person, document, elements)", () => {
  const base = {
    state: "draft",
    recordedBy: "m1",
    activator: "m2",
    hasDocument: true,
    elements: [{ label: "a", state: "confirmed" as const }],
  };
  it("accepts a different person with a document and every element confirmed", () => {
    expect(checkActivation(base)).toBeNull();
  });
  it("refuses the recorder as the activator", () => {
    expect(checkActivation({ ...base, activator: "m1" })).toBe("ACTIVATOR_IS_RECORDER");
  });
  it("refuses activation without a signed document", () => {
    expect(checkActivation({ ...base, hasDocument: false })).toBe("NO_DOCUMENT");
  });
  it("refuses activation with a missing element", () => {
    expect(
      checkActivation({
        ...base,
        elements: [
          { label: "a", state: "confirmed" },
          { label: "b", state: "missing" },
        ],
      }),
    ).toBe("ELEMENTS_INCOMPLETE");
  });
  it("refuses anything but a draft", () => {
    expect(checkActivation({ ...base, state: "active" })).toBe("NOT_DRAFT");
  });
});

describe("checkRevocation", () => {
  it("needs a typed real day that is not in the future, and a note", () => {
    const ok = { state: "active", revokedOn: "2026-06-10", note: "revoked by letter" };
    expect(checkRevocation(ok, TODAY)).toBeNull();
    expect(checkRevocation({ ...ok, revokedOn: "2026-06-16" }, TODAY)).toBe("REVOKED_ON_INVALID");
    expect(checkRevocation({ ...ok, note: " " }, TODAY)).toBe("NOTE_REQUIRED");
    expect(checkRevocation({ ...ok, note: "1EG4-TE5-MK73" }, TODAY)).toBe("MBI_IN_FREE_TEXT");
  });
  it("revokes a draft (discard) or an active appointment, never a revoked one", () => {
    const base = { revokedOn: "2026-06-10", note: "n" };
    expect(checkRevocation({ ...base, state: "draft" }, TODAY)).toBeNull();
    expect(checkRevocation({ ...base, state: "revoked" }, TODAY)).toBe("NOT_REVOCABLE");
  });
});

describe("appointmentStatus: derived from typed dates only, never changes state", () => {
  it("reports a passed typed validity end as recorded and does not alter the state", () => {
    const a = { state: "active", validThroughOn: "2026-06-01" };
    expect(appointmentStatus(a, TODAY)).toBe("validity_end_passed_as_recorded");
    expect(a.state).toBe("active");
  });
  it("is active when the end is today, in the future, or not recorded", () => {
    expect(appointmentStatus({ state: "active", validThroughOn: TODAY }, TODAY)).toBe("active");
    expect(appointmentStatus({ state: "active", validThroughOn: "2027-01-01" }, TODAY)).toBe(
      "active",
    );
    expect(appointmentStatus({ state: "active", validThroughOn: null }, TODAY)).toBe("active");
  });
  it("passes draft, revoked and superseded through", () => {
    expect(appointmentStatus({ state: "draft", validThroughOn: "2020-01-01" }, TODAY)).toBe(
      "draft",
    );
    expect(appointmentStatus({ state: "revoked", validThroughOn: null }, TODAY)).toBe("revoked");
    expect(appointmentStatus({ state: "superseded", validThroughOn: null }, TODAY)).toBe(
      "superseded",
    );
  });
});
