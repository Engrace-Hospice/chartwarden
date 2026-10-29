import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogViewer } from "../audit-log-viewer";

afterEach(cleanup);

const ACTOR = "11111111-1111-4111-8111-111111111111";
const event = (over: Record<string, unknown>) => ({
  id: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-01-01T00:00:00Z",
  organizationId: "org-1",
  actorUserId: ACTOR,
  actorKind: "user",
  actorRole: "nurse",
  eventType: "m2.membership.revoked",
  resourceKind: "membership",
  resourceId: null,
  outcome: "success",
  severity: "info",
  before: null,
  after: null,
  context: {},
  retentionClass: "compliance",
  ...over,
});

function setup(items: unknown[]) {
  const GET = vi.fn(async () => ({
    data: { items, nextCursor: null },
    error: undefined,
    response: new Response(null, { status: 200 }),
  }));
  render(
    <ApiClientProvider client={{ GET } as unknown as ApiClient}>
      <AuditLogViewer />
    </ApiClientProvider>,
  );
  const lastQuery = () => {
    const calls = GET.mock.calls as unknown as [
      string,
      { params: { query: Record<string, unknown> } },
    ][];
    return calls[calls.length - 1]?.[1].params.query;
  };
  return { lastQuery };
}

describe("AuditLogViewer", () => {
  it("shows the actor display name and falls back to the id", async () => {
    setup([
      event({ actorName: "Nina Nurse" }),
      event({ id: "33333333-3333-4333-8333-333333333333", actorName: null }),
    ]);
    expect(await screen.findByText("Nina Nurse")).toBeTruthy();
    expect(screen.getByText(ACTOR)).toBeTruthy();
  });

  it("sends the search as a substring filter and hides read events by default", async () => {
    const { lastQuery } = setup([event({})]);
    await screen.findByText("Event ledger · 1");
    expect(lastQuery()).toMatchObject({ excludeAccessReads: "true" });

    fireEvent.change(screen.getByLabelText("Action / event type"), {
      target: { value: "revoked" },
    });
    await waitFor(() => expect(lastQuery()).toMatchObject({ eventTypeContains: "revoked" }));
    expect(lastQuery()).not.toHaveProperty("eventType");
  });

  it("lets the user show read events again", async () => {
    const { lastQuery } = setup([event({})]);
    await screen.findByText("Event ledger · 1");
    fireEvent.click(screen.getByLabelText("Hide read events"));
    await waitFor(() => expect(lastQuery()).not.toHaveProperty("excludeAccessReads"));
  });
});
