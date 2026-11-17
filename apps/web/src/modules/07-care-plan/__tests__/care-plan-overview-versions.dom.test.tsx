import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Version } from "../care-plan-api";
import { CarePlanVersionHistory } from "../version-history";

afterEach(cleanup);

function snapshotWith(problem: string): unknown {
  return {
    problems: [{ id: `p-${problem}`, description: problem, kind: "terminal", status: "active" }],
    goals: [],
    interventions: [],
  };
}

function version(sequence: number, overrides: Partial<Version> = {}): Version {
  return {
    id: `version-${sequence}`,
    planId: "plan-1",
    sequence,
    kind: sequence === 1 ? "initial" : "idg_review",
    status: "signed",
    idgMeetingId: null,
    requiredSignerSet: [{ role: "rn_case_manager", count: 1 }],
    signatures: [{ signerRole: "rn_case_manager", signedAt: "2026-08-01T12:00:00.000Z" }],
    draftedAt: "2026-08-01T10:00:00.000Z",
    signedAt: "2026-08-01T12:05:00.000Z",
    supersededAt: null,
    stateSnapshot: snapshotWith(`Problem of v${sequence}`),
    version: 1,
    ...overrides,
  };
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function failed(status: number) {
  return { data: undefined, error: { status }, response: new Response(null, { status }) };
}

type DetailResolver = (id: string) => Promise<unknown>;

function clientFor(items: Version[], detail: DetailResolver = async () => failed(500)): ApiClient {
  return {
    GET: vi.fn(async (path: string, init?: { params?: { path?: { versionId?: string } } }) => {
      if (path === "/api/v1/care-plans/{planId}/versions") return ok({ items, nextCursor: null });
      if (path === "/api/v1/care-plans/{planId}/versions/{versionId}")
        return detail(init?.params?.path?.versionId ?? "");
      return ok({});
    }),
  } as unknown as ApiClient;
}

function detailCalls(client: ApiClient): number {
  const get = client.GET as unknown as ReturnType<typeof vi.fn>;
  return get.mock.calls.filter(
    ([path]) => path === "/api/v1/care-plans/{planId}/versions/{versionId}",
  ).length;
}

function LocationProbe(): null {
  const { pathname } = useLocation();
  (globalThis as { __probe?: string }).__probe = pathname;
  return null;
}
const currentPath = (): string | undefined => (globalThis as { __probe?: string }).__probe;

function renderHistory(client: ApiClient, entry = "/care-plans/plan-1/versions"): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ApiClientProvider client={client}>
        <LocationProbe />
        <Routes>
          <Route path="/care-plans/:planId/versions" element={<CarePlanVersionHistory />} />
          <Route
            path="/care-plans/:planId/versions/:versionId"
            element={<CarePlanVersionHistory />}
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const versionButton = (sequence: number): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^v${sequence} `) });

describe("Care Plan version history selection", () => {
  it("selects the latest version when the URL names none", async () => {
    renderHistory(clientFor([version(1), version(2)]));

    expect(await screen.findByText(/Problem of v2/)).toBeTruthy();
    expect(versionButton(2).getAttribute("aria-current")).toBe("true");
    expect(versionButton(1).getAttribute("aria-current")).toBeNull();
  });

  it("shows not-found, not the latest version, when the :versionId names no version", async () => {
    renderHistory(clientFor([version(1), version(2)]), "/care-plans/plan-1/versions/no-such");

    expect(await screen.findByText("Version not found")).toBeTruthy();
    expect(screen.queryByText(/Problem of v2/)).toBeNull();
    expect(versionButton(2).getAttribute("aria-current")).toBeNull();
  });

  it("puts the selection in the URL and serves it from the list without refetching", async () => {
    const client = clientFor([version(1), version(2)]);
    renderHistory(client);
    await screen.findByText(/Problem of v2/);

    fireEvent.click(versionButton(1));

    expect(await screen.findByText(/Problem of v1/)).toBeTruthy();
    expect(currentPath()).toBe("/care-plans/plan-1/versions/version-1");
    expect(versionButton(1).getAttribute("aria-current")).toBe("true");
    expect(detailCalls(client)).toBe(0);
  });

  it("fetches a version whose list entry carries no snapshot", async () => {
    const bare = version(1, { stateSnapshot: undefined });
    const client = clientFor([bare, version(2)], async () =>
      ok({ ...bare, stateSnapshot: snapshotWith("Fetched problem") }),
    );
    renderHistory(client);
    await screen.findByText(/Problem of v2/);

    fireEvent.click(versionButton(1));

    expect(await screen.findByText(/Fetched problem/)).toBeTruthy();
    expect(detailCalls(client)).toBe(1);
  });

  it("clears a failed detail load once another version is selected", async () => {
    const bare = version(1, { stateSnapshot: undefined });
    renderHistory(clientFor([bare, version(2)]));
    await screen.findByText(/Problem of v2/);

    fireEvent.click(versionButton(1));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();

    fireEvent.click(versionButton(2));

    expect(await screen.findByText(/Problem of v2/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the last-clicked version when an earlier, slower detail load finishes after it", async () => {
    const slow = version(1, { stateSnapshot: undefined });
    const quick = version(2, { stateSnapshot: undefined });
    let finishSlow: (value: unknown) => void = () => undefined;
    const client = clientFor([slow, quick, version(3)], (id) =>
      id === slow.id
        ? new Promise((resolve) => {
            finishSlow = resolve;
          })
        : Promise.resolve(ok({ ...quick, stateSnapshot: snapshotWith("Quick problem") })),
    );
    renderHistory(client);
    await screen.findByText(/Problem of v3/);

    fireEvent.click(versionButton(1));
    fireEvent.click(versionButton(2));
    await screen.findByText(/Quick problem/);
    finishSlow(ok({ ...slow, stateSnapshot: snapshotWith("Slow problem") }));

    await waitFor(() => expect(detailCalls(client)).toBe(2));
    expect(screen.getByText(/Quick problem/)).toBeTruthy();
    expect(screen.queryByText(/Slow problem/)).toBeNull();
  });
});

describe("Care Plan version history signer slots", () => {
  it("names each role of a union slot readably", async () => {
    const union = version(1, {
      requiredSignerSet: [
        { role: "rn_case_manager|msw", count: 1 },
        { role: "hospice_physician|nurse_practitioner", count: 1 },
      ],
      signatures: [],
    });
    renderHistory(clientFor([union]));

    expect(await screen.findByText(/RN Case Manager or MSW · 0 of 1/)).toBeTruthy();
    expect(screen.getByText(/Hospice Physician or Nurse Practitioner · 0 of 1/)).toBeTruthy();
    expect(screen.queryByText(/rn_case_manager\|msw/)).toBeNull();
  });
});

describe("Care Plan version history snapshot", () => {
  it("names an intervention's discipline readably instead of its raw id", async () => {
    const withIntervention = version(1, {
      stateSnapshot: {
        problems: [],
        goals: [],
        interventions: [
          {
            id: "i-1",
            scopeText: "Bathing help",
            discipline: "chha",
            frequencyText: "Daily",
            status: "active",
          },
          {
            id: "i-2",
            scopeText: "Medication review",
            discipline: "md_np",
            frequencyText: "Weekly",
            status: "active",
          },
        ],
      },
    });
    renderHistory(clientFor([withIntervention]));

    expect(await screen.findByText(/Bathing help · HHA · Daily/)).toBeTruthy();
    expect(screen.getByText(/Medication review · Medical · Weekly/)).toBeTruthy();
  });
});
