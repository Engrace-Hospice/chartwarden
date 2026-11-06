import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: the mailing settings (routes 42-43).
// Four mailings (never the deferred birthday one), each its own card with its own version: a save carries the version READ in
// If-Match (0 for a never-configured mailing), a 412 prompts a reload instead of overwriting, an unsaved edit is flagged and warned
// about, a write in flight makes every control inert, and no wording is ever supplied for the agency.
import axe from "axe-core";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MailingSettings } from "./mailing-settings";

/** jest-dom's `toBeDisabled`: the control itself, or a descendant of a disabled fieldset (how these screens make a whole form inert). */
const inert = (el: HTMLElement): boolean =>
  (el as HTMLInputElement).disabled || el.closest("fieldset:disabled") !== null;

const MANAGER = ["bereavement.mailing.read", "bereavement.mailing.manage"];
const CONFIG_PATH = "/api/v1/bereavement/mailings/config";
const WORDING = {
  en: {
    title: "Winter remembrance",
    greeting: "Dear {name},",
    paragraphs: ["We are thinking of your family this season."],
    signoff: "With care",
  },
};

const config = (mailingKey: string, over: Record<string, unknown> = {}) => ({
  mailingKey,
  configured: true,
  enabled: true,
  leadDays: 14,
  schedule: {},
  audienceRelationships: null,
  content: WORDING,
  version: 3,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const CONFIGS = [
  config("newsletter_quarterly"),
  config("holiday_december"),
  config("mothers_day", {
    configured: false,
    enabled: false,
    version: 0,
    content: {},
    leadDays: 21,
  }),
  config("fathers_day"),
];

interface Req {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly ifMatch: string | null;
  readonly idempotencyKey: string | null;
}
type Reply = { status: number; body?: unknown } | "reject";

const refused = (status: number, code: string, message = "refused"): Reply => ({
  status,
  body: { error: { code, message } },
});

function mount(opts: {
  /** The answer to each GET of the configs, in order; the last one repeats. */
  reads?: Reply[];
  /** The answer to a PUT. */
  put?: (req: Req) => Reply | Promise<Reply>;
  permissions?: string[];
}) {
  const calls: Req[] = [];
  let reads = 0;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), "http://localhost");
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const text = req && method !== "GET" ? await req.clone().text() : "";
    const recorded: Req = {
      method,
      path: url.pathname,
      body: text ? JSON.parse(text) : null,
      ifMatch: req?.headers.get("if-match") ?? null,
      idempotencyKey: req?.headers.get("idempotency-key") ?? null,
    };
    calls.push(recorded);
    let reply: Reply;
    if (method === "GET") {
      const list = opts.reads ?? [{ status: 200, body: CONFIGS }];
      reply = list[Math.min(reads, list.length - 1)] ?? { status: 200, body: CONFIGS };
      reads += 1;
    } else {
      reply = (await opts.put?.(recorded)) ?? { status: 200, body: CONFIGS[1] };
    }
    if (reply === "reject") throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const router = createMemoryRouter(
    [
      { path: "/bereavement/mailings/settings", element: <MailingSettings /> },
      { path: "/bereavement/mailings", element: <p>Runs page</p> },
      { path: "/expired", element: <p>Session expired page</p> },
    ],
    { initialEntries: ["/bereavement/mailings/settings"] },
  );
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider
        session={{
          userId: "u-1",
          organizationId: "org-1",
          permissions: opts.permissions ?? MANAGER,
        }}
      >
        <RouterProvider router={router} />
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, router, ...view };
}

const card = async (name: string) => within(await screen.findByRole("region", { name }));
const puts = (calls: Req[]): Req[] => calls.filter((c) => c.method === "PUT");
const configReads = (calls: Req[]): number =>
  calls.filter((c) => c.method === "GET" && c.path === CONFIG_PATH).length;

describe("mailing settings — what it shows", () => {
  it("shows the four configurable mailings and never the deferred birthday mailing", async () => {
    mount({
      reads: [{ status: 200, body: [...CONFIGS, config("decedent_birthday", { version: 1 })] }],
    });
    for (const label of [
      "Quarterly newsletter",
      "December holiday card",
      "Mother's Day letter",
      "Father's Day letter",
    ])
      expect(await screen.findByRole("region", { name: `${label} settings` })).toBeTruthy();
    expect(screen.queryByText(/birthday/i)).toBeNull();
    const mothers = await card("Mother's Day letter settings");
    expect(mothers.getByText("Not configured")).toBeTruthy();
    expect((mothers.getByLabelText("Lead time in days") as HTMLInputElement).value).toBe("21");
  });

  it("shows only the date field that belongs to each mailing", async () => {
    mount({});
    const newsletter = await card("Quarterly newsletter settings");
    expect(newsletter.getByLabelText("Issue dates (MM-DD, separated by commas)")).toBeTruthy();
    expect(newsletter.queryByLabelText("Card date (MM-DD)")).toBeNull();
    const december = await card("December holiday card settings");
    expect(december.getByLabelText("Card date (MM-DD)")).toBeTruthy();
    const fathers = await card("Father's Day letter settings");
    expect(fathers.queryByLabelText("Card date (MM-DD)")).toBeNull();
    expect(fathers.queryByLabelText("Issue dates (MM-DD, separated by commas)")).toBeNull();
  });

  it("a never-configured mailing starts blank: no default wording is filled in", async () => {
    mount({});
    const mothers = await card("Mother's Day letter settings");
    expect((mothers.getByLabelText("Mother's Day letter title") as HTMLInputElement).value).toBe(
      "",
    );
    expect((mothers.getByLabelText("Mother's Day letter greeting") as HTMLInputElement).value).toBe(
      "",
    );
    expect(mothers.queryByLabelText("Mother's Day letter paragraph 1")).toBeNull();
    // the greeting token is documented where the greeting is written
    expect(
      mothers.getByText(/Write \{name\} where each family member's name should go/),
    ).toBeTruthy();
  });

  it("a reader without manage sees the settings read-only: no Save, every control inert", async () => {
    mount({ permissions: ["bereavement.mailing.read"] });
    expect(await screen.findByText(/You can read these settings but not change them/)).toBeTruthy();
    const december = await card("December holiday card settings");
    expect(december.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(inert(december.getByLabelText("Lead time in days"))).toBe(true);
  });
});

describe("mailing settings — who sees it, and how it fails", () => {
  it("a 403 renders nothing at all", async () => {
    const { container } = mount({ reads: [refused(403, "FORBIDDEN")] });
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a server error is announced with Try again; the retry loads the settings", async () => {
    const { calls } = mount({
      reads: [refused(500, "INTERNAL", "boom"), { status: 200, body: CONFIGS }],
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("region", { name: "December holiday card settings" }),
    ).toBeTruthy();
    expect(configReads(calls)).toBe(2);
  });

  it("a dropped connection is announced, not a blank page", async () => {
    mount({ reads: ["reject"] });
    expect((await screen.findByRole("alert")).textContent).toMatch(/connection dropped/i);
  });
});

describe("mailing settings — saving", () => {
  it("sends If-Match = the version read and an Idempotency-Key, the new lead time, and no schedule for a mailing without one", async () => {
    const { calls } = mount({
      put: () => ({ status: 200, body: config("holiday_december", { leadDays: 21, version: 4 }) }),
    });
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "21" } });
    fireEvent.click(
      december.getByRole("button", { name: "Save settings for December holiday card" }),
    );
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const put = puts(calls)[0];
    expect(put).toMatchObject({
      path: `${CONFIG_PATH}/holiday_december`,
      ifMatch: "3",
      body: {
        enabled: true,
        leadDays: 21,
        audienceRelationships: null,
        content: WORDING,
      },
    });
    expect(put?.body).not.toHaveProperty("schedule");
    expect(put?.idempotencyKey).toBeTruthy();
    expect(await screen.findByText("The December holiday card settings were saved.")).toBeTruthy();
  });

  it("the first write of a never-configured mailing carries If-Match 0; the next save carries the version it returned", async () => {
    const { calls } = mount({
      put: (req) => ({
        status: 200,
        body: config("mothers_day", {
          configured: true,
          enabled: true,
          version: req.ifMatch === "0" ? 1 : 2,
          leadDays: 21,
          content: {
            en: {
              title: "For mothers",
              greeting: "",
              paragraphs: ["Thinking of you."],
              signoff: "",
            },
          },
        }),
      }),
    });
    const mothers = await card("Mother's Day letter settings");
    fireEvent.click(mothers.getByLabelText("Send this mailing"));
    fireEvent.change(mothers.getByLabelText("Mother's Day letter title"), {
      target: { value: "For mothers" },
    });
    fireEvent.click(mothers.getByRole("button", { name: "Mother's Day letter add a paragraph" }));
    fireEvent.change(mothers.getByLabelText("Mother's Day letter paragraph 1"), {
      target: { value: "Thinking of you." },
    });
    fireEvent.click(mothers.getByRole("button", { name: "Save settings for Mother's Day letter" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.ifMatch).toBe("0");

    await screen.findByText("The Mother's Day letter settings were saved.");
    const again = await card("Mother's Day letter settings");
    fireEvent.change(again.getByLabelText("Lead time in days"), { target: { value: "30" } });
    fireEvent.click(again.getByRole("button", { name: "Save settings for Mother's Day letter" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]?.ifMatch).toBe("1");
    expect(puts(calls)[1]?.idempotencyKey).not.toBe(puts(calls)[0]?.idempotencyKey);
  });

  it("sends the date overrides only for the mailings that have one", async () => {
    const { calls } = mount({
      put: () => ({ status: 200, body: config("newsletter_quarterly", { version: 4 }) }),
    });
    const newsletter = await card("Quarterly newsletter settings");
    fireEvent.change(newsletter.getByLabelText("Issue dates (MM-DD, separated by commas)"), {
      target: { value: "01-10, 04-10 07-10" },
    });
    fireEvent.click(
      newsletter.getByRole("button", { name: "Save settings for Quarterly newsletter" }),
    );
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toMatchObject({
      schedule: { monthDays: ["01-10", "04-10", "07-10"] },
    });

    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Card date (MM-DD)"), { target: { value: "12-20" } });
    fireEvent.click(
      december.getByRole("button", { name: "Save settings for December holiday card" }),
    );
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]?.body).toMatchObject({ schedule: { monthDay: "12-20" } });
  });

  it("an invalid date, a lead time out of range or an empty audience blocks Save and says why", async () => {
    const { calls } = mount({});
    const december = await card("December holiday card settings");
    const save = december.getByRole("button", {
      name: "Save settings for December holiday card",
    }) as HTMLButtonElement;
    fireEvent.change(december.getByLabelText("Card date (MM-DD)"), { target: { value: "13-40" } });
    expect(december.getByText(/Write the card's date as MM-DD/)).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(december.getByLabelText("Card date (MM-DD)"), { target: { value: "" } });
    for (const bad of ["2", "61", "abc", "10.5"]) {
      fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: bad } });
      expect(december.getByText(/Lead time is a whole number of days from 3 to 60/)).toBeTruthy();
      expect(save.disabled).toBe(true);
    }
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "3" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(december.getByLabelText("Everyone on the roster"));
    expect(december.getByText(/Choose at least one relationship, or choose everyone/)).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(puts(calls)).toHaveLength(0);
  });

  it("a chosen audience is sent as the relationships picked", async () => {
    const { calls } = mount({
      put: () => ({ status: 200, body: config("fathers_day", { version: 4 }) }),
    });
    const fathers = await card("Father's Day letter settings");
    fireEvent.click(fathers.getByLabelText("Everyone on the roster"));
    fireEvent.click(fathers.getByLabelText("Spouse"));
    fireEvent.click(fathers.getByLabelText("Child"));
    fireEvent.click(fathers.getByRole("button", { name: "Save settings for Father's Day letter" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toMatchObject({ audienceRelationships: ["child", "spouse"] });
  });

  it("an enabled mailing with no wording is warned about, and is saved with no wording (never a default)", async () => {
    const { calls } = mount({
      put: () => ({ status: 200, body: config("mothers_day", { version: 1 }) }),
    });
    const mothers = await card("Mother's Day letter settings");
    expect(mothers.queryByText(/This mailing is on but has no wording/)).toBeNull();
    fireEvent.click(mothers.getByLabelText("Send this mailing"));
    expect(mothers.getByText(/This mailing is on but has no wording/)).toBeTruthy();
    fireEvent.click(mothers.getByRole("button", { name: "Save settings for Mother's Day letter" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toMatchObject({ enabled: true, content: {} });
  });

  it("a 412 says someone else saved first and offers a reload; the reload is the reader's choice", async () => {
    const { calls } = mount({
      reads: [
        { status: 200, body: CONFIGS },
        {
          status: 200,
          body: [
            CONFIGS[0],
            config("holiday_december", { leadDays: 30, version: 4 }),
            CONFIGS[2],
            CONFIGS[3],
          ],
        },
      ],
      put: () => refused(412, "STALE_VERSION"),
    });
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "21" } });
    fireEvent.click(
      december.getByRole("button", { name: "Save settings for December holiday card" }),
    );
    // announced, not just painted: the conflict is an alert inside the card
    expect((await december.findByRole("alert")).textContent).toMatch(
      /Someone else saved this mailing's settings/,
    );
    // nothing was reloaded on its own, and the edit is still there
    expect(configReads(calls)).toBe(1);
    expect((december.getByLabelText("Lead time in days") as HTMLInputElement).value).toBe("21");
    fireEvent.click(december.getByRole("button", { name: "Reload settings" }));
    await waitFor(() =>
      expect(
        (
          within(
            screen.getByRole("region", { name: "December holiday card settings" }),
          ).getByLabelText("Lead time in days") as HTMLInputElement
        ).value,
      ).toBe("30"),
    );
    expect(configReads(calls)).toBe(2);
  });

  it("a refusal the server answered (422) is shown on the card and the next attempt is a new write", async () => {
    const { calls } = mount({ put: () => refused(422, "VALIDATION", "lead time is out of range") });
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "21" } });
    const save = december.getByRole("button", { name: "Save settings for December holiday card" });
    fireEvent.click(save);
    expect(await december.findByText("lead time is out of range")).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]?.idempotencyKey).not.toBe(puts(calls)[0]?.idempotencyKey);
  });

  it("a lost response is not 'busy' forever, and the retry reuses the same Idempotency-Key", async () => {
    let attempts = 0;
    const { calls } = mount({
      put: () => {
        attempts += 1;
        return attempts === 1
          ? "reject"
          : { status: 200, body: config("holiday_december", { leadDays: 21, version: 4 }) };
      },
    });
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "21" } });
    const save = december.getByRole("button", { name: "Save settings for December holiday card" });
    fireEvent.click(save);
    expect(await december.findByText(/connection dropped/i)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]?.idempotencyKey).toBe(puts(calls)[0]?.idempotencyKey);
  });

  it("while a save is in flight every control is inert, the button says so, and a second click sends nothing", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mount({
      put: async () => {
        await held;
        return { status: 200, body: config("holiday_december", { leadDays: 21, version: 4 }) };
      },
    });
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "21" } });
    const save = december.getByRole("button", { name: "Save settings for December holiday card" });
    fireEvent.click(save);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(inert(december.getByLabelText("Lead time in days"))).toBe(true);
    expect(inert(december.getByLabelText("Send this mailing"))).toBe(true);
    expect(inert(december.getByLabelText("December holiday card title"))).toBe(true);
    expect(inert(save)).toBe(true);
    expect(save.getAttribute("aria-busy")).toBe("true");
    // the accessible name carries the visible words
    expect(december.getByRole("button", { name: /Saving… for December holiday card/ })).toBe(save);
    fireEvent.click(save);
    expect(puts(calls)).toHaveLength(1);
    release();
    await screen.findByText("The December holiday card settings were saved.");
  });
});

describe("mailing settings — unsaved edits", () => {
  it("flags an unsaved edit, can discard it, and warns before the tab is closed over it", async () => {
    mount({});
    const december = await card("December holiday card settings");
    const pristine = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pristine);
    expect(pristine.defaultPrevented).toBe(false);
    expect(december.queryByText("You have unsaved changes.")).toBeNull();

    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "30" } });
    expect(december.getByText("You have unsaved changes.")).toBeTruthy();
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    fireEvent.click(december.getByRole("button", { name: "Discard changes" }));
    expect((december.getByLabelText("Lead time in days") as HTMLInputElement).value).toBe("14");
    expect(december.queryByText("You have unsaved changes.")).toBeNull();
  });

  it("leaving the page in-app over an unsaved edit asks first in an alertdialog; staying keeps it (focus back), leaving goes", async () => {
    mount({});
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "30" } });
    const runsLink = screen.getByRole("link", { name: "Mailing runs" });
    runsLink.focus();
    fireEvent.click(runsLink);
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/unsaved mailing settings/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay on this page" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(runsLink);
    expect((december.getByLabelText("Lead time in days") as HTMLInputElement).value).toBe("30");
    fireEvent.click(screen.getByRole("link", { name: "Mailing runs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByText("Runs page")).toBeTruthy();
  });

  it("never blocks the shell's own exit: a session expiry leaves at once over an unsaved edit", async () => {
    const { router } = mount({});
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "30" } });
    await act(() => router.navigate("/expired"));
    expect(await screen.findByText("Session expired page")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("leaving mid-save asks first; a save that lands lets the navigation through, one that fails stays and is shown", async () => {
    let release: (reply: Reply) => void = () => {};
    const { calls } = mount({
      put: () =>
        new Promise<Reply>((resolve) => {
          release = resolve;
        }),
    });
    const december = await card("December holiday card settings");
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "21" } });
    fireEvent.click(
      december.getByRole("button", { name: "Save settings for December holiday card" }),
    );
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    fireEvent.click(screen.getByRole("link", { name: "Mailing runs" }));
    await screen.findByRole("alertdialog", { name: "A save is still in progress" });
    release(refused(500, "INTERNAL", "server trouble"));
    // the failure is not lost with the page: the prompt stays (now over an unsaved edit) and the card shows why
    await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    expect((await december.findByRole("alert")).textContent).toContain("server trouble");

    fireEvent.click(
      december.getByRole("button", { name: "Save settings for December holiday card" }),
    );
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    fireEvent.click(screen.getByRole("link", { name: "Mailing runs" }));
    await screen.findByRole("alertdialog", { name: "A save is still in progress" });
    release({ status: 200, body: config("holiday_december", { leadDays: 21, version: 4 }) });
    expect(await screen.findByText("Runs page")).toBeTruthy();
  });

  it("each card's controls are a group named after the mailing", async () => {
    mount({});
    expect(await screen.findByRole("group", { name: "Father's Day letter settings" })).toBeTruthy();
  });

  it("editing and reverting is not an edit", async () => {
    mount({});
    const december = await card("December holiday card settings");
    const save = december.getByRole("button", {
      name: "Save settings for December holiday card",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "30" } });
    expect(save.disabled).toBe(false);
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "14" } });
    expect(save.disabled).toBe(true);
    expect(december.queryByText("You have unsaved changes.")).toBeNull();
  });

  it("an edit in one card does not touch another, and saving one leaves the other's edit alone", async () => {
    mount({
      put: () => ({ status: 200, body: config("holiday_december", { leadDays: 21, version: 4 }) }),
    });
    const december = await card("December holiday card settings");
    const fathers = await card("Father's Day letter settings");
    fireEvent.change(fathers.getByLabelText("Lead time in days"), { target: { value: "40" } });
    fireEvent.change(december.getByLabelText("Lead time in days"), { target: { value: "21" } });
    fireEvent.click(
      december.getByRole("button", { name: "Save settings for December holiday card" }),
    );
    await screen.findByText("The December holiday card settings were saved.");
    const fathersAfter = await card("Father's Day letter settings");
    expect((fathersAfter.getByLabelText("Lead time in days") as HTMLInputElement).value).toBe("40");
    expect(fathersAfter.getByText("You have unsaved changes.")).toBeTruthy();
  });
});

describe("mailing settings — accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = mount({});
    await screen.findByRole("region", { name: "December holiday card settings" });
    // The same rule set the e2e route walk gates on (WCAG 2.x A and AA).
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
    ).toEqual([]);
  });
});
