// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { PrivacyWorkQueue } from "../privacy-work-queue";

// The patient search is covered in shell/entity-lookups.dom.test.tsx; here it is a plain input.
vi.mock("../../../shell/entity-lookups", () => ({
  PatientLookupField: (props: {
    label: string;
    value: string;
    onChange: (v: string, o: { id: string; label: string; searchLabel: string } | null) => void;
  }) => (
    <label>
      {props.label}
      <input
        value={props.value}
        onChange={(e) =>
          props.onChange(e.target.value, {
            id: e.target.value,
            label: "Elena Rivera",
            searchLabel: "Elena Rivera",
          })
        }
      />
    </label>
  ),
}));

afterEach(cleanup);

const PATIENT = "11111111-1111-4111-8111-111111111111";
const AMENDMENT = "22222222-2222-4222-8222-222222222222";

const session: Session = {
  userId: "u-1",
  organizationId: "org-1",
  displayName: "Pat Privacy",
  roles: ["compliance_officer"],
  permissions: ["audit.disclosure_report", "audit.read", "patient.amend_review"],
};

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function makeClient(): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/amendments") {
        return ok({
          amendments: [
            {
              id: AMENDMENT,
              patientId: PATIENT,
              status: "pending",
              scope: "demographic",
              rationale: "DOB is wrong on the chart",
              receivedAt: "2026-09-20T10:00:00.000Z",
              slaDueAt: "2026-11-19T10:00:00.000Z",
            },
          ],
        });
      }
      if (path === "/api/v1/audit/patients/{patientId}/accounting") {
        return ok({
          patientId: PATIENT,
          period: { from: "2020-10-06T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
          disclosures: [
            {
              date: "2026-08-01T12:00:00.000Z",
              recipient: "State Health Dept",
              purpose: "public_health",
              description: "Reportable condition",
              eventId: "e-1",
            },
          ],
          note: "Treatment, payment and operations are excluded.",
          nextCursor: null,
        });
      }
      if (path === "/api/v1/audit/patients/{patientId}/access") {
        return ok({
          items: [
            {
              eventId: "e-2",
              at: "2026-09-01T09:00:00.000Z",
              actorUserId: "u-9",
              actorRole: "rn",
              eventType: "phi.read",
              fields: ["demographics"],
              viaBreakGlass: true,
            },
          ],
          nextCursor: null,
        });
      }
      return ok({});
    }),
    POST: vi.fn(async () => ok({})),
  } as unknown as ApiClient;
}

function renderQueue(client: ApiClient, s: Session = session) {
  render(
    <ApiClientProvider client={client}>
      <SessionProvider session={s}>
        <PrivacyWorkQueue />
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("PrivacyWorkQueue (GAP-012 staff HIPAA §164.526 / §164.528)", () => {
  it("lists pending amendment requests with their 60-day due date", async () => {
    renderQueue(makeClient());
    expect(await screen.findByText("DOB is wrong on the chart")).toBeTruthy();
    expect(screen.getByText(/Due/)).toBeTruthy();
  });

  it("accepts an amendment request", async () => {
    const client = makeClient();
    renderQueue(client);
    await screen.findByText("DOB is wrong on the chart");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/amendments/{id}/accept", {
        params: { path: { id: AMENDMENT } },
      }),
    );
  });

  it("requires a denial reason before denying", async () => {
    const client = makeClient();
    renderQueue(client);
    await screen.findByText("DOB is wrong on the chart");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    const confirm = screen.getByRole("button", { name: "Confirm denial" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Denial reason/), {
      target: { value: "Record is accurate and complete" },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/amendments/{id}/deny", {
        params: { path: { id: AMENDMENT } },
        body: { denialReason: "Record is accurate and complete" },
      }),
    );
  });

  it("shows a patient's accounting of disclosures", async () => {
    const client = makeClient();
    renderQueue(client);
    fireEvent.click(screen.getByRole("tab", { name: "Accounting of disclosures" }));
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: PATIENT } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByText("State Health Dept")).toBeTruthy();
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/audit/patients/{patientId}/accounting",
      expect.objectContaining({
        params: expect.objectContaining({ path: { patientId: PATIENT } }),
      }),
    );
  });

  it("shows a patient's internal access history and flags break-glass", async () => {
    renderQueue(makeClient());
    fireEvent.click(screen.getByRole("tab", { name: "Access report" }));
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: PATIENT } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    const row = (await screen.findByText("PHI Read")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Break-glass")).toBeTruthy();
  });

  it("hides the amendment inbox from a user without patient.amend_review", () => {
    renderQueue(makeClient(), { ...session, permissions: ["audit.disclosure_report"] });
    expect(screen.queryByRole("tab", { name: "Amendment requests" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Accounting of disclosures" })).toBeTruthy();
  });
});
