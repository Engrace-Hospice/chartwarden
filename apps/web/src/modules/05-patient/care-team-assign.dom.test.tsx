// apps/web/src/modules/05-patient — the patient chart's "Assign care team member" dialog (M5 §4.3).
//
// The dialog posted `{ clinicianMembershipId, role }` to POST /api/v1/patients/:id/assignments behind an
// `as never` cast, but the route's schema takes `clinicianUserId` (a user uuid) and rejects unknown
// fields — so EVERY assignment answered 400 "request validation failed" in production. These tests
// assert on the RECORDED REQUEST BODY, which is the contract the route validates.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { CareTeamTab } from "./patient-chart";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "org-1";
const RN_USER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const RN_MEMBERSHIP = "cccccccc-3333-4333-8333-cccccccccccc";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: ORG,
  displayName: "Ada Administrator",
  permissions: ["patient.read", "patient.assign"],
};

let posts: { path: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST") {
    posts.push({ path: url.pathname, body: await req.json() });
    return json({ id: "asg-1" }, 201);
  }
  if (url.pathname === `/api/v1/patients/${PATIENT}/care-team`) {
    return json({ assignments: [], caregivers: [], emergencyContacts: [] });
  }
  if (url.pathname === `/api/v1/orgs/${ORG}/members`) {
    return json({
      members: [
        {
          membershipId: RN_MEMBERSHIP,
          userId: RN_USER,
          displayName: "Nora Visit, RN",
          email: "nora@example.test",
          status: "active",
        },
      ],
    });
  }
  return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter>
            <CareTeamTab patientId={PATIENT} organizationId={ORG} />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

async function pickClinicianAndRole(roleName: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Assign care team member" }));
  fireEvent.focus(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: /Nora Visit, RN/ }));
  fireEvent.click(screen.getByRole("button", { name: /Primary RN/ }));
  fireEvent.click(screen.getByRole("option", { name: roleName }));
  fireEvent.click(screen.getByRole("button", { name: "Assign clinician" }));
}

beforeEach(() => {
  posts = [];
});

describe("Assign care team member", () => {
  it("posts the clinician's USER id under `clinicianUserId`, the field the route validates", async () => {
    mount();
    await pickClinicianAndRole("Primary RN");

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: `/api/v1/patients/${PATIENT}/assignments`,
      body: { clinicianUserId: RN_USER, role: "primary_rn" },
    });
  });

  it("offers an additional RN role beside Primary RN", async () => {
    mount();
    await pickClinicianAndRole("RN");

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({ clinicianUserId: RN_USER, role: "rn" });
  });
});
