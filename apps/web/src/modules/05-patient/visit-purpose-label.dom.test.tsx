// The chart's two visit lists (Overview "Upcoming Visits" and the Clinical rail "Upcoming") show a visit's purpose
// through the one shared label table, so a recert reads "Recert Kickoff (RN)" and never "Recert" or "F2f".
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { ClinicalRail, useClinicalData } from "./patient-clinical";
import { OverviewTab, type PatientSummary, usePatientChartData } from "./patient-overview";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "org-1";
const session: Session = {
  userId: "u1",
  organizationId: ORG,
  displayName: "Nora",
  permissions: ["patient.read"],
};
const patient = { id: PATIENT, organizationId: ORG } as unknown as PatientSummary;

const visit = (id: string, visitPurpose: string, startsAt: string) => ({
  id,
  assignedMembershipId: "m1",
  visitPurpose,
  scheduledStartedAt: startsAt,
  status: "scheduled",
});

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const { pathname } = new URL(req.url, "http://localhost");
  const body =
    pathname === "/api/v1/visits"
      ? [
          visit("v1", "recert", "2030-01-01T15:00:00.000Z"),
          visit("v2", "f2f", "2030-01-02T15:00:00.000Z"),
        ]
      : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mount(children: JSX.Element): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

function OverviewHarness(): JSX.Element {
  const data = usePatientChartData(patient);
  return <OverviewTab patient={patient} data={data} />;
}

function RailHarness(): JSX.Element {
  const data = usePatientChartData(patient);
  const clinical = useClinicalData(PATIENT, data, false);
  return <ClinicalRail patient={patient} data={data} clinical={clinical} />;
}

describe("chart visit purpose labels", () => {
  it.each([
    ["the Overview Upcoming Visits table", OverviewHarness],
    ["the Clinical rail Upcoming list", RailHarness],
  ])("shows the shared purpose wording in %s", async (_site, Harness) => {
    mount(<Harness />);

    expect((await screen.findAllByText("Recert Kickoff (RN)")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Face-to-Face")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Recert$/)).toBeNull();
    expect(screen.queryByText(/^F2f$/i)).toBeNull();
  });
});
