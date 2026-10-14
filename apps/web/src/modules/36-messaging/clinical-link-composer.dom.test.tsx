// WP 3.2: the link picker inside the real thread composer. `#` swaps itself for the picker, the chosen record is sent as a
// clinicalLink node (ids only), and a conversation without a patient scope, or a tenant with the flag off, gets no picker.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { CLINICAL_LINKS_FLAG_KEY } from "./clinical-link-kinds";
import { StaffMessaging } from "./staff-messaging";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const PATIENT = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const channel = (kind: string, subjectId: string | null) => ({
  channelId: "ch-1",
  kind,
  title: "Team",
  subjectId,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});

function mount(kind: string, subjectId: string | null, flag: boolean, refuseLinks = false) {
  const POST = vi.fn(() =>
    refuseLinks
      ? Promise.resolve({
          data: undefined,
          error: { error: { code: "CLINICAL_LINK_NOT_AVAILABLE", message: "link not available" } },
          response: { status: 422 },
        })
      : Promise.resolve({
          data: { messageId: "m-1", channelId: "ch-1", createdAt: "2026-10-10T10:00:00.000Z" },
          error: undefined,
        }),
  );
  const GET = vi.fn((path: string) => {
    if (path === "/api/v1/messaging/channels")
      return Promise.resolve({ data: { channels: [channel(kind, subjectId)] }, error: undefined });
    if (path === "/api/v1/medication-orders")
      return Promise.resolve({
        data: { orders: [{ id: ORDER, drugName: "Morphine", strength: "5 mg", status: "active" }] },
      });
    if (path === "/api/v1/patients/{id}")
      return Promise.resolve({ data: undefined, error: {}, response: { status: 404 } });
    return Promise.resolve({ data: { messages: [] }, error: undefined });
  });
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <FeatureFlagProvider flags={{ [CLINICAL_LINKS_FLAG_KEY]: flag }}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </FeatureFlagProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { POST, GET };
}

const composer = async () =>
  (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
function typeAt(box: HTMLTextAreaElement, value: string) {
  fireEvent.change(box, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
}

describe("link picker in the composer", () => {
  it("opens on #, removes the symbol, and sends the chosen record as a clinicalLink node", async () => {
    const { POST, GET } = mount("care_team", PATIENT, true);
    const box = await composer();
    typeAt(box, "see ");
    typeAt(box, "see #");

    const kindBox = await screen.findByRole("combobox", { name: "Choose a record type" });
    expect(box.value).toBe("see ");
    // Kinds: assessment, medication, care plan (the default source's enabled set).
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await screen.findByRole("option", { name: /Morphine 5 mg/ });
    expect(kindBox).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(box);
    typeAt(box, "see this");
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(POST).toHaveBeenCalled());
    const [, init] = POST.mock.calls[0] as unknown as [
      string,
      { body: { bodyDoc: { doc: { content: unknown[] } } } },
    ];
    expect(init.body.bodyDoc.doc.content.at(-1)).toEqual({
      type: "paragraph",
      content: [{ type: "clinicalLink", kind: "medication", entityId: ORDER }],
    });
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/medication-orders",
      expect.objectContaining({ params: { query: { patientId: PATIENT } } }),
    );
  });

  it("tells the sender a refused record can't be linked, without saying why", async () => {
    const { POST } = mount("care_team", PATIENT, true, true);
    const box = await composer();
    typeAt(box, "see ");
    typeAt(box, "see #");
    await screen.findByRole("combobox", { name: "Choose a record type" });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await screen.findByRole("option", { name: /Morphine 5 mg/ });
    await userEvent.keyboard("{Enter}");
    typeAt(box, "see this");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(await screen.findByText("That record can't be linked.")).toBeTruthy();
  });

  it("leaves # as ordinary text when the tenant flag is off, and shows no button", async () => {
    mount("care_team", PATIENT, false);
    const box = await composer();
    typeAt(box, "#");

    expect(box.value).toBe("#");
    expect(screen.queryByRole("combobox", { name: "Choose a record type" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Link record/ })).toBeNull();
  });

  it("offers no picker in a conversation with no patient scope", async () => {
    mount("dm", null, true);
    const box = await composer();
    typeAt(box, "#");

    expect(box.value).toBe("#");
    expect(screen.queryByRole("button", { name: /Link record/ })).toBeNull();
  });
});
