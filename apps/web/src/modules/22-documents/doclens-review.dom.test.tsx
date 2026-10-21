// apps/web/src/modules/22-documents — F-237: the DocLens review gates must hold in the DOM, not only in a
// spec. Each gate here is one the server ALSO enforces; the point of asserting it client-side is that a
// reviewer is never offered a control that silently does the wrong thing:
//   (a) Accept stays disabled until the reviewer has the field selected AND ticks "I compared this with
//       the source" — the decision body's `sourceViewConfirmed: true` is only sent once that is true;
//   (b) a field the stage-5 vision check read differently cannot be accepted as extracted without a
//       reason (422 VISION_DISAGREEMENT_REASON_REQUIRED server-side) — no request leaves until it has one;
//   (c) an unresolved SUD (42 CFR Part 2) detection blocks Complete (409 SUD_DETECTION_UNRESOLVED);
//   (d) the bounding-box overlay is positioned in PERCENTAGES of the page's own geometry, so it stays
//       registered to the image at any rendered width.
// Assertions are on RECORDED FETCH CALLS, like documents-writes.dom.test.tsx.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import type { Workspace } from "./doclens-api";
import { exclusionLabel } from "./doclens-model";
import { DocLensReviewWorkspace } from "./doclens-review-workspace";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const REVIEW = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PHONE = "cccccccc-3333-4333-8333-cccccccccccc";
const MED = "dddddddd-4444-4444-8444-dddddddddddd";

function fixture(sud: Workspace["sud"]["status"]): Workspace {
  return {
    batch: {
      id: BATCH,
      status: "in_review",
      sourceChannel: "fax",
      uploadedAt: "2026-10-01T09:00:00.000Z",
      documentId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
      patientId: null,
      patientName: "Ada Vance",
      referralId: null,
      identityStatus: null,
      recordsRequestConflict: null,
    },
    sud: {
      status: sud,
      detectorRef: "sud-lexicon-v1",
      resolvedAt: null,
      resolvedByMembershipId: null,
      contentRedacted: false,
      indicators: [
        {
          page: 1,
          category: "opioid_treatment",
          ruleId: "r1",
          term: "methadone",
          bbox: [0, 0, 61.2, 79.2],
        },
      ],
    },
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        documentType: "discharge_summary",
        confidence: 0.97,
        needsHumanClassification: false,
      },
    ],
    documents: [],
    jobs: [],
    review: {
      id: REVIEW,
      status: "in_progress",
      reviewerMembershipId: "membership-1",
      isMine: true,
    },
    candidates: [
      {
        id: PHONE,
        jobId: "job-1",
        documentType: "discharge_summary",
        fieldPath: "patient.phoneHome",
        description: "patient's home phone number",
        riskLevel: "low",
        confidence: 0.95,
        value: "555-0100",
        page: 1,
        // 10% / 10% / 40% / 10% of a 612×792 page.
        bbox: [61.2, 79.2, 306, 158.4],
        vision: { status: "not_required", observedValue: null },
        sudDetected: false,
        codingFlags: [],
        writebackTarget: true,
        redacted: false,
        decision: null,
      },
      {
        id: MED,
        jobId: "job-1",
        documentType: "discharge_summary",
        fieldPath: "medications[0].name",
        description: "one medication as written",
        riskLevel: "high",
        confidence: 0.81,
        value: "Morphine 5 mg PO q4h",
        page: 1,
        bbox: [61.2, 396, 306, 435.6],
        vision: { status: "disagreed", observedValue: "Morphine 15 mg PO q4h" },
        sudDetected: false,
        codingFlags: [],
        writebackTarget: false,
        redacted: false,
        decision: null,
      },
    ],
  };
}

let workspace: Workspace = fixture("not_detected");
let calls: { method: string; path: string; body: unknown; idem: string | null }[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(req.url, "http://localhost").pathname;
  const raw = req.method === "GET" ? "" : await req.clone().text();
  calls.push({
    method: req.method,
    path,
    body: raw ? JSON.parse(raw) : null,
    idem: req.headers.get("Idempotency-Key"),
  });
  const body = path.endsWith("/workspace") ? workspace : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: [],
  isAdmin: false,
};

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/intake/${BATCH}/review`]}>
            <Routes>
              <Route path="/intake/:batchId/review" element={<DocLensReviewWorkspace />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const decisionPosts = () =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/decisions"));
const fieldList = () => screen.getByRole("region", { name: "Extracted fields" });
const isDisabled = (el: HTMLElement): boolean => (el as HTMLButtonElement).disabled;
const fieldRow = (name: RegExp) => within(fieldList()).getByRole("button", { name });

beforeEach(() => {
  calls = [];
  workspace = fixture("not_detected");
});
afterEach(() => {
  calls = [];
});

describe("DocLens review workspace", () => {
  it("(a) keeps Accept disabled until the source-view confirmation is ticked", async () => {
    mount();
    fireEvent.click(await waitFor(() => fieldRow(/^Home phone/)));

    const accept = within(fieldList()).getByRole("button", { name: /Accept/ });
    expect(isDisabled(accept)).toBe(true);
    expect(isDisabled(within(fieldList()).getByRole("button", { name: /Edit/ }))).toBe(true);
    fireEvent.click(accept);
    expect(decisionPosts()).toHaveLength(0);

    fireEvent.click(
      within(fieldList()).getByRole("checkbox", { name: "I compared this with the source" }),
    );
    expect(isDisabled(accept)).toBe(false);
    fireEvent.click(accept);

    await waitFor(() => expect(decisionPosts()).toHaveLength(1));
    expect(decisionPosts()[0]?.path).toBe(`/api/v1/intake/reviews/${REVIEW}/decisions`);
    expect(decisionPosts()[0]?.body).toEqual({
      candidateId: PHONE,
      decision: "approve",
      sourceViewConfirmed: true,
    });
  });

  it("(b) blocks accepting a vision-disagreed field as extracted until a reason is given", async () => {
    mount();
    fireEvent.click(await waitFor(() => fieldRow(/^Medication 1 · name/)));
    expect(
      within(fieldList()).getAllByText(/Not found on page — closest: “Morphine 15 mg PO q4h”/)
        .length,
    ).toBeGreaterThan(0);
    fireEvent.click(
      within(fieldList()).getByRole("checkbox", { name: "I compared this with the source" }),
    );

    const accept = within(fieldList()).getByRole("button", { name: /Accept/ });
    expect(isDisabled(accept)).toBe(true);
    expect(within(fieldList()).getByText(/say why \(at least 5 characters\)/)).toBeTruthy();
    fireEvent.click(accept);
    fireEvent.keyDown(accept, { key: "a" });
    expect(decisionPosts()).toHaveLength(0);

    const reason = within(fieldList()).getByRole("textbox", {
      name: "Reason for accepting despite the page reading",
    });
    fireEvent.change(reason, { target: { value: "abc" } });
    expect(isDisabled(accept)).toBe(true);
    fireEvent.change(reason, { target: { value: "Dose confirmed with referring MD" } });
    expect(isDisabled(accept)).toBe(false);
    fireEvent.click(accept);
    await waitFor(() => expect(decisionPosts()).toHaveLength(1));
    expect(decisionPosts()[0]?.body).toMatchObject({
      candidateId: MED,
      decision: "approve",
      reason: "Dose confirmed with referring MD",
      sourceViewConfirmed: true,
    });
  });

  it("(c) an unresolved SUD detection shows the Part 2 banner and blocks Complete", async () => {
    workspace = fixture("detected");
    mount();
    expect(
      await screen.findByText(
        /protected by 42 CFR Part 2\. A provisional privacy flag has been placed/,
      ),
    ).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: /Complete review/ }))).toBe(true);
    expect(isDisabled(screen.getByRole("button", { name: "Confirm SUD flag" }))).toBe(false);

    // Rejecting as a false positive needs a reason of at least 5 characters.
    fireEvent.click(screen.getByRole("button", { name: "Not SUD (false positive)" }));
    const submit = screen.getByRole("button", { name: "Reject flag" });
    expect(isDisabled(submit)).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why is this not SUD information/), {
      target: { value: "Methadone prescribed for pain" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/sud-review"))).toBe(true),
    );
    expect(calls.find((c) => c.path.endsWith("/sud-review"))?.body).toEqual({
      outcome: "rejected",
      reason: "Methadone prescribed for pain",
    });
  });

  it("(c′) once the SUD flag is resolved, Complete is available", async () => {
    workspace = fixture("rejected");
    mount();
    expect(isDisabled(await screen.findByRole("button", { name: /Complete review/ }))).toBe(false);
  });

  it("(d) positions bounding boxes as percentages of the page geometry", async () => {
    mount();
    const box = await screen.findByRole("button", { name: "Home phone on the page" });
    expect(box.style.left).toBe("10%");
    expect(box.style.top).toBe("10%");
    expect(box.style.width).toBe("40%");
    expect(box.style.height).toBe("10%");

    // Clicking the box selects its field in the list.
    fireEvent.click(box);
    expect(fieldRow(/^Home phone/).getAttribute("aria-current")).toBe("true");
    expect(box.getAttribute("aria-pressed")).toBe("true");
  });

  it("bulk-approves only ticked low-risk fields, on the literal :bulk-approve path", async () => {
    mount();
    fireEvent.click(await waitFor(() => fieldRow(/^Home phone/)));
    const bulk = screen.getByRole("button", { name: /Approve reviewed low-risk \(0\)/ });
    expect(isDisabled(bulk)).toBe(true);
    fireEvent.click(
      within(fieldList()).getByRole("checkbox", { name: "I compared this with the source" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve reviewed low-risk \(1\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve 1" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith("/decisions:bulk-approve"))).toBe(true),
    );
    const post = calls.find((c) => c.path.endsWith("/decisions:bulk-approve"));
    expect(post?.path).toBe(`/api/v1/intake/reviews/${REVIEW}/decisions:bulk-approve`);
    expect(post?.body).toEqual({ candidateIds: [PHONE] });
  });

  it("sends an Idempotency-Key with the SUD resolution", async () => {
    workspace = fixture("detected");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm SUD flag" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/sud-review"))).toBe(true));
    const post = calls.find((c) => c.path.endsWith("/sud-review"));
    expect(post?.body).toEqual({ outcome: "confirmed" });
    expect(post?.idem).toBeTruthy();
  });
});

describe("GAP-067 — Part 2 content withheld", () => {
  const WITHHELD =
    /Part 2 content withheld — you need a licensed reviewer with a Part 2 need-to-know/;

  afterEach(() => vi.restoreAllMocks());

  it("shows the withheld state, not a blank value, for a redacted candidate and offers no decision", async () => {
    workspace = fixture("confirmed");
    workspace.sud.contentRedacted = true;
    workspace.sud.indicators = [];
    const phone = workspace.candidates[0];
    if (phone) {
      phone.redacted = true;
      phone.value = null;
      phone.sudDetected = true;
    }
    mount();
    const row = await waitFor(() => fieldRow(/^Home phone/));

    expect(within(row).getByTestId("doclens-field-withheld").textContent).toMatch(WITHHELD);
    expect(within(row).queryByText("—")).toBeNull();
    fireEvent.click(row);
    expect(within(fieldList()).queryByRole("button", { name: /Accept/ })).toBeNull();
    expect(within(fieldList()).getByText(/cannot be accepted, edited or rejected/)).toBeTruthy();
  });

  it("does not request the page image when the whole batch is withheld", async () => {
    workspace = fixture("detected");
    workspace.sud.contentRedacted = true;
    mount();

    expect((await screen.findByTestId("doclens-page-withheld")).textContent).toMatch(WITHHELD);
    expect(screen.queryByRole("img", { name: /Page 1/ })).toBeNull();
  });

  it("replaces a page image that the server refuses with a 403 by the withheld state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 403 }));
    mount();
    fireEvent.error(await screen.findByRole("img", { name: /Page 1/ }));

    expect((await screen.findByTestId("doclens-page-withheld")).textContent).toMatch(WITHHELD);
    expect(screen.queryByRole("img", { name: /Page 1/ })).toBeNull();
  });

  it("keeps the ordinary broken-image message for a non-403 failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    mount();
    fireEvent.error(await screen.findByRole("img", { name: /Page 1/ }));

    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByTestId("doclens-page-withheld")).toBeNull();
  });
});

describe("F-238 — documents in the fax and coding checks", () => {
  it("lists the split documents and shows each code's flags, most severe first, with the suggestion", async () => {
    const ws = fixture("not_detected");
    workspace = {
      ...ws,
      documents: [
        {
          pageFrom: 1,
          pageTo: 1,
          documentType: "transfer_record",
          title: "INTER-FACILITY TRANSFER",
          date: "2026-08-29",
          duplicateOfPage: null,
          boundary: "first_page",
          identity: { status: null, disagreeing: [], resolution: null },
        },
        {
          pageFrom: 2,
          pageTo: 2,
          documentType: "imaging",
          title: "ECHO",
          date: "2026-09-19",
          duplicateOfPage: 1,
          boundary: "duplicate",
          identity: { status: null, disagreeing: [], resolution: null },
        },
      ],
      candidates: [
        ...ws.candidates,
        {
          ...(ws.candidates[0] as Workspace["candidates"][number]),
          id: "ffffffff-6666-4666-8666-ffffffffffff",
          fieldPath: "diagnoses[0].icd10",
          description: "the ICD-10-CM code printed next to that diagnosis",
          riskLevel: "high",
          value: "R53.81",
          writebackTarget: false,
          codingFlags: [
            {
              kind: "unspecified_code",
              code: "R53.81",
              suggest: [],
              detail: "An unspecified code.",
            },
            {
              kind: "unacceptable_hospice_principal",
              code: "R53.81",
              suggest: ["I50.22"],
              detail: "Debility cannot be the hospice principal diagnosis.",
            },
          ],
        },
      ],
    };
    mount();
    const docs = await screen.findByText("2 documents in this fax");
    const table = within(docs.closest("details") as HTMLElement);
    expect(table.getByText("INTER-FACILITY TRANSFER")).toBeTruthy();
    expect(table.getByText("Re-sent copy of p. 1 — not extracted")).toBeTruthy();
    expect(table.getByText("1 must fix")).toBeTruthy();

    const list = within(fieldList()).getByRole("list", { name: "Coding checks" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Not acceptable as hospice principal");
    expect(items[0]?.textContent).toContain("Consider: I50.22.");
    expect(items[1]?.textContent).toContain("Unspecified code");
  });
});

describe("F-238 — does each document belong to this patient", () => {
  const doc = (
    pageFrom: number,
    title: string,
    identity: Workspace["documents"][number]["identity"],
  ): Workspace["documents"][number] => ({
    pageFrom,
    pageTo: pageFrom,
    documentType: "hp",
    title,
    date: null,
    duplicateOfPage: null,
    boundary: "new_header",
    identity,
  });
  const flagged = (): Workspace => {
    const ws = fixture("not_detected");
    return {
      ...ws,
      batch: { ...ws.batch, identityStatus: "mismatch" },
      documents: [
        doc(1, "TRANSFER RECORD", { status: "match", disagreeing: [], resolution: null }),
        doc(2, "HISTORY AND PHYSICAL", {
          status: "mismatch",
          disagreeing: ["dateOfBirth", "lastName"],
          resolution: null,
        }),
      ],
    };
  };

  it("warns, says which identifiers differ (never values), and keeps Complete disabled", async () => {
    workspace = flagged();
    mount();
    expect(
      await screen.findByText("1 document in this fax may belong to another patient"),
    ).toBeTruthy();
    expect(screen.getByText("Different patient?")).toBeTruthy();
    expect(screen.getByText("date of birth and last name differ")).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: /Complete review/ }))).toBe(true);
  });

  it("marks a document as another patient's with a reason, on the identity-review path", async () => {
    workspace = flagged();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Another patient's" }));
    const submit = screen.getByRole("button", { name: "Mark as another patient's" });
    expect(isDisabled(submit)).toBe(true); // a reason is required
    fireEvent.change(screen.getByPlaceholderText("Whose it is / why"), {
      target: { value: "Ada Vance's H&P, misfiled" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/identity-review"))?.body).toEqual({
        pageFrom: 2,
        resolution: "other_patient",
        reason: "Ada Vance's H&P, misfiled",
      }),
    );
    expect(calls.find((c) => c.path.endsWith("/identity-review"))?.idem).toBeTruthy();
  });

  it("explains an unlinked document", async () => {
    const ws = fixture("not_detected");
    workspace = { ...ws, batch: { ...ws.batch, identityStatus: "no_target" } };
    mount();
    expect(
      await screen.findByText("This document is not linked to a patient or referral"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Move document/ })).toBeTruthy();
  });

  it("warns when the fax's records-request code was issued for another referral", async () => {
    const ws = fixture("not_detected");
    workspace = {
      ...ws,
      batch: {
        ...ws.batch,
        recordsRequestConflict: { code: "RR-ACDEFH7", kind: "code_names_another_referral" },
      },
    };
    mount();
    expect(
      await screen.findByText(
        "This fax carries records-request code RR-ACDEFH7, which was issued for a different referral",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/use Move document to file them under its referral/)).toBeTruthy();
  });

  it("shows no records-request warning when there is no conflict", async () => {
    workspace = fixture("not_detected");
    mount();
    await screen.findByRole("button", { name: /Move document/ });
    expect(screen.queryByText(/carries records-request code/)).toBeNull();
  });

  it("says a Part 2 privacy flag moves with the document", async () => {
    workspace = fixture("detected");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Move document/ }));
    expect(await screen.findByText(/Its privacy flag moves\s+with it/)).toBeTruthy();
  });
});

describe("completion exclusion labels", () => {
  it("says why a field stayed off the chart, by field, instead of calling a name 'not a chart field'", () => {
    expect(exclusionLabel("not_a_writeback_target", "patient.legalFirstName")).toMatch(
      /^Identity field/,
    );
    expect(exclusionLabel("not_a_writeback_target", "patient.dateOfBirth")).toMatch(
      /^Identity field/,
    );
    expect(exclusionLabel("not_a_writeback_target", "medications[2].name")).toMatch(
      /reconcile it in the chart/,
    );
    expect(exclusionLabel("not_a_writeback_target", "allergies[0].substance")).toMatch(
      /reconcile it in the chart/,
    );
    expect(exclusionLabel("sud_detected", "patient.phoneMobile")).toBe("SUD-flagged page");
  });
});
