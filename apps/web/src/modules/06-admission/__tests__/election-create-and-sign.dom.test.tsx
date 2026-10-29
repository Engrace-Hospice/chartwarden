// @vitest-environment jsdom
// "Create and sign" in the Election Statement dialog: one action, the SAME two server calls as the
// separate create then sign dialogs (draft POST, version GET, sign POST) -- no permission/step-up shortcut.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionDetail } from "../admission-detail";

vi.mock("@chartwarden/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chartwarden/ui")>();
  return {
    ...actual,
    CodeSearchInput: ({ label, onChange }: { label: string; onChange: (v: string) => void }) => (
      <input aria-label={label} onChange={(ev) => onChange(ev.target.value)} />
    ),
  };
});
vi.mock("../../../shell/entity-lookups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shell/entity-lookups")>();
  const Stub = ({ label, onChange }: { label: string; onChange: (v: string) => void }) => (
    <input aria-label={label} onChange={(ev) => onChange(ev.target.value)} />
  );
  return { ...actual, ProviderEntityLookupField: Stub, MdmEntityLookupField: Stub };
});

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  permissions: ["admission.read", "admission.update", "election.draft"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function makeClient(): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/admissions/{id}")
        return ok({
          id: admissionId,
          state: "pending",
          status: "pending",
          version: 4,
          patientId: "patient-1",
          activationGate: { ready: false, missing: [] },
        });
      if (path === "/api/v1/admissions/{id}/readiness")
        return ok({
          admissionId,
          status: "action_required",
          canActivate: false,
          completed: 0,
          blockingRemaining: 1,
          requirements: [
            {
              code: "election_statement",
              label: "Election Statement",
              status: "action_required",
              blocking: true,
              message: "Election Statement is required.",
              action: "COMPLETE_ELECTION",
            },
          ],
        });
      if (path === "/api/v1/admissions/{id}/election-periods")
        return ok({ items: [{ id: "period-1", state: "active", version: 1 }], nextCursor: null });
      if (path === "/api/v1/patients/{patientId}/election-certification")
        return ok({
          admission: null,
          periods: [
            {
              id: "period-1",
              state: "pending",
              version: 1,
              sequenceNumber: 1,
              periodKind: "ninety_day",
              effectiveAt: null,
              scheduledEndAt: null,
              actualEndAt: null,
              electionStatement: null,
              cti: null,
            },
          ],
        });
      if (path === "/api/v1/election-statements/{id}") return ok({ id: "es-1", version: 7 });
      return ok({ items: [], nextCursor: null, addresses: [] });
    }),
    POST: vi.fn(async (path: string) =>
      path === "/api/v1/admissions/{id}/election-statements"
        ? ok({ id: "es-1", version: 1 })
        : ok({ id: "es-1", version: 8 }),
    ),
    PATCH: vi.fn(),
  } as unknown as ApiClient;
}

async function openCreateDialog(session: Session): Promise<ApiClient> {
  const client = makeClient();
  render(
    <MemoryRouter initialEntries={[`/admissions/${admissionId}`]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route path="/admissions/:id" element={<AdmissionDetail />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Complete Election Statement" })[0]!);
  fireEvent.click(screen.getByText("Create in ChartWarden"));
  fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("Primary diagnosis ICD-10"), {
    target: { value: "C34.90" },
  });
  fireEvent.change(screen.getByLabelText("Elected hospice provider"), {
    target: { value: "prov-1" },
  });
  fireEvent.click(screen.getByLabelText(/acknowledged hospice election/i));
  return client;
}

describe("Election Statement: create and sign", () => {
  it("creates then signs in one action using the same two endpoints", async () => {
    const client = await openCreateDialog({
      ...base,
      permissions: [...base.permissions!, "election.sign"],
    });
    fireEvent.click(screen.getByLabelText(/create and sign/i));
    fireEvent.change(screen.getByLabelText("Signer name"), { target: { value: "Robert Johnson" } });
    fireEvent.click(screen.getByLabelText(/I attest the Election Statement/i));
    fireEvent.click(screen.getByRole("button", { name: "Create and sign" }));

    const post = client.POST as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0]![0]).toBe("/api/v1/admissions/{id}/election-statements");
    expect(post.mock.calls[1]![0]).toBe("/api/v1/election-statements/{id}/sign");
    expect(post.mock.calls[1]![1]).toMatchObject({
      params: { path: { id: "es-1" } },
      body: { signingPatientName: "Robert Johnson", signingRole: "patient", ifVersion: 7 },
    });
  });

  it("does not offer create-and-sign without the election.sign permission", async () => {
    const client = await openCreateDialog(base);
    expect(screen.queryByLabelText(/create and sign/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create statement" }));
    const post = client.POST as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe("/api/v1/admissions/{id}/election-statements");
  });
});
