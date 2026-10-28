import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// usePatientChartData loads the org staff roster only to label care-team rows. That read needs
// `member.manage`, so a clinician without it must not fire it (it 403s on every chart tab).
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { usePatientChartData } from "./patient-overview";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "org-1";
const base = { userId: "u1", organizationId: ORG, displayName: "Nora" };

function Probe(): null {
  usePatientChartData({ id: PATIENT, organizationId: ORG } as never);
  return null;
}

async function pathsFetched(permissions: string[]): Promise<string[]> {
  const gets: string[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    gets.push(new URL(req.url, "http://localhost").pathname);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const session: Session = { ...base, permissions };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={session}>
        <Probe />
      </SessionProvider>
    </ApiClientProvider>,
  );
  // The members read (when issued) sits between care-team and care-plan in the same effect, so seeing
  // care-plan proves the effect ran past it: a later "not requested" assertion cannot pass vacuously.
  await waitFor(() => expect(gets).toContain(`/api/v1/patients/${PATIENT}/care-plan`));
  expect(gets).toContain(`/api/v1/patients/${PATIENT}/care-team`);
  return gets;
}

describe("usePatientChartData staff roster read", () => {
  it("does not request org members for a clinician without member.manage", async () => {
    const gets = await pathsFetched(["patient.read"]);
    expect(gets).not.toContain(`/api/v1/orgs/${ORG}/members`);
  });

  it("requests org members when the user holds member.manage", async () => {
    const gets = await pathsFetched(["patient.read", "member.manage"]);
    await waitFor(() => expect(gets).toContain(`/api/v1/orgs/${ORG}/members`));
  });
});
