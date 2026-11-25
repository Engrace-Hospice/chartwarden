// The New Visit form starts with the purpose and the day a caller asked for (the visit note's "Schedule next visit"), keeps them
// editable, and never overwrites an edit when the page around it re-renders. Synthetic ids only.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import type { NewVisitPrefill } from "./new-visit-prefill";
import { NewVisitModal } from "./scheduling-workflow";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["scheduler"],
  permissions: ["visit.create"],
  isAdmin: false,
};

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const body = url.pathname.endsWith("/admissions")
    ? { items: [{ id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z" }] }
    : url.pathname.endsWith("/addresses")
      ? { addresses: [] }
      : url.pathname === "/api/v1/scheduling/eligible-clinicians"
        ? []
        : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function Harness({ prefill }: { prefill: NewVisitPrefill | null }): JSX.Element {
  return (
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <NewVisitModal
              open
              onClose={() => undefined}
              onCreated={() => undefined}
              initialPatient={{ id: PATIENT, label: "Synthetic Patient" }}
              initialPrefill={prefill}
            />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>
  );
}

const purposeSelect = (): HTMLSelectElement =>
  screen.getByLabelText(/visit purpose/i) as HTMLSelectElement;

async function toWhenAndWhere(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled());
  // The step only advances once the single active admission has been read in; the form says so until then.
  await waitFor(() => {
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByLabelText(/scheduled start/i)).toBeInTheDocument();
  });
}

describe("New Visit form prefill", () => {
  it("starts on the purpose and the day it was asked for, keeping the default time of day", async () => {
    render(<Harness prefill={{ purpose: "aide_poc", date: "2026-12-05" }} />);

    await waitFor(() => expect(purposeSelect().value).toBe("aide_poc"));
    await toWhenAndWhere();
    expect((screen.getByLabelText(/scheduled start/i) as HTMLInputElement).value).toMatch(
      /^2026-12-05T\d{2}:\d{2}$/,
    );
    // The default window is an hour long, so it ends the same day unless it crosses midnight.
    expect((screen.getByLabelText(/scheduled end/i) as HTMLInputElement).value).toMatch(
      /^2026-12-0[56]T\d{2}:\d{2}$/,
    );
  });

  it("starts as it always did when nothing is asked for", async () => {
    render(<Harness prefill={null} />);

    await waitFor(() => expect(purposeSelect().value).toBe("routine_visit"));
  });

  it("keeps the scheduler's own choice when the page re-renders with the same request", async () => {
    const view = render(<Harness prefill={{ purpose: "aide_poc", date: null }} />);
    await waitFor(() => expect(purposeSelect().value).toBe("aide_poc"));

    fireEvent.change(purposeSelect(), { target: { value: "msw_followup" } });
    view.rerender(<Harness prefill={{ purpose: "aide_poc", date: null }} />);

    expect(purposeSelect().value).toBe("msw_followup");
  });
});
