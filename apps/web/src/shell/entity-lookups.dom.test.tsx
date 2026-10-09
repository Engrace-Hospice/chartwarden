// apps/web/src/shell — F-066 (#161): the admission lookup must be scoped to a PATIENT.
//
// `AdmissionLookupField` took a `patientId` prop and destructured it into `_patientId` — accepted and
// dropped — then paged `GET /api/v1/admissions`, the ORG-WIDE census. That route takes no patient
// filter and its items are `{ id, state, version }` with no `patientId`, so the options could neither
// be narrowed to the patient nor labelled with whose they were: a biller assembling a Medicaid claim
// chose an opaque uuid from every admission in the organization. The issue described the field it
// replaced as "a transcription error that becomes a billing error"; picking the wrong tenant-wide row
// out of a list of `Admission 3f2a1b0c` is that same error with a dropdown around it.
//
// These assert on the RECORDED REQUEST, because a spy on the component would not distinguish reading
// the patient's admissions from reading everyone's and rendering the same-shaped list.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdmissionLookupField, MembershipLookupField } from "./entity-lookups";
import { SessionProvider } from "./session";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OPEN_ADMISSION = "11111111-8888-4888-8888-111111111111";
const DISCHARGED_ADMISSION = "22222222-9999-4999-8999-222222222222";
const MEMBERSHIP = "33333333-aaaa-4aaa-8aaa-333333333333";
const CLINICIAN_USER = "44444444-bbbb-4bbb-8bbb-444444444444";

let paths: string[] = [];

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "http://localhost").pathname;
  paths.push(path);
  if (path === "/api/v1/orgs/org-1/members") {
    return new Response(
      JSON.stringify({
        members: [
          {
            membershipId: MEMBERSHIP,
            userId: CLINICIAN_USER,
            displayName: "Jordan Clinician",
            email: "jordan@example.test",
            status: "active",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      items: [
        {
          id: OPEN_ADMISSION,
          state: "active",
          admissionAt: "2025-11-02T00:00:00.000Z",
          dischargedAt: null,
        },
        {
          id: DISCHARGED_ADMISSION,
          state: "discharged",
          admissionAt: "2026-01-04T00:00:00.000Z",
          dischargedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mount(patientId: string, onChange: (v: string) => void = () => {}): JSX.Element {
  return (
    // MemoryRouter: the no-matches affordance links to Direct admission / Start referral.
    <MemoryRouter>
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <AdmissionLookupField
          label="Admission"
          value=""
          onChange={onChange}
          patientId={patientId}
          required
        />
      </ApiClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  paths = [];
});
afterEach(() => {
  paths = [];
});

describe("F-066 — AdmissionLookupField is patient-scoped", () => {
  it("reads the PATIENT's admissions, never the org-wide census", async () => {
    render(mount(PATIENT));
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(paths.length).toBeGreaterThan(0));
    expect(paths[0]).toBe(`/api/v1/patients/${PATIENT}/admissions`);
    expect(paths).not.toContain("/api/v1/admissions");
  });

  it("labels an option by a date a human can recognise, and says whether it is open", async () => {
    render(mount(PATIENT));
    fireEvent.focus(screen.getByRole("combobox"));
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("Admitted 2025-11-02");
    expect(options[0]?.textContent).toContain("open");
    expect(options[1]?.textContent).toContain("discharged 2026-02-01");
  });

  it("is disabled and says why until a patient is chosen — never a list nobody can choose from", async () => {
    render(mount(""));
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("Choose a patient first.")).toBeTruthy();
    fireEvent.focus(input);
    // No patient, no request — the census is not a fallback, it is the bug.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(paths).toHaveLength(0);
  });

  it("re-reads against the new patient when the patient changes", async () => {
    const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const { rerender } = render(mount(PATIENT));
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(paths).toContain(`/api/v1/patients/${PATIENT}/admissions`));
    rerender(mount(OTHER));
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(paths).toContain(`/api/v1/patients/${OTHER}/admissions`));
  });
});

describe("MembershipLookupField identifier spaces", () => {
  it("keeps membershipId as the selected value and carries the corresponding userId as metadata", async () => {
    let selectedValue = "";
    let selectedUserId = "";
    render(
      <MemoryRouter>
        <ApiClientProvider
          client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
        >
          <SessionProvider
            session={{
              userId: "viewer-user",
              organizationId: "org-1",
              membershipId: "viewer-membership",
              roles: [],
              permissions: [],
              isAdmin: false,
            }}
          >
            <MembershipLookupField
              label="Clinician"
              value=""
              onChange={(value, option) => {
                selectedValue = value;
                selectedUserId = option?.metadata?.userId ?? "";
              }}
            />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: /Jordan Clinician/i }));
    expect(selectedValue).toBe(MEMBERSHIP);
    expect(selectedUserId).toBe(CLINICIAN_USER);
  });
});
