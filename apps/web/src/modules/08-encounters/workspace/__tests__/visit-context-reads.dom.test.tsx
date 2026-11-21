// Workflow 09, WP1 — what the visit context reads, and when. A clinician the note-closure gate blocks is refused the staff list (the
// route is not on the gate's allowlist; the visit read is), so the header must not ask for it, and a visit that changed or went away
// before its read came back must not show another visit's answer. Synthetic data only.
import { ApiClientProvider } from "@chartwarden/ui";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NoteClosureProvider, useNoteClosure } from "../../../../shell/note-closure";
import { type Session, SessionProvider } from "../../../../shell/session";
import { useVisitContext } from "../use-visit-context";
import { VisitContextHeader } from "../visit-context-header";

const CLOSURE = "/api/v1/encounters/closure-status";
const VISIT = "/api/v1/visits/{visitId}";
const STAFF = "/api/v1/scheduling/staff";

const author: Session = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Test User",
  organizationName: "Test Organization",
  roles: ["rn"],
  isAdmin: false,
  permissions: ["encounter.author"],
};

/** Cannot author, so cannot be closure-blocked: its header reads the staff list without waiting for a closure answer. */
const reader: Session = { ...author, permissions: [] };

const visitBody = (id: string, assignedMembershipId: string) => ({
  id,
  scheduledStartedAt: "2026-08-31T14:00:00.000Z",
  scheduledEndedAt: "2026-08-31T15:00:00.000Z",
  assignedMembershipId,
});

const STAFF_LIST = [
  { membershipId: "mem-1", displayName: "Nora Nurse" },
  { membershipId: "mem-2", displayName: "Sam Sage" },
];

const encounter = {
  id: "enc-1",
  patientId: "patient-1",
  visitId: "visit-1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status: "draft",
  lateEntryTier: "normal",
};

function closureAnswer(verdict: "blocked" | "clear") {
  return {
    mode: "block",
    thresholdHours: 24,
    verdict,
    stage: verdict === "blocked" ? "overdue" : "ok",
    encounterId: null,
    patientId: null,
    encounterStatus: null,
    deadlineAt: null,
    hoursOverdue: 0,
    overdueCount: verdict === "blocked" ? 1 : 0,
    overrideExpiresAt: null,
  };
}

/** Renders its children once the closure status has answered, as the app does by the time a record opens. */
function AfterClosureAnswer({ children }: { children: ReactNode }): JSX.Element | null {
  return useNoteClosure().status === null ? null : <>{children}</>;
}

function mountHeader(verdict: "blocked" | "clear") {
  const GET = vi.fn(async (path: string) => {
    if (path === CLOSURE) return { data: closureAnswer(verdict), response: new Response() };
    if (path === VISIT) return { data: visitBody("visit-1", "mem-1") };
    if (path === STAFF) return { data: STAFF_LIST };
    return { data: null };
  });
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET } as never}>
        <SessionProvider session={author}>
          <NoteClosureProvider>
            <AfterClosureAnswer>
              <VisitContextHeader screen="record" encounter={encounter} canAuthor />
            </AfterClosureAnswer>
          </NoteClosureProvider>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  const paths = () => GET.mock.calls.map(([path]) => path);
  return { paths };
}

describe("while the clinician is blocked by the note-closure gate", () => {
  it("asks for the visit but never for the staff list, and shows the visit without the clinician's name", async () => {
    const { paths } = mountHeader("blocked");
    await waitFor(() => expect(paths()).toContain(VISIT));
    await screen.findByRole("link", { name: "Open visit" });
    expect(paths()).not.toContain(STAFF);
    expect(screen.queryByText("Nora Nurse")).toBeNull();
    // Only the status poll and the visit read were made: nothing the gate refuses, so nothing to trigger a closure re-read.
    expect(paths().every((path) => path === CLOSURE || path === VISIT)).toBe(true);
  });

  it("names the clinician when the clinician is not blocked", async () => {
    const { paths } = mountHeader("clear");
    expect(await screen.findByText("Nora Nurse")).toBeTruthy();
    expect(paths()).toContain(STAFF);
  });
});

describe("an author whose first closure answer has not arrived yet", () => {
  function mountHook(closure: Promise<unknown>) {
    const GET = vi.fn(async (path: string) => {
      if (path === CLOSURE) return closure;
      if (path === VISIT) return { data: visitBody("visit-1", "mem-1") };
      if (path === STAFF) return { data: STAFF_LIST };
      return { data: null };
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider client={{ GET } as never}>
        <SessionProvider session={author}>
          <NoteClosureProvider>{children}</NoteClosureProvider>
        </SessionProvider>
      </ApiClientProvider>
    );
    const view = renderHook(() => useVisitContext("visit-1"), { wrapper });
    return { ...view, paths: () => GET.mock.calls.map(([path]) => path) };
  }

  const held = () => {
    let release: (answer: unknown) => void = () => undefined;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  it("does not ask for the staff list before the answer: a blocked clinician must never be refused it on a cold load", async () => {
    const { promise, release } = held();
    const { result, paths } = mountHook(promise);
    await waitFor(() => expect(paths()).toContain(CLOSURE));
    await act(async () => {
      await Promise.resolve();
    });
    expect(paths()).not.toContain(STAFF);

    await act(async () => {
      release({ data: closureAnswer("blocked"), response: new Response() });
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(paths()).not.toContain(STAFF);
    expect(result.current?.clinicianName).toBeNull();
  });

  it("reads the staff list once the answer says the clinician is not blocked", async () => {
    const { promise, release } = held();
    const { result, paths } = mountHook(promise);
    await waitFor(() => expect(paths()).toContain(CLOSURE));
    expect(paths()).not.toContain(STAFF);

    await act(async () => {
      release({ data: closureAnswer("clear"), response: new Response() });
    });
    await waitFor(() => expect(result.current?.clinicianName).toBe("Nora Nurse"));
    expect(paths()).toContain(STAFF);
  });
});

describe("a visit that changed before its read came back", () => {
  function clientWithHeldFirstVisit() {
    let release: (value: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const GET = vi.fn(async (path: string, init?: { params?: { path?: { visitId?: string } } }) => {
      if (path === STAFF) return { data: STAFF_LIST };
      if (path !== VISIT) return { data: null };
      const id = init?.params?.path?.visitId;
      if (id === "visit-1") return held;
      return { data: visitBody("visit-2", "mem-2") };
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider client={{ GET } as never}>
        <SessionProvider session={reader}>{children}</SessionProvider>
      </ApiClientProvider>
    );
    return { wrapper, releaseFirst: () => release({ data: visitBody("visit-1", "mem-1") }) };
  }

  it("shows nothing of the first visit under the second, and the first one's late answer does not replace the second's", async () => {
    const { wrapper, releaseFirst } = clientWithHeldFirstVisit();
    const { result, rerender } = renderHook(({ id }) => useVisitContext(id), {
      wrapper,
      initialProps: { id: "visit-1" },
    });
    expect(result.current).toBeNull();

    rerender({ id: "visit-2" });
    await waitFor(() => expect(result.current?.clinicianName).toBe("Sam Sage"));

    await act(async () => {
      releaseFirst();
      await Promise.resolve();
    });
    expect(result.current?.clinicianName).toBe("Sam Sage");
  });

  it("does not hand a visit's answer to the next visit while that one is still being read", async () => {
    const GET = vi.fn(async (path: string, init?: { params?: { path?: { visitId?: string } } }) => {
      if (path === STAFF) return { data: STAFF_LIST };
      if (init?.params?.path?.visitId === "visit-2") return new Promise(() => undefined);
      return { data: visitBody("visit-1", "mem-1") };
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider client={{ GET } as never}>
        <SessionProvider session={reader}>{children}</SessionProvider>
      </ApiClientProvider>
    );
    const { result, rerender } = renderHook(({ id }) => useVisitContext(id), {
      wrapper,
      initialProps: { id: "visit-1" },
    });
    await waitFor(() => expect(result.current?.clinicianName).toBe("Nora Nurse"));

    rerender({ id: "visit-2" });
    expect(result.current).toBeNull();
  });

  it("reads nothing, and shows nothing, once the visit id goes away (a PRN encounter)", async () => {
    const { wrapper } = clientWithHeldFirstVisit();
    const { result, rerender } = renderHook(({ id }) => useVisitContext(id), {
      wrapper,
      initialProps: { id: "visit-2" as string | null },
    });
    await waitFor(() => expect(result.current?.clinicianName).toBe("Sam Sage"));
    rerender({ id: null });
    expect(result.current).toBeNull();
  });
});
