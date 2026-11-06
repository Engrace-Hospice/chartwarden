import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: the mailing runs list (route 44).
// Rows with item counts and a status chip that link to the run, a status filter, cursor "Load more"; a 403 renders nothing, any other
// failure is announced, and a filter change or a page load never blanks the rows already shown.
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MailingRuns } from "./mailing-runs";

const RUNS_PATH = "/api/v1/bereavement/mailings/runs";
const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const run = (over: Record<string, unknown> = {}) => ({
  runId: RUN_A,
  runKind: "newsletter",
  mailingKey: "newsletter_quarterly",
  occurrenceKey: "newsletter_quarterly:2026-Q4",
  scheduledFor: "2026-10-15",
  status: "ready",
  content: {},
  recipientCount: 5,
  excludedCount: 2,
  failureCode: null,
  hasDocument: true,
  generatedAt: "2026-10-01T10:00:00.000Z",
  mailedAt: null,
  itemCounts: { included: 5, excluded: 2, logged: 0, excludedAfterRender: 0 },
  version: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

type Reply = { status: number; body?: unknown } | "reject";

function mount(
  answer: (query: URLSearchParams) => Reply | Promise<Reply>,
  permissions = ["bereavement.mailing.read"],
) {
  const queries: URLSearchParams[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), "http://localhost");
    void init;
    queries.push(url.searchParams);
    const reply = await answer(url.searchParams);
    if (reply === "reject") throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1", permissions }}>
        <MemoryRouter>
          <MailingRuns />
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { queries, ...view };
}

const page = (data: unknown[], next: string | null = null) => ({
  status: 200,
  body: { data, next_cursor: next, has_more: next !== null },
});
const refused = (status: number, code: string, message = "refused"): Reply => ({
  status,
  body: { error: { code, message } },
});

describe("mailing runs — what it shows", () => {
  it("lists each run with its status chip and item counts, and links to it", async () => {
    mount(() =>
      page([
        run(),
        run({
          runId: RUN_B,
          mailingKey: "mothers_day",
          runKind: "holiday",
          scheduledFor: "2026-05-10",
          status: "mailed",
          itemCounts: { included: 0, excluded: 1, logged: 4, excludedAfterRender: 2 },
        }),
      ]),
    );
    const link = await screen.findByRole("link", {
      name: "Open the Quarterly newsletter run for 2026-10-15",
    });
    expect(link.getAttribute("href")).toBe(`/bereavement/mailings/runs/${RUN_A}`);
    const table = screen.getByRole("table", { name: "Mailing runs" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("Ready")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Mailed")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("4")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("2")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open the Mother's Day letter run for 2026-05-10" }),
    ).toBeTruthy();
  });

  it("says plainly that there are no runs", async () => {
    mount(() => page([]));
    expect(await screen.findByText("No mailing runs")).toBeTruthy();
  });

  it("links to the settings only for a reader who may manage them", async () => {
    mount(() => page([run()]), ["bereavement.mailing.read", "bereavement.mailing.manage"]);
    expect(await screen.findByRole("link", { name: "Mailing settings" })).toBeTruthy();
  });

  it("does not link to the settings for a read-only reader", async () => {
    mount(() => page([run()]));
    await screen.findByRole("table", { name: "Mailing runs" });
    expect(screen.queryByRole("link", { name: "Mailing settings" })).toBeNull();
  });
});

describe("mailing runs — who sees it, and how it fails", () => {
  it("a 403 renders nothing at all", async () => {
    const { container } = mount(() => refused(403, "FORBIDDEN"));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a server error is announced with Try again, and the retry loads the runs", async () => {
    let reads = 0;
    const { queries } = mount(() => {
      reads += 1;
      return reads === 1 ? refused(500, "INTERNAL", "boom") : page([run()]);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    // the page is up (heading and filter), not a bare error
    expect(screen.getByRole("heading", { name: "Mailing runs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Mailing runs" })).toBeTruthy();
    expect(queries).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a dropped connection is announced, not a blank page", async () => {
    mount(() => "reject");
    expect((await screen.findByRole("alert")).textContent).toMatch(/connection dropped/i);
  });

  it("a failed filter read is announced and the rows already shown stay", async () => {
    mount((q) => (q.get("status") === "failed" ? refused(500, "INTERNAL", "boom") : page([run()])));
    await screen.findByRole("table", { name: "Mailing runs" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.getByRole("table", { name: "Mailing runs" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the Quarterly newsletter run/ })).toBeTruthy();
  });
});

describe("mailing runs — filtering and paging", () => {
  it("sends the status filter, and keeps the rows on screen while the read is pending", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { queries } = mount(async (q) => {
      if (q.get("status") === "draft") {
        await held;
        return page([
          run({
            runId: RUN_C,
            status: "draft",
            scheduledFor: "2026-12-15",
            mailingKey: "holiday_december",
          }),
        ]);
      }
      return page([run()]);
    });
    await screen.findByRole("table", { name: "Mailing runs" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "draft" } });
    await waitFor(() => expect(queries.some((q) => q.get("status") === "draft")).toBe(true));
    // the first rows stay while the filtered read is pending
    expect(screen.getByRole("link", { name: /Open the Quarterly newsletter run/ })).toBeTruthy();
    release();
    expect(
      await screen.findByRole("link", {
        name: "Open the December holiday card run for 2026-12-15",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the Quarterly newsletter run/ })).toBeNull();
  });

  it("Load more sends the cursor and appends the next page", async () => {
    const { queries } = mount((q) =>
      q.get("cursor") === "next-1"
        ? page([run({ runId: RUN_B, mailingKey: "fathers_day", scheduledFor: "2026-06-21" })])
        : page([run()], "next-1"),
    );
    await screen.findByRole("table", { name: "Mailing runs" });
    expect(screen.getByText("1+ runs shown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("link", { name: "Open the Father's Day letter run for 2026-06-21" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the Quarterly newsletter run/ })).toBeTruthy();
    expect(queries.some((q) => q.get("cursor") === "next-1")).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("a failed Load more is announced and keeps what was loaded", async () => {
    mount((q) =>
      q.get("cursor") === "next-1" ? refused(500, "INTERNAL", "boom") : page([run()], "next-1"),
    );
    await screen.findByRole("table", { name: "Mailing runs" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.getByRole("link", { name: /Open the Quarterly newsletter run/ })).toBeTruthy();
  });
});

describe("mailing runs — accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = mount(() => page([run()]));
    await screen.findByRole("table", { name: "Mailing runs" });
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
