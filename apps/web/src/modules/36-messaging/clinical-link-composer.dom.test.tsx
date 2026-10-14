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

function mount(
  kind: string,
  subjectId: string | null,
  flag: boolean,
  refuseLinks = false,
  secondChannel = false,
) {
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
      return Promise.resolve({
        data: {
          channels: [
            channel(kind, subjectId),
            ...(secondChannel
              ? [{ ...channel(kind, subjectId), channelId: "ch-2", title: "Other" }]
              : []),
          ],
        },
        error: undefined,
      });
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
    // A record was chosen, so the symbol stays consumed.
    expect(box.value).toBe("see ");
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

  async function pickMedication() {
    await screen.findByRole("combobox", { name: "Choose a record type" });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await screen.findByRole("option", { name: /Morphine 5 mg/ });
    await userEvent.keyboard("{Enter}");
  }

  it("does not send, and keeps the draft and tray, when the sanitiser refuses a draft that has links", async () => {
    const { POST } = mount("care_team", PATIENT, true);
    const box = await composer();
    typeAt(box, "see ");
    typeAt(box, "see #");
    await pickMedication();
    const tooLong = `see ${"x".repeat(10_001)}`;
    typeAt(box, tooLong);
    fireEvent.keyDown(box, { key: "Enter" });

    expect(await screen.findByText(/Couldn't attach the linked record/)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    expect(box.value).toBe(tooLong);
    expect(screen.getByRole("list", { name: "Linked records" })).toBeTruthy();
  });

  it("says why a links-only message cannot be sent, and stops once there is text", async () => {
    mount("care_team", PATIENT, true);
    const box = await composer();
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    await pickMedication();

    expect(screen.getByText("Add a message to send these links.")).toBeTruthy();
    typeAt(box, "hi");
    expect(screen.queryByText("Add a message to send these links.")).toBeNull();
  });

  it("does not open the picker for # typed during an IME composition", async () => {
    mount("care_team", PATIENT, true);
    const box = await composer();
    typeAt(box, "see ");
    fireEvent.compositionStart(box);
    typeAt(box, "see #");

    expect(box.value).toBe("see #");
    expect(screen.queryByRole("combobox", { name: "Choose a record type" })).toBeNull();
  });

  it.each(["insertFromPaste", "insertCompositionText"])(
    "does not open the picker for a single # that arrives as %s",
    async (inputType) => {
      mount("care_team", PATIENT, true);
      const box = await composer();
      typeAt(box, "see ");
      fireEvent.input(box, {
        target: { value: "see #", selectionStart: 5, selectionEnd: 5 },
        inputType,
      });

      expect(box.value).toBe("see #");
      expect(screen.queryByRole("combobox", { name: "Choose a record type" })).toBeNull();
    },
  );

  it("opens the picker for a typed # (insertText)", async () => {
    mount("care_team", PATIENT, true);
    const box = await composer();
    typeAt(box, "see ");
    fireEvent.input(box, {
      target: { value: "see #", selectionStart: 5, selectionEnd: 5 },
      inputType: "insertText",
    });

    expect(await screen.findByRole("combobox", { name: "Choose a record type" })).toBeTruthy();
  });

  it("puts the caret back where # was typed when the picker closes", async () => {
    mount("care_team", PATIENT, true);
    const box = await composer();
    typeAt(box, "see more");
    fireEvent.change(box, { target: { value: "see #more", selectionStart: 5, selectionEnd: 5 } });
    await screen.findByRole("combobox", { name: "Choose a record type" });
    expect(box.value).toBe("see more");

    await userEvent.keyboard("{Escape}");

    // Nothing was linked, so the typed symbol comes back and the caret sits just after it.
    await waitFor(() => expect(box.value).toBe("see #more"));
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(5);
    expect(box.selectionEnd).toBe(5);
  });

  it("closes the picker when Escape is pressed on its toggle button", async () => {
    mount("care_team", PATIENT, true);
    await composer();
    const toggle = screen.getByRole("button", { name: /Link record/ });
    await userEvent.click(toggle);
    await screen.findByRole("combobox", { name: "Choose a record type" });
    toggle.focus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("combobox", { name: "Choose a record type" })).toBeNull();
  });

  it("closes the picker and starts the next one clean when the channel changes", async () => {
    mount("care_team", PATIENT, true, false, true);
    const box = await composer();
    typeAt(box, "see ");
    typeAt(box, "see #");
    await screen.findByRole("combobox", { name: "Choose a record type" });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await screen.findByRole("option", { name: /Morphine 5 mg/ });

    // A bare click (no mousedown), as a keyboard or programmatic switch would be: only the channel change can close it.
    fireEvent.click(await screen.findByText("Other"));

    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: /Find a|Choose a record type/ })).toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    expect(await screen.findByRole("combobox", { name: "Choose a record type" })).toBeTruthy();
  });
});
