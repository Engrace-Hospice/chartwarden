// ADR-0109 D10 (PR 3) — the group edit dialog compares the meeting link against what the reader saw when the dialog OPENED, so a late reload of
// the group (write responses and non-facilitator reads carry no plaintext link) never reads as "the link was cleared" and wipes the stored one.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroupFormModal } from "./group-form-modal";

const LINK = "https://meet.example.org/thursday-circle";
const group = (over: Record<string, unknown> = {}) => ({
  groupId: "11111111-1111-4111-8111-111111111111",
  name: "Thursday morning circle",
  description: null,
  format: "drop_in",
  modality: "virtual",
  enrollmentRequired: true,
  facilitatorKind: "staff",
  facilitatorUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  coFacilitatorUserId: null,
  capacity: 10,
  status: "open",
  recurrence: null,
  timezone: "America/Chicago",
  venueText: null,
  hasJoinUrl: true,
  enrolledCount: 0,
  nextSessionAt: null,
  openedAt: "2026-09-20T00:00:00.000Z",
  closedAt: null,
  version: 5,
  createdAt: "2026-09-01T00:00:00.000Z",
  joinUrl: LINK,
  ...over,
});

describe("group edit dialog — the meeting link", () => {
  it("a late reload that reveals the link does not make Save send a clearing null for the untouched field", async () => {
    const bodies: unknown[] = [];
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input);
      if (req.method === "PATCH") bodies.push(JSON.parse(await req.clone().text()));
      return new Response(JSON.stringify(group({ version: 6, joinUrl: null })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createApiClient({ baseUrl: "http://localhost", fetch: stub });
    const ui = (g: ReturnType<typeof group>) => (
      <ApiClientProvider client={client}>
        <GroupFormModal group={g as never} onClose={() => undefined} onSaved={() => undefined} />
      </ApiClientProvider>
    );
    // opened while the link is not shown (hasJoinUrl only)...
    const { rerender } = render(ui(group({ joinUrl: null })));
    // ...then a late reload delivers the plaintext link: the untouched (blank) field must not be read as "clear it"
    rerender(ui(group()));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).not.toHaveProperty("joinUrl");
  });
});
