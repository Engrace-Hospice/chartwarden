// @vitest-environment jsdom
// Amending a check-in is a multi-field form on the clinician's own history, so it opens as a drawer in the detail rail
// beside the history (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; a closed
// grace window opens no form at all.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyCheckInsScreen } from "./my-check-ins";
import type { SafetyCheckInView } from "./safety-api";

afterEach(cleanup);

const posted: SafetyCheckInView = {
  id: "11111111-1111-4111-8111-111111111111",
  scheduleId: null,
  visitId: null,
  postedByMembershipId: "m-lopez",
  postedAt: "2026-11-17T20:00:00.000Z",
  kind: "mid_visit",
  status: "ok",
  concernNote: null,
  coordinatesCaptured: false,
  isPartOfSosBracket: false,
  correctsCheckInId: null,
  supersededAt: null,
  supersededByCheckInId: null,
  amendableUntil: null,
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

const second: SafetyCheckInView = {
  ...posted,
  id: "22222222-2222-4222-8222-222222222222",
  postedAt: "2026-11-17T21:00:00.000Z",
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function mount(
  amendableUntil: string | null,
  opts: { patch?: () => Promise<unknown> } = {},
): { patch: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const patch = vi.fn(opts.patch ?? (async () => ok({})));
  const get = vi.fn(async (path: string, init?: { params?: { path?: { checkInId?: string } } }) =>
    path === "/api/v1/safety/check-ins/{checkInId}"
      ? ok({
          ...(init?.params?.path?.checkInId === second.id ? second : posted),
          amendableUntil,
        })
      : ok({
          asOf: "2026-11-18T12:00:00.000Z",
          obligations: [],
          recentCheckIns: [posted, second],
        }),
  );
  const client = { GET: get, PATCH: patch } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <MyCheckInsScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { patch, get };
}

const OPEN_WINDOW = "2026-11-18T12:05:00.000Z";
const drawerNamed = (name: string) => screen.findByRole("complementary", { name });

describe("my check-ins — amend a check-in", () => {
  it("opens the form as a drawer beside the history, not a dialog over it", async () => {
    mount(OPEN_WINDOW);
    fireEvent.click((await screen.findAllByRole("button", { name: "Amend" }))[0] as HTMLElement);
    const drawer = await drawerNamed("Amend this check-in");
    expect(within(drawer).getByLabelText("Why the correction?")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The history stays on the page while the form is open.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("closes from Cancel without recording anything", async () => {
    const { patch } = mount(OPEN_WINDOW);
    fireEvent.click((await screen.findAllByRole("button", { name: "Amend" }))[0] as HTMLElement);
    const drawer = await drawerNamed("Amend this check-in");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Amend this check-in" })).toBeNull(),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps Record correction disabled until the reason is long enough", async () => {
    mount(OPEN_WINDOW);
    fireEvent.click((await screen.findAllByRole("button", { name: "Amend" }))[0] as HTMLElement);
    const drawer = await drawerNamed("Amend this check-in");
    const record = within(drawer).getByRole("button", {
      name: "Record correction",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Why the correction?"), {
      target: { value: "Tapped the wrong button" },
    });
    expect(record.disabled).toBe(false);
  });

  it("asks for a note, with a live count, once the correction says concern", async () => {
    mount(OPEN_WINDOW);
    fireEvent.click((await screen.findAllByRole("button", { name: "Amend" }))[0] as HTMLElement);
    const drawer = await drawerNamed("Amend this check-in");
    expect(within(drawer).queryByLabelText("Your note")).toBeNull();
    fireEvent.change(within(drawer).getByLabelText("What you meant to say"), {
      target: { value: "concerned_continue" },
    });
    expect(within(drawer).getByLabelText("Your note")).toBeTruthy();
    expect(drawer.textContent).toContain("20 more characters required");
  });

  it("opens no form when the grace window has closed", async () => {
    mount(null);
    fireEvent.click((await screen.findAllByRole("button", { name: "Amend" }))[0] as HTMLElement);
    expect(await screen.findByText("Grace closed")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Amend this check-in" })).toBeNull();
  });
});

describe("my check-ins — a write in flight and a write that fails", () => {
  const isInert = (el: HTMLElement): boolean => el.closest("[inert]") !== null;
  const REASON = "Tapped the wrong button on the first try";
  const recordCorrection = (drawer: HTMLElement): void => {
    fireEvent.change(within(drawer).getByLabelText("Why the correction?"), {
      target: { value: REASON },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record correction" }));
  };
  const amendButtons = async () => await screen.findAllByRole("button", { name: "Amend" });

  it("makes the page inert while the correction is in flight, then live again", async () => {
    const write = deferred<unknown>();
    mount(OPEN_WINDOW, { patch: () => write.promise });
    const [firstAmend, secondAmend] = await amendButtons();
    fireEvent.click(firstAmend as HTMLElement);
    const drawer = await drawerNamed("Amend this check-in");
    recordCorrection(drawer);
    await waitFor(() => expect(isInert(secondAmend as HTMLElement)).toBe(true));
    expect(isInert(screen.getByRole("button", { name: "Refresh" }))).toBe(true);
    expect(isInert(screen.getByRole("link", { name: "My safety" }))).toBe(true);
    expect(isInert(drawer)).toBe(false);
    write.resolve(ok({}));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Amend this check-in" })).toBeNull(),
    );
    expect(isInert(secondAmend as HTMLElement)).toBe(false);
  });

  it("leaves another check-in's form open when an earlier correction lands", async () => {
    const write = deferred<unknown>();
    const { get } = mount(OPEN_WINDOW, { patch: () => write.promise });
    const [firstAmend, secondAmend] = await amendButtons();
    fireEvent.click(firstAmend as HTMLElement);
    recordCorrection(await drawerNamed("Amend this check-in"));
    // A browser blocks this click (the page is inert); jsdom delivers it, so the guard is what is tested.
    fireEvent.click(secondAmend as HTMLElement);
    await waitFor(() =>
      expect(
        (
          screen
            .getByRole("complementary", { name: "Amend this check-in" })
            .querySelector("textarea") as HTMLTextAreaElement
        ).value,
      ).toBe(""),
    );
    const readsBefore = get.mock.calls.length;
    write.resolve(ok({}));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(await drawerNamed("Amend this check-in")).toBeTruthy();
  });

  it("recovers when the correction is rejected by the network", async () => {
    mount(OPEN_WINDOW, {
      patch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    fireEvent.click((await amendButtons())[0] as HTMLElement);
    const drawer = await drawerNamed("Amend this check-in");
    recordCorrection(drawer);
    expect((await within(drawer).findByRole("alert")).textContent).toContain("No answer came back");
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(isInert(screen.getByRole("button", { name: "Refresh" }))).toBe(false);
  });
});

describe("my check-ins — nothing outlives a dismissed form", () => {
  it("reopens empty and without the last failure", async () => {
    mount(OPEN_WINDOW, {
      patch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    fireEvent.click((await screen.findAllByRole("button", { name: "Amend" }))[0] as HTMLElement);
    const drawer = await drawerNamed("Amend this check-in");
    fireEvent.change(within(drawer).getByLabelText("Why the correction?"), {
      target: { value: "Tapped the wrong button on the first try" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record correction" }));
    await within(drawer).findByText(/No answer came back/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Amend this check-in" })).toBeNull(),
    );
    fireEvent.click((await screen.findAllByRole("button", { name: "Amend" }))[0] as HTMLElement);
    const again = await drawerNamed("Amend this check-in");
    expect((within(again).getByLabelText("Why the correction?") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(within(again).queryByText(/No answer came back/)).toBeNull();
  });
});
