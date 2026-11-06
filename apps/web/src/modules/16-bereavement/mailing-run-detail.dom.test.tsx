import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: one mailing run (routes 45-51).
// Wording first (no default ever ships), Generate with the version read, a poll that stops when the render ends, Download only for a
// ready run (a mailed batch is never handed out again), Confirm mailed through a dialog that says eligibility is re-checked, Cancel, the items table, and the rules an
// oversight surface keeps: a 403 renders nothing, other failures are announced and keep the page up, a refetch never blanks it.
import axe from "axe-core";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MailingRunDetail, linkLifetimeMs } from "./mailing-run-detail";

/** jest-dom's `toBeDisabled`: the control itself, or a descendant of a disabled fieldset (how these screens make a whole form inert). */
const inert = (el: HTMLElement): boolean =>
  (el as HTMLInputElement).disabled || el.closest("fieldset:disabled") !== null;

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POLL_MS = 25;
const LINK_TTL_MS = 5 * 60_000;
const ALL_KEYS = [
  "bereavement.mailing.read",
  "bereavement.mailing.manage",
  "bereavement.mailing.dispatch",
];
const WORDING = {
  en: {
    title: "Winter remembrance",
    greeting: "Dear {name},",
    paragraphs: ["We are thinking of your family this season."],
    signoff: "With care",
  },
};

const run = (over: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  runKind: "holiday",
  mailingKey: "holiday_december",
  occurrenceKey: "holiday_december:2026",
  scheduledFor: "2026-12-15",
  status: "draft",
  content: WORDING,
  recipientCount: 0,
  excludedCount: 0,
  failureCode: null,
  hasDocument: false,
  generatedAt: null,
  mailedAt: null,
  itemCounts: { included: 0, excluded: 0, logged: 0, excludedAfterRender: 0 },
  version: 4,
  createdAt: "2026-12-01T00:00:00.000Z",
  ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  itemId: crypto.randomUUID(),
  contactId: CONTACT_A,
  planId: PLAN_ID,
  relationshipCode: "spouse",
  channel: "postal",
  status: "included",
  exclusionReason: null,
  ordinal: 1,
  ...over,
});

interface Req {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly ifMatch: string | null;
  readonly idempotencyKey: string | null;
}
type Reply = { status: number; body?: unknown } | "reject";
type Handler = (req: Req) => Reply | Promise<Reply>;

const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (status: number, code: string, message = "refused"): Reply => ({
  status,
  body: { error: { code, message } },
});

function mount(handler: Handler, permissions: string[] = ALL_KEYS) {
  const calls: Req[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), "http://localhost");
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const text = req && method !== "GET" ? await req.clone().text() : "";
    const recorded: Req = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : null,
      ifMatch: req?.headers.get("if-match") ?? null,
      idempotencyKey: req?.headers.get("idempotency-key") ?? null,
    };
    calls.push(recorded);
    const reply = await handler(recorded);
    if (reply === "reject") throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1", permissions }}>
        <MemoryRouter initialEntries={[`/bereavement/mailings/runs/${RUN_ID}`]}>
          <Routes>
            <Route
              path="/bereavement/mailings/runs/:runId"
              element={<MailingRunDetail pollMs={POLL_MS} />}
            />
            <Route path="/step-up" element={<StepUpProbe />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, ...view };
}

const RUN_PATH = `/api/v1/bereavement/mailings/runs/${RUN_ID}`;
const ITEMS_PATH = `${RUN_PATH}/items`;
const runReads = (calls: Req[]): number =>
  calls.filter((c) => c.method === "GET" && c.path === RUN_PATH).length;

/** The default server: one run, an empty item list, and whatever `write` answers for a POST/PATCH. */
const server =
  (opts: {
    run?: () => Reply;
    items?: (q: URLSearchParams) => Reply | Promise<Reply>;
    write?: Handler;
  }): Handler =>
  (req) => {
    if (req.method === "GET" && req.path === RUN_PATH) return (opts.run ?? (() => ok(run())))();
    if (req.method === "GET" && req.path === ITEMS_PATH)
      return (opts.items ?? (() => ok({ data: [], next_cursor: null, has_more: false })))(
        req.query,
      );
    if (req.method === "GET" && req.path === `${RUN_PATH}/download`)
      return ok({
        runId: RUN_ID,
        url: "https://files.example.test/batch.pdf?sig=abc",
        // a realistic presign: five minutes from now
        expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString(),
      });
    return opts.write?.(req) ?? ok(run());
  };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Where a step-up refusal lands: shows the `returnTo` it was given. */
function StepUpProbe(): JSX.Element {
  const { search } = useLocation();
  return <p data-testid="step-up">{search}</p>;
}

describe("mailing run — what it shows", () => {
  it("shows the run, its wording and its counts, and offers no default wording", async () => {
    mount(
      server({
        run: () =>
          ok(
            run({
              status: "ready",
              recipientCount: 3,
              itemCounts: { included: 3, excluded: 1, logged: 0, excludedAfterRender: 0 },
            }),
          ),
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "December holiday card for 2026-12-15" }),
    ).toBeTruthy();
    expect(screen.getByText("Winter remembrance")).toBeTruthy();
    expect(screen.getByText("We are thinking of your family this season.")).toBeTruthy();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("a run with no wording says so and Generate is disabled with the reason; nothing is filled in", async () => {
    const { calls } = mount(server({ run: () => ok(run({ content: {} })) }));
    const generate = (await screen.findByRole("button", { name: "Generate" })) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(screen.getByText(/Generate is unavailable until the wording has a title/)).toBeTruthy();
    expect(screen.getByText(/No wording has been written for this run/)).toBeTruthy();
    expect(generate.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(generate);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.queryByText(/Winter remembrance|With care|Dear /)).toBeNull();
  });

  it("a failed run shows its failure code in words and Retry sends Generate", async () => {
    const { calls } = mount(
      server({
        run: () => ok(run({ status: "failed", failureCode: "NO_RECIPIENTS" })),
        write: () => ok(run({ status: "generating", version: 5 })),
      }),
    );
    expect(await screen.findByText(/Nobody was eligible for this mailing/)).toBeTruthy();
    expect(screen.getByText(/Code: NO_RECIPIENTS/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/generate"))).toBe(true));
  });

  it("an item row links to its contact, names no one, and says why a family was left out", async () => {
    mount(
      server({
        run: () => ok(run({ status: "ready" })),
        items: () =>
          ok({
            data: [
              item({ ordinal: 1 }),
              item({
                contactId: CONTACT_B,
                status: "excluded",
                ordinal: null,
                exclusionReason: "no_mailing_address",
              }),
            ],
            next_cursor: null,
            has_more: false,
          }),
      }),
    );
    const link = await screen.findByRole("link", { name: "Open contact aaaaaaaa" });
    expect(link.getAttribute("href")).toBe(`/bereavement/plans/${PLAN_ID}/contacts/${CONTACT_A}`);
    expect(screen.getByText("No mailing address on file")).toBeTruthy();
    expect(screen.getAllByText("In the batch").length).toBeGreaterThan(0);
  });
});

describe("mailing run — who sees it, and how it fails", () => {
  it("a 403 on the run renders nothing at all", async () => {
    const { container } = mount(server({ run: () => refused(403, "FORBIDDEN") }));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a 404 says the run does not exist", async () => {
    mount(server({ run: () => refused(404, "MAILING_RUN_NOT_FOUND") }));
    expect(await screen.findByText("This mailing run does not exist.")).toBeTruthy();
  });

  it("a server error is announced with Try again, and the retry loads the run", async () => {
    let reads = 0;
    const { calls } = mount(
      server({
        run: () => {
          reads += 1;
          return reads === 1 ? refused(500, "INTERNAL", "boom") : ok(run());
        },
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Winter remembrance")).toBeTruthy();
    expect(runReads(calls)).toBe(2);
  });

  it("a dropped connection is announced, not a blank page", async () => {
    mount(server({ run: () => "reject" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/connection dropped/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a failed refresh is announced and the run stays on screen", async () => {
    let reads = 0;
    mount(
      server({
        run: () => {
          reads += 1;
          return reads === 1 ? ok(run({ status: "generating" })) : refused(500, "INTERNAL", "boom");
        },
      }),
    );
    expect(await screen.findByText("Winter remembrance")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(screen.getByText("Winter remembrance")).toBeTruthy();
  });

  it("a 403 on the items hides the table and nothing else", async () => {
    mount(server({ items: () => refused(403, "FORBIDDEN") }));
    expect(await screen.findByText("Winter remembrance")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Families in this run")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a reader with read only sees the run but none of the actions", async () => {
    mount(server({}), ["bereavement.mailing.read"]);
    expect(await screen.findByText("Winter remembrance")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit wording" })).toBeNull();
    expect(screen.getByText(/can view this run but not change or send it/)).toBeTruthy();
  });
});

describe("mailing run — generate and the poll", () => {
  it("Generate sends If-Match = the version read and an Idempotency-Key, then waits for the render", async () => {
    let current = run();
    const { calls } = mount(
      server({
        run: () => ok(current),
        write: () => {
          current = run({ status: "generating", version: 5 });
          return ok(current);
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({ path: `${RUN_PATH}/generate`, ifMatch: "4", body: null });
    expect(post?.idempotencyKey).toBeTruthy();
    expect(
      await screen.findByText(/The batch is being generated\. This page checks again/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
  });

  it("a double click sends one request and shows the busy state", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mount(
      server({
        write: async () => {
          await held;
          return ok(run({ status: "generating", version: 5 }));
        },
      }),
    );
    const generate = (await screen.findByRole("button", { name: "Generate" })) as HTMLButtonElement;
    fireEvent.click(generate);
    fireEvent.click(generate);
    await waitFor(() => expect(generate.disabled).toBe(true));
    expect(generate.getAttribute("aria-busy")).toBe("true");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    release();
    await screen.findByText(/The batch is being generated/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("the 422 for empty wording is shown in words and the button comes back", async () => {
    mount(
      server({
        write: () =>
          refused(422, "MAILING_CONTENT_EMPTY", "write the mailing's title and a paragraph"),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No default wording is sent");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("a 412 says the run moved and reloads it", async () => {
    const { calls } = mount(server({ write: () => refused(412, "STALE_VERSION") }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "changed while you were working",
    );
    await waitFor(() => expect(runReads(calls)).toBe(2));
  });

  it("polls while generating without unmounting, and stops once the run leaves generating", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const { calls } = mount(
      server({
        run: () => {
          reads += 1;
          return ok(run({ status: reads >= 3 ? "ready" : "generating", version: 4 + reads }));
        },
        items: async () => {
          if (reads === 2) await held;
          return ok({ data: [], next_cursor: null, has_more: false });
        },
      }),
    );
    const heading = await screen.findByRole("heading", { name: /December holiday card/ });
    await waitFor(() => expect(runReads(calls)).toBeGreaterThanOrEqual(3));
    // the page was never torn down while it re-read
    expect(screen.getByRole("heading", { name: /December holiday card/ })).toBe(heading);
    release();
    await waitFor(() => expect(screen.getAllByText("Ready").length).toBeGreaterThan(0));
    const settled = runReads(calls);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
    expect(runReads(calls)).toBe(settled);
  });
});

describe("mailing run — the poll's limits", () => {
  it("announces a render that failed while the page waited", async () => {
    let reads = 0;
    mount(
      server({
        run: () => {
          reads += 1;
          return ok(
            run(
              reads >= 2
                ? { status: "failed", failureCode: "RENDER_FAILED" }
                : { status: "generating" },
            ),
          );
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((el) => el.textContent?.includes("Generation failed")),
      ).toBe(true),
    );
    // a poll noticed it, not the reader: focus is not pulled to the message
    const said = screen
      .getAllByRole("status")
      .find((el) => el.textContent?.includes("Generation failed"));
    expect(document.activeElement).not.toBe(said);
  });

  it("a poll a 404 stopped starts again when Try again reads the run and it is still generating", async () => {
    let reads = 0;
    const { calls } = mount(
      server({
        run: () => {
          reads += 1;
          return reads === 2
            ? refused(404, "NOT_FOUND", "gone")
            : ok(run({ status: "generating" }));
        },
      }),
    );
    await waitFor(() => expect(runReads(calls)).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
    expect(runReads(calls)).toBe(2);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(runReads(calls)).toBeGreaterThanOrEqual(4));
  });

  it("stops polling when the run is gone (404)", async () => {
    let reads = 0;
    const { calls } = mount(
      server({
        run: () => {
          reads += 1;
          return reads >= 2 ? refused(404, "NOT_FOUND", "gone") : ok(run({ status: "generating" }));
        },
      }),
    );
    await waitFor(() => expect(runReads(calls)).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
    expect(runReads(calls)).toBe(2);
  });

  it("pauses while the tab is hidden and resumes when it is shown", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { calls } = mount(server({ run: () => ok(run({ status: "generating" })) }));
    await screen.findByRole("heading", { name: /December holiday card/ });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
    expect(runReads(calls)).toBe(1);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(runReads(calls)).toBeGreaterThanOrEqual(2));
  });
});

describe("mailing run — download, confirm and cancel", () => {
  it("Download offers an explicit Open batch link (new tab, no opener), focuses it, and drops it once clicked before expiry; no pop-up is attempted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount(server({ run: () => ok(run({ status: "ready" })) }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    const link = (await screen.findByRole("link", { name: "Open batch" })) as HTMLAnchorElement;
    await waitFor(() => expect(document.activeElement).toBe(link));
    // well before the five-minute expiry the link is still offered (a far expiry no longer fires the timer at once)
    vi.advanceTimersByTime(60_000);
    expect(screen.getByRole("link", { name: "Open batch" })).toBe(link);
    expect(link.href).toBe("https://files.example.test/batch.pdf?sig=abc");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    // nothing claims the batch opened: the user opens it
    expect(screen.getByRole("status").textContent).toContain("Use Open batch");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open batch" })).toBeNull());
    expect(document.body.innerHTML).not.toContain("sig=abc");
  });

  it("an unclicked link is dropped when it expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(server({ run: () => ok(run({ status: "ready" })) }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await screen.findByRole("link", { name: "Open batch" });
    vi.advanceTimersByTime(LINK_TTL_MS + 1000);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open batch" })).toBeNull());
    expect(document.body.innerHTML).not.toContain("sig=abc");
  });

  it("a link lifetime is clamped to what a timer can wait, and an unreadable expiry is already expired", () => {
    const now = Date.parse("2026-11-06T00:00:00.000Z");
    expect(linkLifetimeMs("2026-11-06T00:05:00.000Z", now)).toBe(LINK_TTL_MS);
    expect(linkLifetimeMs("2099-01-01T00:00:00.000Z", now)).toBe(2 ** 31 - 1);
    expect(linkLifetimeMs("2026-11-05T00:00:00.000Z", now)).toBe(0);
    expect(linkLifetimeMs("not a date", now)).toBe(0);
  });

  it("a mailed run offers no Download: the batch went out and is never handed out again", async () => {
    mount(server({ run: () => ok(run({ status: "mailed", hasDocument: true })) }));
    await screen.findByRole("heading", { name: /December holiday card/ });
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("refuses a batch link that is not https", async () => {
    const base = server({ run: () => ok(run({ status: "ready" })) });
    mount((req) =>
      req.path.endsWith("/download")
        ? ok({
            runId: RUN_ID,
            url: "http://files.example.test/b.pdf",
            expiresAt: "2099-01-01T00:00:00.000Z",
          })
        : base(req),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not a secure (https) link");
    expect(screen.queryByRole("link", { name: "Open batch" })).toBeNull();
  });

  it("a stale batch (409 MAILING_RUN_STALE) is not downloaded: the page says so and Regenerate sends Generate on the ready run", async () => {
    let regenerated = false;
    const base = server({
      run: () =>
        ok(run({ status: regenerated ? "generating" : "ready", version: regenerated ? 5 : 4 })),
      write: (req) => {
        regenerated = true;
        return req.path.endsWith("/generate")
          ? ok(run({ status: "generating", version: 5 }))
          : ok(run());
      },
    });
    const { calls } = mount((req) =>
      req.path.endsWith("/download")
        ? refused(409, "MAILING_RUN_STALE", "2 recipients in this batch are no longer eligible.")
        : base(req),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("was not downloaded");
    // the page's own words, once (the server's sentence also says "regenerate"; it is not echoed)
    expect(alert.textContent).not.toContain("no longer eligible.");
    expect(alert.textContent?.match(/[Rr]egenerate/g)).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Open batch" })).toBeNull();
    const regenerate = screen.getAllByRole("button", { name: "Regenerate batch" });
    expect(regenerate).toHaveLength(1);
    fireEvent.click(regenerate[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        path: `${RUN_PATH}/generate`,
        ifMatch: "4",
      }),
    );
    expect(await screen.findByText(/do not mail the earlier one/)).toBeTruthy();
  });

  it("the stale notice goes once a later download succeeds", async () => {
    let downloads = 0;
    const base = server({ run: () => ok(run({ status: "ready" })) });
    mount((req) => {
      if (!req.path.endsWith("/download")) return base(req);
      downloads += 1;
      return downloads === 1 ? refused(409, "MAILING_RUN_STALE", "1 recipient") : base(req);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toContain("was not downloaded");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("link", { name: "Open batch" });
    expect(screen.queryByText(/was not downloaded/)).toBeNull();
  });

  it("a ready run offers Regenerate batch as a secondary action", async () => {
    mount(server({ run: () => ok(run({ status: "ready" })) }));
    expect(await screen.findByRole("button", { name: "Regenerate batch" })).toBeTruthy();
  });

  it("Regenerate on a ready batch asks first: an earlier download and its Ref numbers are superseded", async () => {
    const { calls } = mount(
      server({
        run: () => ok(run({ status: "ready" })),
        write: () => ok(run({ status: "generating", version: 5 })),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate batch" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Regenerate this batch" });
    const described = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toContain("Ref numbers");
    expect(described?.textContent).toContain("superseded");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep this batch" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate batch" }));
    const again = await screen.findByRole("alertdialog", { name: "Regenerate this batch" });
    fireEvent.click(within(again).getByRole("button", { name: "Regenerate batch" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: `${RUN_PATH}/generate`,
      ifMatch: "4",
    });
  });

  it("a download that needs a fresh step-up goes to /step-up and comes back to this run", async () => {
    const base = server({ run: () => ok(run({ status: "ready" })) });
    mount((req) =>
      req.path.endsWith("/download") ? refused(403, "STEP_UP_REQUIRED", "step up") : base(req),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect((await screen.findByTestId("step-up")).textContent).toContain(
      encodeURIComponent(`/bereavement/mailings/runs/${RUN_ID}`),
    );
  });

  it("Confirm mailed asks first, says eligibility is re-checked, then shows how many were left out and are not logged", async () => {
    const { calls } = mount(
      server({
        run: () =>
          ok(
            run({
              status: "ready",
              itemCounts: { included: 3, excluded: 0, logged: 0, excludedAfterRender: 0 },
            }),
          ),
        write: () =>
          ok(
            run({
              status: "mailed",
              version: 5,
              itemCounts: { included: 0, excluded: 0, logged: 1, excludedAfterRender: 2 },
            }),
          ),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Confirm mailed" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm the run was mailed" });
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("Each of the 3 families");
    // bookkeeping only: it promises no recall, it flags and names the Ref to pull
    expect(within(dialog).getByText(/cannot recall printed letters/)).toBeTruthy();
    expect(within(dialog).getByText(/not logged as mailed/)).toBeTruthy();
    expect(within(dialog).getByText(/Ref/)).toBeTruthy();
    expect(within(dialog).getByText(/Each of the 3 families in the batch/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm mailed" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({ path: `${RUN_PATH}/confirm-mailed`, ifMatch: "4" });
    expect(post?.idempotencyKey).toBeTruthy();
    expect(
      await screen.findByText(/Marked as mailed\. 1 logged\. 2 left out after printing/),
    ).toBeTruthy();
    expect(screen.getByText(/2 families were left out after printing/)).toBeTruthy();
  });

  it("closing the Confirm dialog without confirming sends nothing", async () => {
    const { calls } = mount(server({ run: () => ok(run({ status: "ready" })) }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm mailed" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Cancel run goes through a dialog and sends the version read", async () => {
    const { calls } = mount(
      server({
        run: () => ok(run({ status: "ready" })),
        write: () => ok(run({ status: "cancelled", version: 5 })),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    // destructive: an alertdialog described by what cancelling does, dismissed by "Keep run"
    const dialog = await screen.findByRole("alertdialog", { name: "Cancel this mailing run" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("cannot be reopened");
    expect(within(dialog).getByRole("button", { name: "Keep run" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, cancel this run" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: `${RUN_PATH}/cancel`,
      ifMatch: "4",
    });
    expect(await screen.findByText("The run was cancelled.")).toBeTruthy();
  });

  it("a stale refusal (409) inside the Confirm dialog closes it and says why on the page", async () => {
    const { calls } = mount(
      server({
        run: () => ok(run({ status: "ready" })),
        write: () => refused(409, "MAILING_RUN_NOT_READY", "the run is not ready"),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Confirm mailed" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm mailed" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // announced where focus lands (the dialog's trigger may be gone after the reload)
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toContain("the run is not ready"));
    await waitFor(() => expect(document.activeElement).toBe(status));
    await waitFor(() => expect(runReads(calls)).toBe(2));
  });

  it("any other refusal inside the Confirm dialog stays in the dialog", async () => {
    mount(
      server({
        run: () => ok(run({ status: "ready" })),
        write: () => refused(500, "INTERNAL", "server trouble"),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Confirm mailed" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm mailed" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("server trouble");
  });
});

describe("mailing run — editing the wording and the items list", () => {
  it("edits a draft's wording: the PATCH carries the version read and the trimmed content", async () => {
    const { calls } = mount(
      server({
        write: () =>
          ok(
            run({
              version: 5,
              content: { en: { ...WORDING.en, title: "Holiday greetings" } },
            }),
          ),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Winter remembrance",
    );
    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "  Holiday greetings  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save wording" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toMatchObject({
      path: `${RUN_PATH}/content`,
      ifMatch: "4",
      body: { content: { en: { ...WORDING.en, title: "Holiday greetings" } } },
    });
    expect(patch?.idempotencyKey).toBeTruthy();
    expect(await screen.findByText("Holiday greetings")).toBeTruthy();
  });

  it("a 412 on the wording shows THEIR newer wording and blocks Save until the reader picks one", async () => {
    let saved = false;
    const theirs = { en: { ...WORDING.en, title: "Their title" } };
    const { calls } = mount(
      server({
        run: () => ok(saved ? run({ version: 5, content: theirs }) : run()),
        write: (req) => {
          if (calls.filter((c) => c.method === "PATCH").length === 1) {
            saved = true;
            return refused(412, "STALE_VERSION");
          }
          return ok(run({ version: 6, content: { en: { ...WORDING.en, title: "Mine" } } }));
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save wording" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Choose which wording to keep",
    );
    const theirsRegion = await within(dialog).findByRole("region", { name: "Their saved wording" });
    expect(theirsRegion.textContent).toContain("Their title");
    // never a silent overwrite: Save waits for the choice
    expect(
      (within(dialog).getByRole("button", { name: "Save wording" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Mine");
    fireEvent.click(within(dialog).getByRole("button", { name: "Overwrite with mine" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save wording" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.ifMatch)).toEqual(["4", "5"]);
  });

  it("a 412 whose reload fails does not dead-end: the dialog says so, keeps the typed wording and Try again loads theirs", async () => {
    let refusedOnce = false;
    let failReads = true;
    const theirs = { en: { ...WORDING.en, title: "Their title" } };
    mount(
      server({
        run: () =>
          !refusedOnce
            ? ok(run())
            : failReads
              ? refused(500, "INTERNAL", "read failed")
              : ok(run({ version: 5, content: theirs })),
        write: () => {
          refusedOnce = true;
          return refused(412, "STALE_VERSION");
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save wording" }));
    expect(await within(dialog).findByText(/newer wording could not be loaded/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Mine");
    failReads = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    const theirsRegion = await within(dialog).findByRole("region", { name: "Their saved wording" });
    expect(theirsRegion.textContent).toContain("Their title");
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Mine");
  });

  it("Replace with theirs puts their wording in the editor", async () => {
    let saved = false;
    const theirs = { en: { ...WORDING.en, title: "Their title" } };
    mount(
      server({
        run: () => ok(saved ? run({ version: 5, content: theirs }) : run()),
        write: () => {
          saved = true;
          return refused(412, "STALE_VERSION");
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save wording" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Replace with theirs" }));
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Their title");
  });

  it("a 409 on the wording (the run left draft) closes the dialog and says why on the page", async () => {
    mount(
      server({ write: () => refused(409, "MAILING_RUN_NOT_EDITABLE", "the wording is locked") }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save wording" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("the wording is locked"),
    );
  });

  it("is offered only for a draft", async () => {
    mount(server({ run: () => ok(run({ status: "ready" })) }));
    await screen.findByRole("heading", { name: /December holiday card/ });
    expect(screen.queryByRole("button", { name: "Edit wording" })).toBeNull();
  });

  it("unsaved wording asks before it is discarded; keeping it leaves the dialog and the text", async () => {
    mount(server({}));
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // announced, not just shown
    expect(within(dialog).getByRole("alert").textContent).toMatch(
      /You have unsaved wording\. Discard it\?/,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Changed");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(within(dialog).getByText(/You have unsaved wording/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an untouched wording dialog closes at once", async () => {
    mount(server({}));
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("every control is inert while the wording saves, and the dialog cannot be closed", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mount(
      server({
        write: async () => {
          await held;
          return ok(run({ version: 5 }));
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save wording" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(inert(within(dialog).getByLabelText("Title"))).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("limits mirror the server: a paragraph over 2000 characters blocks Save, a thirteenth cannot be added", async () => {
    const { calls } = mount(server({}));
    fireEvent.click(await screen.findByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Paragraph 1"), {
      target: { value: "x".repeat(2001) },
    });
    expect(within(dialog).getByText("Paragraph 1 is over 2000 characters.")).toBeTruthy();
    const save = within(dialog).getByRole("button", { name: "Save wording" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Paragraph 1"), { target: { value: "Short." } });
    expect(save.disabled).toBe(false);
    const add = within(dialog).getByRole("button", {
      name: "Add a paragraph",
    }) as HTMLButtonElement;
    for (let i = 0; i < 11; i += 1) fireEvent.click(add);
    expect(within(dialog).getByText("12 of 12 paragraphs")).toBeTruthy();
    expect(add.disabled).toBe(true);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("filters the items, keeps the rows while the filter reads, and Load more appends the next page", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mount(
      server({
        run: () => ok(run({ status: "ready" })),
        items: async (q) => {
          if (q.get("status") === "excluded") await held;
          if (q.get("cursor") === "c2")
            return ok({
              data: [item({ contactId: CONTACT_B, ordinal: 2 })],
              next_cursor: null,
              has_more: false,
            });
          return ok({ data: [item({ ordinal: 1 })], next_cursor: "c2", has_more: true });
        },
      }),
    );
    await screen.findByRole("link", { name: "Open contact aaaaaaaa" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("link", { name: "Open contact bbbbbbbb" });
    expect(screen.getByRole("link", { name: "Open contact aaaaaaaa" })).toBeTruthy();
    expect(calls.some((c) => c.path === ITEMS_PATH && c.query.get("cursor") === "c2")).toBe(true);

    fireEvent.change(screen.getByLabelText("Item status"), { target: { value: "excluded" } });
    await waitFor(() =>
      expect(calls.some((c) => c.path === ITEMS_PATH && c.query.get("status") === "excluded")).toBe(
        true,
      ),
    );
    // the read is held: the rows already shown stay
    expect(screen.getByRole("link", { name: "Open contact bbbbbbbb" })).toBeTruthy();
    release();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Open contact bbbbbbbb" })).toBeNull(),
    );
  });
});

describe("mailing run — accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = mount(
      server({
        run: () => ok(run({ status: "ready" })),
        items: () => ok({ data: [item()], next_cursor: null, has_more: false }),
      }),
    );
    await screen.findByRole("link", { name: "Open contact aaaaaaaa" });
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
