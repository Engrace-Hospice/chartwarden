import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary } from "./messaging-types";

// WP 2.11 visual defect D1: the patient header never appeared because the thread's reset effect bumped the shared
// generation after the patient fetch had captured it, so every patient reply was dropped as stale.
const PATIENT_PATH = "/api/v1/patients/{id}";

const careTeam = (channelId: string, subjectId: string): ChannelSummary => ({
  channelId,
  kind: "care_team",
  title: "Care team",
  subjectId,
  archivedAt: null,
  unreadCount: 0,
  mentionCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});

function tree(api: unknown, channel: ChannelSummary) {
  return (
    <MemoryRouter>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <ConversationThread
          channel={channel}
          meId="me"
          meDisplayName="Me"
          onBack={() => {}}
          onReadConfirmed={() => {}}
          onMessageSent={() => {}}
          onAccessRevoked={() => {}}
        />
      </ApiClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("care-team patient header", () => {
  it("shows the patient MRN and the context toggle once the patient reply lands", async () => {
    const api = {
      GET: vi.fn((path: string) =>
        Promise.resolve(
          path === PATIENT_PATH
            ? { data: { id: "p-1", firstName: "Margaret", lastName: "Brandt", mrn: "MRN-77" } }
            : { data: { messages: [] } },
        ),
      ),
      POST: vi.fn(),
    };
    render(tree(api, careTeam("c-1", "p-1")));
    expect(await screen.findByText("MRN-77")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Patient context/ })).toBeTruthy();
  });

  it("drops a late patient reply that lands after a real channel switch", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    const api = {
      GET: vi.fn((path: string, init: { params?: { path?: { id?: string } } }) => {
        if (path !== PATIENT_PATH) return Promise.resolve({ data: { messages: [] } });
        if (init.params?.path?.id === "p-1") {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          data: { id: "p-2", firstName: "Second", lastName: "Patient", mrn: "MRN-2" },
        });
      }),
      POST: vi.fn(),
    };
    const { rerender } = render(tree(api, careTeam("c-1", "p-1")));
    await waitFor(() => expect(api.GET).toHaveBeenCalledWith(PATIENT_PATH, expect.anything()));
    rerender(tree(api, careTeam("c-2", "p-2")));
    expect(await screen.findByText("MRN-2")).toBeTruthy();
    resolveFirst({ data: { id: "p-1", firstName: "Margaret", lastName: "Brandt", mrn: "MRN-1" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("MRN-1")).toBeNull();
    expect(screen.getByText("MRN-2")).toBeTruthy();
  });

  it("keeps the header across a rerender that only changes callback identities", async () => {
    const api = {
      GET: vi.fn((path: string) =>
        Promise.resolve(
          path === PATIENT_PATH
            ? { data: { id: "p-1", firstName: "Margaret", lastName: "Brandt", mrn: "MRN-77" } }
            : { data: { messages: [] } },
        ),
      ),
      POST: vi.fn(),
    };
    const { rerender } = render(tree(api, careTeam("c-1", "p-1")));
    await screen.findByText("MRN-77");
    const patientCalls = api.GET.mock.calls.filter(([p]) => p === PATIENT_PATH).length;
    rerender(tree(api, careTeam("c-1", "p-1")));
    expect(screen.getByText("MRN-77")).toBeTruthy();
    expect(api.GET.mock.calls.filter(([p]) => p === PATIENT_PATH).length).toBe(patientCalls);
  });

  it("clears the header when the same channel stops being a care-team channel", async () => {
    const api = {
      GET: vi.fn((path: string) =>
        Promise.resolve(
          path === PATIENT_PATH
            ? { data: { id: "p-1", firstName: "Margaret", lastName: "Brandt", mrn: "MRN-77" } }
            : { data: { messages: [] } },
        ),
      ),
      POST: vi.fn(),
    };
    const { rerender } = render(tree(api, careTeam("c-1", "p-1")));
    await screen.findByText("MRN-77");
    rerender(tree(api, { ...careTeam("c-1", "p-1"), kind: "dm", subjectId: null }));
    await waitFor(() => expect(screen.queryByText("MRN-77")).toBeNull());
  });

  it("survives a rejected patient request without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const api = {
      GET: vi.fn((path: string) =>
        path === PATIENT_PATH
          ? Promise.reject(new Error("network down"))
          : Promise.resolve({ data: { messages: [] } }),
      ),
      POST: vi.fn(),
    };
    render(tree(api, careTeam("c-1", "p-1")));
    await new Promise((r) => setTimeout(r, 30));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(screen.queryByText(/^MRN/)).toBeNull();
  });
});
