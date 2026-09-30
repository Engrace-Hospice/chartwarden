/**
 * F-218 / F-219 / F-224 (#248) — the pure halves of the three M19 triage pairs: the summary content
 * allowlist + the M22 PDF builders (A), the M19 → M37 worklist mapping and its unbound failure mode (C), and
 * the catalog moves from push to seam pull (B/C). The real Postgres / RLS / real-publisher proofs live in
 * `f218-f219-f224-m19-triage-pairs.live.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  SUMMARIZABLE_DISPOSITIONS,
  SUMMARY_READY_STATES,
  triageSummaryContent,
} from "../src/modules/19-oncall/clinical/triage-summary";
import { M19_OUTBOX_EVENTS } from "../src/modules/19-oncall/events-by-m19";
import { renderDocModelToPdf } from "../src/modules/22-documents/render-pdf/pdf-writer";
import {
  buildTriageSummaryAttendingDoc,
  buildTriageSummaryCaregiverDoc,
} from "../src/modules/22-documents/render-pdf/triage-summary-doc";
import { buildDrizzleIpuRouteService } from "../src/modules/37-ipu/routes/service-drizzle";

const FREE_TEXT = "PHI-FREE-TEXT-SENTINEL";

describe("F-224 — the triage summary content is an allowlist", () => {
  it("never carries a free-text field of ANY disposition arm", () => {
    const arms: Array<[Parameters<typeof triageSummaryContent>[0], Record<string, unknown>]> = [
      ["caregiver_education_only", { educationSummary: FREE_TEXT, followUpCallAt: null }],
      ["prn_intervention_authorized", { instructionsGiven: FREE_TEXT, medicationOrderId: "m" }],
      ["verbal_order_recorded", { orderRecordId: "o", attendingPhysicianId: "p" }],
      [
        "visit_dispatched_now",
        {
          requestedDiscipline: "rn",
          requestedArrivalBy: "2026-09-30T03:00:00Z",
          reason: FREE_TEXT,
        },
      ],
      [
        "visit_scheduled_first_light",
        { requestedDiscipline: "rn", proposedForDate: "2026-10-01", reason: FREE_TEXT },
      ],
      ["gip_admission_proposed", { gipCriteriaSummary: FREE_TEXT, preferredFacility: FREE_TEXT }],
      ["ed_transfer_acknowledged", { electionText: FREE_TEXT, transportArrangedBy: "family" }],
      [
        "pronouncement_scheduled",
        { pronouncingDiscipline: "rn", expectedArrivalBy: "2026-09-30T05:00:00Z" },
      ],
    ];
    for (const [disposition, data] of arms) {
      const content = triageSummaryContent(disposition, { disposition, ...data });
      expect(JSON.stringify(content)).not.toContain(FREE_TEXT);
      // Only the five allowlisted keys exist on the result, whatever the stored data carried.
      expect(Object.keys(content).sort()).toEqual([
        "disposition",
        "proposedForDate",
        "requestedArrivalBy",
        "requestedDiscipline",
        "transportArrangedBy",
      ]);
    }
  });

  it("projects the structured facts per disposition and normalises instants", () => {
    expect(
      triageSummaryContent("visit_dispatched_now", {
        requestedDiscipline: "rn",
        requestedArrivalBy: "2026-09-30T03:00:00Z",
      }),
    ).toMatchObject({ requestedDiscipline: "rn", requestedArrivalBy: "2026-09-30T03:00:00.000Z" });
    expect(
      triageSummaryContent("visit_scheduled_first_light", {
        requestedDiscipline: "msw",
        proposedForDate: "2026-10-01",
      }),
    ).toMatchObject({ requestedDiscipline: "msw", proposedForDate: "2026-10-01" });
    expect(
      triageSummaryContent("pronouncement_scheduled", {
        pronouncingDiscipline: "rn",
        expectedArrivalBy: null,
      }),
    ).toMatchObject({ requestedDiscipline: "rn", requestedArrivalBy: null });
  });

  it("drops a discipline 'token' that is really prose, a bad date and an unknown transport enum", () => {
    const c = triageSummaryContent("visit_dispatched_now", {
      requestedDiscipline: "Mrs Smith asked for the night nurse",
      requestedArrivalBy: "soon",
    });
    expect(c.requestedDiscipline).toBeNull();
    expect(c.requestedArrivalBy).toBeNull();
    expect(
      triageSummaryContent("ed_transfer_acknowledged", { transportArrangedBy: "uber" })
        .transportArrangedBy,
    ).toBeNull();
    expect(
      triageSummaryContent("visit_scheduled_first_light", { proposedForDate: "tomorrow" })
        .proposedForDate,
    ).toBeNull();
  });

  it("has no outcome to summarise for abandoned / escalated_unresolved, nor before a disposition exists", () => {
    expect(SUMMARIZABLE_DISPOSITIONS.has("abandoned")).toBe(false);
    expect(SUMMARIZABLE_DISPOSITIONS.has("escalated_unresolved")).toBe(false);
    expect(SUMMARIZABLE_DISPOSITIONS.size).toBe(8);
    for (const state of [
      "open",
      "protocol_in_progress",
      "awaiting_callback",
      "disposition_pending",
    ]) {
      expect(SUMMARY_READY_STATES.has(state)).toBe(false);
    }
    for (const state of ["documented_pending_encounter", "documented", "closed"]) {
      expect(SUMMARY_READY_STATES.has(state)).toBe(true);
    }
  });
});

describe("F-224 — the M22 summary PDFs", () => {
  const payload = {
    triageCallId: "3f0f3f0f-aaaa-bbbb-cccc-000000000001",
    callOpenedAt: "2026-09-30T01:15:00Z",
    occurredAt: "2026-09-30T02:00:00Z",
    requestedByMembershipId: "9a9a9a9a-aaaa-bbbb-cccc-000000000002",
    disposition: "visit_dispatched_now",
    requestedDiscipline: "rn",
    requestedArrivalBy: "2026-09-30T03:00:00Z",
    // A producer bug: free text and a SUD-class value leaked onto the wire. The builder must not read them.
    reason: FREE_TEXT,
    educationSummary: FREE_TEXT,
    medications: [{ name: "buprenorphine", isSudTreatment: true }],
  };
  const text = (doc: ReturnType<typeof buildTriageSummaryCaregiverDoc>) => JSON.stringify(doc);

  it("renders the caregiver variant from fixed lay text, with no internal ids and no leaked fields", () => {
    const doc = buildTriageSummaryCaregiverDoc(payload);
    const t = text(doc);
    expect(t).toContain("being sent to see the patient now");
    expect(t).not.toContain(FREE_TEXT);
    expect(t).not.toContain("buprenorphine");
    expect(t).not.toContain("3f0f3f0f"); // call id
    expect(t).not.toContain("9a9a9a9a"); // membership id
  });

  it("renders the attending variant with the call reference but still no leaked fields", () => {
    const doc = buildTriageSummaryAttendingDoc(payload);
    const t = text(doc);
    expect(t).toContain("3f0f3f0f");
    expect(t).toContain("Visit Dispatched Now");
    expect(t).not.toContain(FREE_TEXT);
    expect(t).not.toContain("buprenorphine");
  });

  it("produces real, byte-deterministic PDFs, and degrades (not throws) on an empty payload", () => {
    const a = renderDocModelToPdf(buildTriageSummaryCaregiverDoc(payload));
    const b = renderDocModelToPdf(buildTriageSummaryCaregiverDoc(payload));
    expect(Buffer.from(a).toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(() => renderDocModelToPdf(buildTriageSummaryCaregiverDoc({}))).not.toThrow();
    expect(() => renderDocModelToPdf(buildTriageSummaryAttendingDoc(null))).not.toThrow();
  });
});

describe("F-218 / F-219 — M14 and M37 pull, they are not outbox-push consumers", () => {
  const entry = (name: string) => M19_OUTBOX_EVENTS.find((e) => e.eventName === name);

  it("declares m14 / m37 as seam consumers and as NO push consumer (a push declaration with no binding defers every row forever)", () => {
    const care = entry("m19.triage_call.care_plan_change_indicated");
    const gip = entry("m19.triage_call.gip_admission_proposed");
    expect(care?.declaredConsumers).toEqual([]);
    expect(care?.seamConsumers).toEqual(["m14"]);
    expect(gip?.declaredConsumers).toEqual([]);
    expect(gip?.seamConsumers).toEqual(["m37"]);
  });

  it("the summary event declares m22 as its (bound) consumer and requires recipientKind", () => {
    const summary = entry("m19.triage.summary_requested");
    expect(summary?.declaredConsumers).toEqual(["m22"]);
    const required = (summary?.payloadSchema as { required?: string[] }).required ?? [];
    expect(required).toContain("recipientKind");
    expect(required).toContain("patientId");
  });
});

describe("F-219 — M37's worklist port", () => {
  const actor = { organizationId: "org-a", userId: "u", membershipId: "m", roles: [] } as never;

  it("maps the injected M19 read and passes ONLY the server-assembled org", async () => {
    const seen: string[] = [];
    const svc = buildDrizzleIpuRouteService({} as never, {
      gipProposals: {
        async proposalsForOrg(organizationId) {
          seen.push(organizationId);
          return [
            {
              triageCallId: "c1",
              patientId: "p1",
              admissionId: null,
              providerEntityId: "pe",
              locationId: null,
              proposedAt: "2026-09-30T02:00:00.000Z",
              preferredFacility: "Sunrise IPU",
              callState: "documented_pending_encounter",
              // a stray extra field from a bad reader must not reach the wire view
              gipCriteriaSummary: FREE_TEXT,
            } as never,
          ];
        },
      },
    });
    const rows = await svc.listGipProposals(actor);
    expect(seen).toEqual(["org-a"]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(FREE_TEXT);
    expect(rows[0]).toMatchObject({
      triageCallId: "c1",
      patientId: "p1",
      callState: "documented_pending_encounter",
    });
  });

  it("an UNBOUND reader throws (an empty worklist section would claim 'nothing proposed')", async () => {
    const svc = buildDrizzleIpuRouteService({} as never);
    await expect(svc.listGipProposals(actor)).rejects.toThrow(/not bound/);
  });

  it("accepts a thunk (resolved per call, after wiring)", async () => {
    let calls = 0;
    const svc = buildDrizzleIpuRouteService({} as never, {
      gipProposals: () => {
        calls += 1;
        return { proposalsForOrg: async () => [] };
      },
    });
    await svc.listGipProposals(actor);
    await svc.listGipProposals(actor);
    expect(calls).toBe(2);
  });
});
