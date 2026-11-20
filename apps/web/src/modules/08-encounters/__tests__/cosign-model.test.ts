// The words and rules of working a cosignature request, for a note and for an amendment of a signed note (ADR-0114 VN-D30, S1 PR E4).
// The server decides every state and every refusal; these are the sentences and the gating the screens read off it. Synthetic data only.
import { describe, expect, it } from "vitest";
import type { Session } from "../../../shell/session";
import {
  amendmentCosignWords,
  cosignAbility,
  cosignActionsFor,
  cosignRequestWords,
  queueEntryHref,
  queueEntryKey,
  queueEntrySubject,
  queueEntrySubjectLabel,
} from "../cosign-model";

const session = (over: Partial<Session> = {}): Session => ({
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "mem-cosigner",
  permissions: ["encounter.cosign"],
  ...over,
});
const authors = { addendumAuthorId: "mem-addendum", noteAuthorId: "mem-note" };

// The server's §2.4 graph: a routed request is acknowledged, then signed; an escalated one can still be signed (the escalation alerts a
// supervisor, it does not lock); past the 48h cap only a release moves it, and a released one is then signed by the RN.
describe("which step a request status allows", () => {
  it.each([
    ["pending", { acknowledge: false, sign: false, release: false }],
    ["routed", { acknowledge: true, sign: false, release: false }],
    ["acknowledged", { acknowledge: false, sign: true, release: false }],
    ["escalated", { acknowledge: false, sign: true, release: false }],
    ["hard_cap_reached", { acknowledge: false, sign: false, release: true }],
    ["supervisor_released", { acknowledge: false, sign: true, release: false }],
    ["signed", { acknowledge: false, sign: false, release: false }],
  ] as const)("%s", (status, expected) => {
    expect(cosignActionsFor(status)).toEqual(expected);
  });

  it("allows nothing when there is no request or its state is unknown", () => {
    const none = { acknowledge: false, sign: false, release: false };
    expect(cosignActionsFor(null)).toEqual(none);
    expect(cosignActionsFor("surprise")).toEqual(none);
  });
});

describe("the amendment's cosignature in words", () => {
  it("says pending, cosigned and released", () => {
    expect(amendmentCosignWords("pending")).toBe("Pending cosignature");
    expect(amendmentCosignWords("cosigned")).toBe("Cosigned");
    expect(amendmentCosignWords("released")).toBe("Released by a supervisor");
  });

  it("says nothing when none was needed or the API sent none", () => {
    expect(amendmentCosignWords("not_required")).toBeNull();
    expect(amendmentCosignWords(null)).toBeNull();
    expect(amendmentCosignWords(undefined)).toBeNull();
  });
});

describe("where the request stands, for someone working it", () => {
  it("says what each state waits for", () => {
    expect(cosignRequestWords("routed")).toMatch(/acknowledge/i);
    expect(cosignRequestWords("acknowledged")).toMatch(/signature/i);
    expect(cosignRequestWords("escalated")).toMatch(/supervisor/i);
    expect(cosignRequestWords("hard_cap_reached")).toMatch(/release/i);
    expect(cosignRequestWords("supervisor_released")).toMatch(/still has to sign/i);
  });

  it("has nothing to say about a signed or unknown request", () => {
    expect(cosignRequestWords("signed")).toBeNull();
    expect(cosignRequestWords(null)).toBeNull();
  });
});

describe("who may act on an amendment's request", () => {
  it("lets an RN with cosign access who wrote neither the note nor the amendment acknowledge and sign", () => {
    const ability = cosignAbility(session(), authors);
    expect(ability.acknowledgeAndSign).toBe(true);
    expect(ability.refusal).toBeNull();
    expect(ability.release).toBe(false);
  });

  it("refuses the amendment's own author, in words, naming who can", () => {
    const ability = cosignAbility(session({ membershipId: "mem-addendum" }), authors);
    expect(ability.acknowledgeAndSign).toBe(false);
    expect(ability.refusal).toMatch(/you wrote this amendment/i);
    expect(ability.refusal).toMatch(/another rn|an rn who wrote neither/i);
  });

  it("refuses the note's author too, in words", () => {
    const ability = cosignAbility(session({ membershipId: "mem-note" }), authors);
    expect(ability.acknowledgeAndSign).toBe(false);
    expect(ability.refusal).toMatch(/you wrote the note/i);
  });

  it("refuses a viewer without cosign access, in words", () => {
    const ability = cosignAbility(session({ permissions: ["encounter.read"] }), authors);
    expect(ability.acknowledgeAndSign).toBe(false);
    expect(ability.refusal).toMatch(/your role cannot cosign/i);
  });

  it("lets a supervisor release without being the cosigner", () => {
    const ability = cosignAbility(
      session({ permissions: ["encounter.cosign_supervisor_release"] }),
      authors,
    );
    expect(ability.release).toBe(true);
    expect(ability.acknowledgeAndSign).toBe(false);
  });

  it("still allows the author to release, because the server holds no author rule there", () => {
    const ability = cosignAbility(
      session({
        membershipId: "mem-addendum",
        permissions: ["encounter.cosign", "encounter.cosign_supervisor_release"],
      }),
      authors,
    );
    expect(ability.release).toBe(true);
    expect(ability.acknowledgeAndSign).toBe(false);
  });

  it("fails closed with nothing to say when the session or its permissions are unknown", () => {
    for (const unknown of [null, session({ permissions: undefined })]) {
      const ability = cosignAbility(unknown, authors);
      expect(ability).toEqual({ acknowledgeAndSign: false, release: false, refusal: null });
    }
  });

  it("does not refuse on a note author it was never told", () => {
    const ability = cosignAbility(session({ membershipId: "mem-note" }), {
      addendumAuthorId: "mem-addendum",
      noteAuthorId: null,
    });
    expect(ability.acknowledgeAndSign).toBe(true);
  });
});

const entry = {
  id: "enc-1",
  patientId: "patient-1",
};

describe("a queue entry", () => {
  it("is a note when the API sent no cosign (an older server) or says so", () => {
    expect(queueEntrySubject(entry)).toBe("note");
    expect(
      queueEntrySubject({
        ...entry,
        cosign: {
          subject: "note",
          addendumId: null,
          requestId: null,
          status: null,
          routedAt: null,
        },
      }),
    ).toBe("note");
  });

  it("is an amendment when it names one", () => {
    const amendment = {
      ...entry,
      cosign: {
        subject: "addendum",
        addendumId: "add-1",
        requestId: "req-1",
        status: "routed",
        routedAt: "2026-11-01T10:00:00Z",
      },
    } as const;
    expect(queueEntrySubject(amendment)).toBe("addendum");
    expect(queueEntrySubjectLabel(amendment)).toBe("Amendment");
    expect(queueEntrySubjectLabel(entry)).toBe("Note");
  });

  it("is keyed by subject and id, so a note and an amendment of one encounter never share a key", () => {
    const amendment = {
      ...entry,
      cosign: {
        subject: "addendum",
        addendumId: "add-1",
        requestId: "req-1",
        status: "routed",
        routedAt: null,
      },
    } as const;
    expect(queueEntryKey(entry)).toBe("note:enc-1");
    expect(queueEntryKey(amendment)).toBe("addendum:add-1");
    expect(queueEntryKey(entry)).not.toBe(queueEntryKey(amendment));
  });

  it("opens the encounter, and for an amendment its cosign panel", () => {
    expect(queueEntryHref(entry)).toBe("/patients/patient-1/encounters/enc-1");
    expect(
      queueEntryHref({
        ...entry,
        cosign: {
          subject: "addendum",
          addendumId: "add-1",
          requestId: "req-1",
          status: "routed",
          routedAt: null,
        },
      }),
    ).toBe("/patients/patient-1/encounters/enc-1#addendum-cosign-add-1");
  });
});
