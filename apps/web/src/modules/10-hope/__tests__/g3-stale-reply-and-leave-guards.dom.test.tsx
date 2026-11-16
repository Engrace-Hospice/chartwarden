// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeDashboard } from "../hope-dashboard";
import { HqrpComplianceDashboard } from "../hqrp-compliance-dashboard";
import { SubmissionWorklist } from "../submission-worklist";
import { useHopeRecordActions } from "../use-hope-record-actions";
import { SESSION, ok } from "./workspace-test-kit";

// Group g3: guards that no test used to need. Each case is mutation-checked: with the guard it names deleted from a copy of the
// component, the case fails (and it passes with the guard).
//   - the "latest read wins" check of three list screens, whose late reply of a replaced read must not overwrite the newer one;
//   - the HUV completion date's re-read, which must not run on a record screen the clinician has already left.

afterEach(cleanup);

const emptyFailure = () => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status: 502 }),
});

const SESSION_FOR_LISTS = {
  userId: "u",
  organizationId: "o",
  membershipId: "m",
  roles: [],
  permissions: [],
  isAdmin: false,
};

const tree = (client: ApiClient, screenElement: ReactNode) => (
  <ApiClientProvider client={client}>
    <SessionProvider session={SESSION_FOR_LISTS}>
      <ToastProvider>
        <MemoryRouter>{screenElement}</MemoryRouter>
      </ToastProvider>
    </SessionProvider>
  </ApiClientProvider>
);

const SCHEDULE = {
  id: "cccccccc-3333-4333-8333-cccccccccccc",
  patientId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  admissionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  rfaKind: "02_huv1",
  status: "open",
  windowOpensAt: "2000-01-01T00:00:00.000Z",
  windowClosesAt: "2999-01-01T00:00:00.000Z",
  lateDeadlineAt: "2999-02-01T00:00:00.000Z",
};
const COUNTS = { onTime: 9, total: 10, accepted: 9 };
const COMPLIANCE = {
  providerEntityId: null,
  hopeOnTimeRate: 0.9,
  hopeOnTimeCounts: COUNTS,
  sfvOnTimeRate: 0.9,
  sfvOnTimeCounts: COUNTS,
  submissionAcceptanceRate: 0.9,
  submissionAcceptanceCounts: COUNTS,
};
const SUBMISSION = {
  id: "33333333-cccc-4ccc-8ccc-333333333333",
  providerEntityId: "pe-1",
  submissionPeriod: "2026-Q3",
  status: "packaged",
  itemCount: 1,
  acceptedCount: 0,
  rejectedCount: 0,
  transmittedAt: null,
};

interface ListScreen {
  readonly name: string;
  readonly element: ReactNode;
  readonly path: string;
  /** What the newer read answers with. */
  readonly answer: unknown;
  /** Text only the newer read's answer puts on screen. */
  readonly shown: () => Promise<unknown>;
  /** The title of the screen's failed state. */
  readonly failedTitle: string;
}

const SCREENS: ListScreen[] = [
  {
    name: "the HOPE schedule worklist",
    element: <HopeDashboard />,
    path: "/api/v1/hope/schedules",
    answer: { schedules: [SCHEDULE] },
    shown: () => screen.findByText("Lovelace, Ada"),
    failedTitle: "HOPE schedules could not be loaded",
  },
  {
    name: "the HQRP compliance dashboard",
    element: <HqrpComplianceDashboard />,
    path: "/api/v1/hope/dashboard/compliance",
    answer: COMPLIANCE,
    shown: () => screen.findAllByText("HOPE on-time"), // the metric card and its table row
    failedTitle: "The HQRP compliance dashboard could not be loaded",
  },
  {
    name: "the submission worklist",
    element: <SubmissionWorklist />,
    path: "/api/v1/hope/submissions",
    answer: { submissions: [SUBMISSION] },
    shown: () => screen.findByText(SUBMISSION.id.slice(0, 8), { exact: false }),
    failedTitle: "HOPE submissions could not be loaded",
  },
];

/** A client that answers `path` as `reply` says (anything else, a patient's name). */
const clientAnswering = (path: string, reply: () => Promise<unknown>): ApiClient =>
  ({
    GET: vi.fn((requested: string) =>
      requested === path
        ? reply()
        : Promise.resolve(ok({ id: SCHEDULE.patientId, firstName: "Ada", lastName: "Lovelace" })),
    ),
  }) as unknown as ApiClient;

describe("a read the screen has since replaced answers late", () => {
  it.each(SCREENS)(
    "does not let a late failure replace what the newer read of $name found",
    async ({ element, path, answer, shown, failedTitle }) => {
      let failFirst: (reply: unknown) => void = () => undefined;
      const first = clientAnswering(
        path,
        () =>
          new Promise((resolve) => {
            failFirst = resolve;
          }),
      );
      const second = clientAnswering(path, async () => ok(answer));
      const view = render(tree(first, element));
      await waitFor(() => expect(first.GET).toHaveBeenCalledWith(path, expect.anything()));

      // A new client restarts the read (the first read is still out).
      view.rerender(tree(second, element));
      await shown();

      await act(async () => {
        failFirst(emptyFailure());
      });

      expect(screen.queryByText(failedTitle)).toBeNull();
      await shown();
    },
  );
});

const DRAFT = {
  status: "draft",
  version: 7,
  targetDate: "2026-09-08T00:00:00.000Z",
  rfaKind: "02_huv1",
  patientId: "patient-1",
};
const reply = (status: number, error?: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});

describe("a HUV completion date answered after the clinician has left the record", () => {
  function setup(patch: () => Promise<unknown>) {
    const refresh = vi.fn(async () => true);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider session={SESSION}>{children}</SessionProvider>
    );
    const hook = renderHook(
      () =>
        useHopeRecordActions({
          api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(patch) } as never,
          client: {} as ApiClient,
          id: "hope-1",
          assessment: DRAFT,
          workspaceVersion: 7,
          timeline: [],
          setTimeline: vi.fn(),
          refresh,
          setSaving: vi.fn(),
          closeInactivation: vi.fn(),
          navigate: vi.fn(),
        }),
      { wrapper },
    );
    return { ...hook, refresh };
  }

  it.each([
    ["saved", () => ok({ assessmentId: "hope-1", z0350: "2026-09-10" })],
    [
      "refused as stale",
      () => reply(409, { error: { code: "M10_VERSION_CONFLICT", message: "Changed." } }),
    ],
  ])("re-reads when it was %s and the clinician is still there", async (_name, answer) => {
    const { result, refresh } = setup(async () => answer());

    await act(() => result.current.setHuvCompletionDate("2026-09-10"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["saved", () => ok({ assessmentId: "hope-1", z0350: "2026-09-10" })],
    [
      "refused as stale",
      () => reply(409, { error: { code: "M10_VERSION_CONFLICT", message: "Changed." } }),
    ],
  ])("does not re-read a screen that is gone when it was %s", async (_name, answer) => {
    let release: (value: unknown) => void = () => undefined;
    const { result, unmount, refresh } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.setHuvCompletionDate("2026-09-10");
    });
    unmount();
    await act(async () => {
      release(answer());
      await saving;
    });

    expect(refresh).not.toHaveBeenCalled();
  });
});
