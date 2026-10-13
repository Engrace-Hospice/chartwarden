// M36 WP 2.8 - the Saved replies screen (jsdom): every sender manages personal replies; the organization and platform
// sections appear only for a template manager; a refusal (PHI, required wording) is shown in place and keeps the input.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { SavedReplies } from "./saved-replies-screen";

const personal = {
  id: "m1",
  scope: "personal",
  templateKey: null,
  category: "general",
  title: "Thanks",
  body: "Thanks, received.",
  customized: false,
};
const shared = {
  ...personal,
  id: "o1",
  scope: "org",
  title: "Org reminder",
  body: "Notes by 5pm.",
};
const platformAdmin = {
  id: "p6",
  templateKey: "general.after_hours_emergency",
  category: "general",
  floorTitle: "After hours and emergencies",
  floorBody: "Away. If this is an emergency, call 911. Use the on-call line.",
  requiredPhrases: ["call 911", "on-call line"],
  overlay: null,
};
const refusal = (message: string, details: unknown[] = []) => ({
  data: undefined,
  error: { error: { code: "X", message, details } },
  response: { status: 422 },
});

interface Options {
  readonly manager?: boolean;
  readonly write?: (method: string, path: string, init: unknown) => unknown;
}

function mount({ manager = false, write }: Options = {}) {
  const calls: Array<{ method: string; path: string; init: any }> = [];
  const respond = (method: string) => (path: string, init?: unknown) => {
    calls.push({ method, path, init });
    if (method === "GET") {
      if (path === "/api/v1/messaging/templates") {
        return Promise.resolve({ data: { items: [personal] }, error: undefined });
      }
      return Promise.resolve(
        manager
          ? { data: { platform: [platformAdmin], shared: [shared] }, error: undefined }
          : { data: undefined, error: { error: { message: "no" } }, response: { status: 403 } },
      );
    }
    return Promise.resolve(write?.(method, path, init) ?? { data: undefined, error: undefined });
  };
  const api = {
    GET: vi.fn(respond("GET")),
    POST: vi.fn(respond("POST")),
    PATCH: vi.fn(respond("PATCH")),
    PUT: vi.fn(respond("PUT")),
    DELETE: vi.fn(respond("DELETE")),
  } as unknown as ApiClient;
  render(
    <ApiClientProvider client={api}>
      <SavedReplies />
    </ApiClientProvider>,
  );
  return { calls };
}

const fill = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getAllByLabelText(label).at(-1) as HTMLElement, { target: { value } });

describe("Saved replies screen: a sender", () => {
  it("sees only their own replies; the organization and platform sections are absent", async () => {
    mount();
    expect(await screen.findByText("Thanks")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "My saved replies" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Organization templates")).toBeNull());
    expect(screen.queryByText("Platform templates")).toBeNull();
  });

  it("adds a reply with an Idempotency-Key and reloads the list", async () => {
    const { calls } = mount();
    await screen.findByText("Thanks");
    fill(/^Title/, "Running late");
    fill(/^Reply text/, "Back in ten minutes.");
    fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v1/messaging/templates/personal");
    expect(post?.init.body).toEqual({
      title: "Running late",
      body: "Back in ten minutes.",
      category: "general",
    });
    expect(post?.init.params.header["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/v1/messaging/templates").length).toBeGreaterThan(
        1,
      ),
    );
  });

  it("shows a PHI refusal in place, keeps what was typed, and never repeats the text", async () => {
    mount({
      write: () =>
        refusal("Saved replies must not contain patient identifiers.", [
          { field: "body", code: "PHI_PHONE", message: "looks like a phone number" },
        ]),
    });
    await screen.findByText("Thanks");
    fill(/^Title/, "Call back");
    fill(/^Reply text/, "Call 415-555-0134");
    fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("must not contain patient identifiers");
    expect(alert.textContent).toContain("body looks like a phone number");
    expect(alert.textContent).not.toContain("415");
    expect((screen.getAllByLabelText(/^Reply text/).at(-1) as HTMLTextAreaElement).value).toBe(
      "Call 415-555-0134",
    );
  });

  it("edits a reply in place", async () => {
    const { calls } = mount();
    await screen.findByText("Thanks");
    fireEvent.click(screen.getByRole("button", { name: "Edit Thanks" }));
    const form = screen.getByRole("form", { name: "Edit Thanks" });
    fireEvent.change(within(form).getByLabelText(/^Reply text/), { target: { value: "Got it." } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/v1/messaging/templates/personal/{id}");
    expect(patch?.init.params.path.id).toBe("m1");
    expect(patch?.init.body.body).toBe("Got it.");
  });

  it("asks before deleting, and deletes on confirm", async () => {
    const { calls } = mount();
    await screen.findByText("Thanks");
    fireEvent.click(screen.getByRole("button", { name: "Delete Thanks" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.init.params.path.id).toBe("m1");
  });
});

describe("Saved replies screen: a template manager", () => {
  it("also sees the organization templates and the platform templates with their required wording", async () => {
    mount({ manager: true });
    expect(await screen.findByText("Org reminder")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Platform templates" })).toBeTruthy();
    const phrases = screen.getByRole("list", { name: /must keep/i });
    expect(
      within(phrases)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["call 911", "on-call line"]);
  });

  it("customizes a platform template; unchanged text is stored as 'keep the platform text'", async () => {
    const { calls } = mount({ manager: true });
    await screen.findByText("Org reminder");
    fireEvent.click(screen.getByRole("button", { name: "Customize After hours and emergencies" }));
    const form = screen.getByRole("form", { name: "Customize After hours and emergencies" });
    fireEvent.change(within(form).getByLabelText(/^Reply text/), {
      target: { value: "Away. Emergency: call 911. Urgent: on-call line." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.init.params.path.id).toBe("p6");
    expect(put?.init.body).toEqual({
      title: null,
      body: "Away. Emergency: call 911. Urgent: on-call line.",
      isEnabled: true,
    });
  });

  it("shows the platform floor refusal and leaves the form open", async () => {
    mount({
      manager: true,
      write: (method) =>
        method === "PUT"
          ? refusal("This template must keep the platform's required wording.", [
              {
                field: "body",
                code: "REQUIRED_PHRASE_MISSING",
                message: 'must keep the wording "call 911"',
              },
            ])
          : undefined,
    });
    await screen.findByText("Org reminder");
    fireEvent.click(screen.getByRole("button", { name: "Customize After hours and emergencies" }));
    const form = screen.getByRole("form", { name: "Customize After hours and emergencies" });
    fireEvent.change(within(form).getByLabelText(/^Reply text/), {
      target: { value: "Reply later." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("required wording");
    expect(
      screen.getByRole("form", { name: "Customize After hours and emergencies" }),
    ).toBeTruthy();
  });

  it("B7: a platform template with required wording cannot be hidden from staff", async () => {
    const { calls } = mount({ manager: true });
    await screen.findByText("Org reminder");
    fireEvent.click(screen.getByRole("button", { name: "Customize After hours and emergencies" }));
    const form = screen.getByRole("form", { name: "Customize After hours and emergencies" });
    const toggle = within(form).getByRole("checkbox", { name: /available to staff/i });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("Saved replies screen review fixes (Tranche B)", () => {
  it("M9: a rejected create shows an error, keeps the text and lets the user submit again", async () => {
    let fail = true;
    const { calls } = mount({
      write: () => (fail ? Promise.reject(new Error("network down")) : undefined),
    });
    await screen.findByText("Thanks");
    fill(/^Title/, "Running late");
    fill(/^Reply text/, "Back in ten minutes.");
    fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
    await screen.findByText(/could not be saved/i);
    expect((screen.getAllByLabelText(/^Title/).at(-1) as HTMLInputElement).value).toBe(
      "Running late",
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
  });

  it("M10: a retry after a lost reply carries the same Idempotency-Key, and a new reply gets a new one", async () => {
    let fail = true;
    const { calls } = mount({
      write: () => (fail ? Promise.reject(new Error("network down")) : undefined),
    });
    await screen.findByText("Thanks");
    fill(/^Title/, "Running late");
    fill(/^Reply text/, "Back in ten minutes.");
    fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
    await screen.findByText(/could not be saved/i);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [first, second] = calls.filter((c) => c.method === "POST");
    expect(second?.init.params.header["Idempotency-Key"]).toBe(
      first?.init.params.header["Idempotency-Key"],
    );
    await waitFor(() =>
      expect((screen.getAllByLabelText(/^Title/).at(-1) as HTMLInputElement).value).toBe(""),
    );
    fill(/^Title/, "Another");
    fill(/^Reply text/, "Different text.");
    fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(3));
    const third = calls.filter((c) => c.method === "POST")[2];
    expect(third?.init.params.header["Idempotency-Key"]).not.toBe(
      first?.init.params.header["Idempotency-Key"],
    );
  });

  it("M9: a rejected delete is reported in the dialog and the dialog is not stuck pending", async () => {
    mount({ write: () => Promise.reject(new Error("network down")) });
    await screen.findByText("Thanks");
    fireEvent.click(screen.getByRole("button", { name: "Delete Thanks" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await within(dialog).findByText(/could not delete this reply/i);
    expect(
      (within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
