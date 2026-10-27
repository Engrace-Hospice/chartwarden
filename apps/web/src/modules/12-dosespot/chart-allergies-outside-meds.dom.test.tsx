import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot/chart-allergies-outside-meds.dom.test.tsx — F-238: the prescriber-facing
// allergy banner and the outside medication list. An UNVERIFIED allergy is drawn, labelled; a failed read is
// never shown as "no allergies"; reconciling an outside line posts the decision and nothing else.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { AllergyBanner, OutsideMedicationList } from "./chart-allergies-outside-meds";

const PATIENT = "11111111-1111-4111-8111-111111111111";
let allergiesOk = true;
let calls: string[] = [];
let bodies: unknown[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : String(init?.body ?? "");
    if (raw) bodies.push(JSON.parse(raw));
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (path.endsWith("/allergies")) {
    return allergiesOk
      ? json(200, {
          allergies: [
            {
              id: "a1",
              patientId: PATIENT,
              allergenText: "Penicillin - hives",
              reaction: null,
              severity: null,
              verificationStatus: "unverified",
              source: "intake_extraction",
              sourceDocumentId: "d1",
              sourcePage: 2,
              reportedByMembershipId: "m1",
              reportedAt: "2026-10-04T00:00:00.000Z",
              verifiedByMembershipId: null,
              verifiedAt: null,
              enteredInErrorAt: null,
            },
          ],
        })
      : json(500, { error: { code: "INTERNAL", message: "x" } });
  }
  if (path.endsWith("/medications/history")) {
    return json(200, {
      records: [
        {
          id: "h1",
          drugName: "Morphine sulfate 5 mg PO q4h PRN pain",
          source: "doclens_intake",
          sourcePage: 2,
          attestedAt: "2026-10-04T00:00:00.000Z",
          reconciliationDecision: null,
        },
      ],
    });
  }
  return json(200, { resultingOrderId: null });
}

const mount = (el: JSX.Element) =>
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      {el}
    </ApiClientProvider>,
  );

beforeEach(() => {
  allergiesOk = true;
  calls = [];
  bodies = [];
});

describe("F-238 — allergy banner", () => {
  it("shows an unverified referral allergy, labelled, with Verify / Entered in error", async () => {
    mount(<AllergyBanner patientId={PATIENT} />);
    expect(await screen.findByText("Penicillin - hives")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.getByText(/1 unverified/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(calls).toContain(`POST /api/v1/patients/${PATIENT}/allergies/a1/verify`),
    );
  });

  it("a failed read is an alert, never 'No allergies recorded'", async () => {
    allergiesOk = false;
    mount(<AllergyBanner patientId={PATIENT} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText(/No allergies recorded/)).toBeNull();
  });
});

describe("F-238 — outside medication list", () => {
  it("labels the referral line and records a reconciliation decision (no order call)", async () => {
    mount(<OutsideMedicationList patientId={PATIENT} />);
    expect(await screen.findByText("Morphine sulfate 5 mg PO q4h PRN pain")).toBeTruthy();
    expect(screen.getByText(/Referral fax, p\. 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue (prescribe separately)" }));
    await waitFor(() =>
      expect(calls).toContain("POST /api/v1/medication-history-records/h1/reconcile"),
    );
    expect(bodies).toEqual([{ decision: "carry_forward" }]);
    expect(calls.some((c) => c.includes("/medication-orders"))).toBe(false);
  });
});
