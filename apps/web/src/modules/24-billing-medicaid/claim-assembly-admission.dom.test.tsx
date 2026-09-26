// apps/web/src/modules/24-billing-medicaid — F-066 (#161): the assembly wizard's admission.
//
// The wizard asked a billing clerk to TYPE a uuid (`useState("")` rendered as a raw text input), then
// later offered a lookup that spanned the whole organization. Both shapes let the wrong admission onto
// a Medicaid claim, and `step1Valid` only ever checked that the value was uuid-SHAPED — so a stale id
// left over from a previously selected patient passed every client-side check. The server re-derives
// and would refuse, but a wizard that lets a clerk get to "Assemble draft" has already made the error.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MedicaidAssemblyWizard } from "./claim-assembly-wizard";

const PATIENT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ADMISSION_A = "11111111-8888-4888-8888-111111111111";

let paths: string[] = [];

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "http://localhost").pathname;
  paths.push(path);
  const body = path.endsWith("/admissions")
    ? {
        items: [
          {
            id: ADMISSION_A,
            state: "active",
            admissionAt: "2025-11-02T00:00:00.000Z",
            dischargedAt: null,
          },
        ],
        nextCursor: null,
      }
    : {
        items: [
          {
            id: PATIENT_A,
            lastName: "Vance",
            firstName: "Ada",
            mrn: "MRN-1",
            dob: "1948-03-02",
            status: "active",
          },
          {
            id: PATIENT_B,
            lastName: "Okonkwo",
            firstName: "Ben",
            mrn: "MRN-2",
            dob: "1950-07-11",
            status: "active",
          },
        ],
        nextCursor: null,
      };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["biller"],
  permissions: [],
  isAdmin: false,
};

function mount(): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <MedicaidAssemblyWizard />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const comboboxes = (): HTMLInputElement[] => screen.getAllByRole("combobox") as HTMLInputElement[];

async function pickFirstOption(input: HTMLInputElement): Promise<void> {
  fireEvent.focus(input);
  const options = await screen.findAllByRole("option");
  fireEvent.click(options[0] as HTMLElement);
}

beforeEach(() => {
  paths = [];
});

describe("F-066 — the assembly wizard's admission belongs to the chosen patient", () => {
  it("does not offer an admission before a patient is chosen", () => {
    mount();
    const [, admission] = comboboxes();
    expect(admission?.disabled).toBe(true);
    expect(screen.getByText("Choose a patient first.")).toBeTruthy();
  });

  it("reads the chosen patient's admissions, not the org-wide census", async () => {
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission] = comboboxes();
    await waitFor(() => expect(admission?.disabled).toBe(false));
    fireEvent.focus(admission as HTMLInputElement);
    await waitFor(() => expect(paths).toContain(`/api/v1/patients/${PATIENT_A}/admissions`));
    expect(paths).not.toContain("/api/v1/admissions");
  });

  it("clears a selected admission when the patient changes — a stale uuid is still uuid-shaped", async () => {
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission] = comboboxes();
    await waitFor(() => expect(admission?.disabled).toBe(false));
    await pickFirstOption(admission as HTMLInputElement);
    await waitFor(() => expect((comboboxes()[1] as HTMLInputElement).value).not.toBe(""));

    // Switch to a different patient: the admission below it must not survive the change.
    fireEvent.focus(comboboxes()[0] as HTMLInputElement);
    const patientOptions = await screen.findAllByRole("option");
    fireEvent.click(patientOptions[1] as HTMLElement);
    await waitFor(() => expect((comboboxes()[1] as HTMLInputElement).value).toBe(""));
  });
});
