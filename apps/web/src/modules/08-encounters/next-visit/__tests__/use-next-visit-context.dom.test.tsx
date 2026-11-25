// @vitest-environment jsdom
// What the Plan and Next Visit section reads about the patient: this visit's proposals are read once, and again only when a save in the
// plan-of-care step has ENDED (a read made while it saves would be stale, and each save used to cost two reads). Synthetic ids only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { renderHook, waitFor } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type Call, makeFetch } from "../../__tests__/closure-test-harness";
import { useNextVisitContext } from "../use-next-visit-context";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PROPOSALS_PATH = `/api/v1/patients/${PATIENT}/care-plan-change-proposals`;

let calls: Call[] = [];
const proposalReads = (): Call[] => calls.filter((c) => c.path === PROPOSALS_PATH);

function mountHook(initialBusy: boolean) {
  calls = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(
      {
        "GET /api/v1/visits": () => ({ body: [] }),
        [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: { carePlan: null } }),
        [`GET ${PROPOSALS_PATH}`]: () => ({
          body: { patientId: PATIENT, proposals: [], redacted: false },
        }),
      },
      calls,
    ),
  });
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  return renderHook(
    ({ busy }: { busy: boolean }) => useNextVisitContext(PATIENT, ENCOUNTER, busy, true),
    { wrapper, initialProps: { busy: initialBusy } },
  );
}

afterEach(() => {
  calls = [];
});

describe("useNextVisitContext proposals", () => {
  it("reads them once when the plan-of-care step is idle", async () => {
    const view = mountHook(false);
    await waitFor(() => expect(view.result.current.proposals.status).toBe("ready"));

    expect(proposalReads()).toHaveLength(1);
  });

  it("does not read them while a plan-of-care save starts, and reads them once when it ends", async () => {
    const view = mountHook(false);
    await waitFor(() => expect(view.result.current.proposals.status).toBe("ready"));

    view.rerender({ busy: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(proposalReads()).toHaveLength(1);

    view.rerender({ busy: false });
    await waitFor(() => expect(proposalReads()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(proposalReads()).toHaveLength(2);
  });

  it("reads again after each later save, one read per save", async () => {
    const view = mountHook(false);
    await waitFor(() => expect(proposalReads()).toHaveLength(1));

    view.rerender({ busy: true });
    view.rerender({ busy: false });
    await waitFor(() => expect(proposalReads()).toHaveLength(2));
    view.rerender({ busy: true });
    view.rerender({ busy: false });
    await waitFor(() => expect(proposalReads()).toHaveLength(3));
  });
});
