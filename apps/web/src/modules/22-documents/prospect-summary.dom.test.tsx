import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/22-documents — F-238 prospect summary panel: renders the SERVER's summary (sections,
// citations, coding checks, documents that differ, Part 2 withheld count), puts the server's plain text in a
// read-only text box with a working Copy button, and treats 409 as "not complete yet" rather than an error.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PatientIntakeSummaries,
  type ProspectSummary,
  ProspectSummaryPanel,
  SHOWS_INTAKE_SUMMARIES,
} from "./prospect-summary";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DC = { document: "St Mary Discharge Summary", documentType: "discharge_summary", page: 1 };

const SUMMARY: ProspectSummary = {
  batchId: BATCH,
  reviewId: "r1",
  completedAt: "2026-10-04T12:00:00.000Z",
  receivedAt: "2026-10-04T10:00:00.000Z",
  sourceChannel: "fax",
  filedUnder: { patientId: "p1", patientName: "Vance, Ada", referralId: null },
  patient: [
    {
      key: "legalName",
      label: "Legal name",
      values: [{ value: "Ada Vance", edited: false, citations: [DC] }],
    },
    {
      key: "dateOfBirth",
      label: "Date of birth",
      values: [
        { value: "01/02/1940", edited: false, citations: [DC] },
        {
          value: "01/03/1940",
          edited: true,
          citations: [{ ...DC, document: "History & physical", page: 5 }],
        },
      ],
    },
  ],
  diagnoses: [
    {
      description: "Congestive heart failure",
      icd10Code: "I50.9",
      icd10Source: "document",
      role: "principal",
      edited: false,
      codingFlags: [
        {
          kind: "unspecified_code",
          code: "I50.9",
          detail: "Unspecified heart failure.",
          label: "Unspecified code",
          severity: "info",
        },
      ],
      citations: [{ ...DC, page: 3 }],
    },
  ],
  medications: [
    { text: "Morphine 5 mg PO q4h PRN", edited: false, citations: [{ ...DC, page: 2 }] },
  ],
  allergies: [],
  advanceDirectives: [],
  documents: [
    {
      pageFrom: 1,
      pageTo: 4,
      documentType: "discharge_summary",
      documentTypeLabel: "Discharge summary",
      title: "St Mary Discharge Summary",
      date: "2026-09-28",
      status: "included",
      duplicateOfPage: null,
    },
    {
      pageFrom: 7,
      pageTo: 7,
      documentType: "consult",
      documentTypeLabel: "Consult note",
      title: null,
      date: null,
      status: "other_patient",
      duplicateOfPage: null,
    },
  ],
  withheld: { part2Values: 2 },
  notCaptured: ["Code status and advance-directive content"],
  plainText:
    "PROSPECT SUMMARY\n\nPATIENT\n-------\n- Legal name: Ada Vance (St Mary Discharge Summary p.1)",
};

let status = 200;
let calls: string[] = [];
let patientItems: ProspectSummary[] = [];
async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(req.url, "http://localhost").pathname;
  calls.push(path);
  const body = path.endsWith("/intake-summaries")
    ? { items: patientItems }
    : status === 200
      ? SUMMARY
      : { error: { code: "REVIEW_NOT_COMPLETE", message: "not complete" } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ProspectSummaryPanel batchId={BATCH} />
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  status = 200;
  calls = [];
  patientItems = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("F-238 — prospect summary panel", () => {
  it("renders the server's sections with citations, differing values, coding checks and the withheld count", async () => {
    mount();
    const panel = await screen.findByRole("region", { name: "Prospect summary" });
    await within(panel).findByText("Ada Vance");
    expect(calls).toEqual([`/api/v1/intake/uploads/${BATCH}/summary`]);
    expect(within(panel).getByText("Documents differ")).toBeTruthy();
    expect(within(panel).getByText("01/03/1940")).toBeTruthy();
    expect(within(panel).getByText("corrected by reviewer")).toBeTruthy();
    expect(within(panel).getByText("History & physical p.5")).toBeTruthy();
    expect(within(panel).getByText("Congestive heart failure")).toBeTruthy();
    expect(within(panel).getByText("I50.9")).toBeTruthy();
    expect(within(panel).getByText("Unspecified heart failure.")).toBeTruthy();
    expect(within(panel).getByText("Morphine 5 mg PO q4h PRN")).toBeTruthy();
    expect(within(panel).getByText(/this is not "no known allergies"/)).toBeTruthy();
    expect(within(panel).getByText("Another patient's — excluded")).toBeTruthy();
    expect(within(panel).getByRole("note").textContent).toMatch(/2 approved values are not shown/);
  });

  it("shows the plain text read-only and copies exactly the server's text", async () => {
    const writeText = vi.fn(async (_: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    const box = (await screen.findByLabelText("Plain-text summary")) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe(SUMMARY.plainText);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SUMMARY.plainText));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("treats 409 as not complete yet, not as an error", async () => {
    status = 409;
    mount();
    expect(
      await screen.findByText("The summary is available once the review is complete."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the patient chart Overview: every completed summary, newest open; nothing at all when there are none", async () => {
    const PATIENT = "cccccccc-3333-4333-8333-cccccccccccc";
    const older: ProspectSummary = {
      ...SUMMARY,
      batchId: "older",
      receivedAt: "2026-10-06T10:00:00.000Z",
    };
    patientItems = [older, SUMMARY];
    const { unmount } = render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <PatientIntakeSummaries patientId={PATIENT} />
      </ApiClientProvider>,
    );
    expect(await screen.findByText("Intake records summary")).toBeTruthy();
    expect(calls).toEqual([`/api/v1/patients/${PATIENT}/intake-summaries`]);
    const entries = document.querySelectorAll("details.wx-prospect-entry");
    expect(entries).toHaveLength(2);
    expect((entries[0] as HTMLDetailsElement).open).toBe(true);
    expect((entries[1] as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText("Records received 2026-10-06")).toBeTruthy();
    unmount();

    patientItems = [];
    calls = [];
    const { container } = render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <PatientIntakeSummaries patientId={PATIENT} />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe("");
    // Shown for a patient on (or after) service — never for a prospective one.
    expect(SHOWS_INTAKE_SUMMARIES.has("active")).toBe(true);
    expect(SHOWS_INTAKE_SUMMARIES.has("prospective")).toBe(false);
  });
});
