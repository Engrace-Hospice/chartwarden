// @vitest-environment jsdom
// The composer's care-plan picker on its own (ADR-0114 VN-D15): a link or unlink in flight keeps keyboard focus on the box that was pressed,
// and a re-read of the visit's links that was served before the change committed never undoes it (S1 React review). Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposerCarePlanPicker } from "../composer-care-plan-picker";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const GOAL_ID = "dddddddd-4444-4444-8444-dddddddddddd";
const LINK_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const BASE = `/api/v1/encounters/${ENC}`;
const GOAL_LABEL = "Keep the patient comfortable at rest";
const ENCOUNTER = {
  id: ENC,
  patientId: PATIENT,
  admissionId: "adm-1",
  encounterType: "routine_visit",
  discipline: "rn",
};

interface Link {
  id: string;
  encounterId: string;
  goalId: string | null;
  interventionId: string | null;
  problemId: null;
  createdAt: string;
}
let links: Link[];
let calls: Call[];

beforeEach(() => {
  links = [];
  calls = [];
});
afterEach(cleanup);

/** A promise a test settles by hand, to hold a request in flight. */
function gate() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const linkReads = (): number =>
  calls.filter((c) => c.method === "GET" && c.path === `${BASE}/care-plan-links`).length;

function mountPicker(over: Record<string, Responder> = {}) {
  const routes: Record<string, Responder> = {
    "GET /api/v1/internal/care-plan/relevant-elements": () => ({
      body: {
        planId: "plan-1",
        patientId: PATIENT,
        problems: [],
        goals: [
          {
            goalId: GOAL_ID,
            problemId: "prob-1",
            text: GOAL_LABEL,
            source: "clinical",
            status: "in_progress",
          },
        ],
        interventions: [],
        redacted: false,
      },
    }),
    [`GET ${BASE}/care-plan-links`]: () => ({ body: { links } }),
    [`POST ${BASE}/care-plan-links`]: () => {
      const created: Link = {
        id: LINK_ID,
        encounterId: ENC,
        goalId: GOAL_ID,
        interventionId: null,
        problemId: null,
        createdAt: "2026-11-17T10:00:00Z",
      };
      links = [...links, created];
      return { status: 201, body: created };
    },
    ...over,
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(routes, calls) });
  const ui = (revision: number) => (
    <ApiClientProvider client={client}>
      <ComposerCarePlanPicker
        encounter={ENCOUNTER}
        editable
        revision={revision}
        onChanged={() => undefined}
      />
    </ApiClientProvider>
  );
  const view = render(ui(0));
  return { user: userEvent.setup(), bump: (revision: number) => view.rerender(ui(revision)) };
}

describe("a link in flight", () => {
  it("leaves the pressed box focusable and focused, saying why it will not act yet", async () => {
    const post = gate();
    const { user } = mountPicker({
      [`POST ${BASE}/care-plan-links`]: async () => {
        await post.promise;
        links = [
          {
            id: LINK_ID,
            encounterId: ENC,
            goalId: GOAL_ID,
            interventionId: null,
            problemId: null,
            createdAt: "2026-11-17T10:00:00Z",
          },
        ];
        return { status: 201, body: links[0] };
      },
    });
    const goal = await screen.findByRole("checkbox", { name: GOAL_LABEL });
    await waitFor(() => expect(goal).toBeEnabled());
    await user.click(goal);
    await waitFor(() => expect(goal).toHaveAttribute("aria-disabled", "true"));
    expect(goal).not.toBeDisabled();
    expect(goal).toHaveFocus();
    expect(goal).toHaveAccessibleDescription(/saving/i);
    await user.click(goal);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    post.open();
    await waitFor(() => expect(goal).toBeChecked());
    await waitFor(() => expect(goal).not.toHaveAttribute("aria-disabled"));
    expect(goal).toHaveFocus();
  });
});

describe("a re-read of the links while a link is being saved", () => {
  it("does not undo the link when its answer, read before the save committed, lands after it", async () => {
    const post = gate();
    const staleRead = gate();
    let reads = 0;
    const { user, bump } = mountPicker({
      [`GET ${BASE}/care-plan-links`]: async () => {
        reads += 1;
        const snapshot = links;
        if (reads === 2) await staleRead.promise;
        return { body: { links: snapshot } };
      },
      [`POST ${BASE}/care-plan-links`]: async () => {
        await post.promise;
        const created: Link = {
          id: LINK_ID,
          encounterId: ENC,
          goalId: GOAL_ID,
          interventionId: null,
          problemId: null,
          createdAt: "2026-11-17T10:00:00Z",
        };
        links = [...links, created];
        return { status: 201, body: created };
      },
    });
    const goal = await screen.findByRole("checkbox", { name: GOAL_LABEL });
    await waitFor(() => expect(goal).toBeEnabled());
    await user.click(goal);
    // A draft resolve changed the visit's links: the picker reads them again, served before the save below commits.
    bump(1);
    await waitFor(() => expect(linkReads()).toBe(2));
    // The links are known, so the re-read does not make the box `disabled` (that would drop the focus the pressed box holds).
    expect(goal).not.toBeDisabled();
    expect(goal).toHaveFocus();
    post.open();
    await waitFor(() => expect(goal).toBeChecked());
    expect(goal).not.toBeDisabled();
    expect(goal).toHaveFocus();
    staleRead.open();
    await waitFor(() => expect(linkReads()).toBe(3));
    await waitFor(() => expect(goal).not.toHaveAttribute("aria-disabled"));
    expect(goal).toBeEnabled();
    expect(goal).toBeChecked();
    expect(goal).toHaveFocus();
  });
});

// The visit's links are known once they have been read; a later re-read (a draft resolve changed them) must not take the boxes away from
// someone who is on one: they wait (aria-disabled, still focusable, saying why) and the first load alone is a native `disabled`.
describe("a re-read of links that are already known", () => {
  it("keeps the focused box focusable and focused, waiting and saying why, and acts again once the read lands", async () => {
    const reread = gate();
    const firstRead = gate();
    let reads = 0;
    const { user, bump } = mountPicker({
      [`GET ${BASE}/care-plan-links`]: async () => {
        reads += 1;
        if (reads === 1) await firstRead.promise;
        if (reads === 2) await reread.promise;
        return { body: { links } };
      },
    });
    const goal = await screen.findByRole("checkbox", { name: GOAL_LABEL });
    // Nothing known yet: a native disabled box, with its reason beside it.
    expect(goal).toBeDisabled();
    firstRead.open();
    await waitFor(() => expect(goal).toBeEnabled());
    goal.focus();
    bump(1);
    await waitFor(() => expect(linkReads()).toBe(2));
    await waitFor(() => expect(goal).toHaveAttribute("aria-disabled", "true"));
    expect(goal).not.toBeDisabled();
    expect(goal).toHaveFocus();
    expect(goal).toHaveAccessibleDescription(/updating|loading|reading/i);
    // It does nothing while the links are read again.
    await user.click(goal);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    reread.open();
    await waitFor(() => expect(goal).not.toHaveAttribute("aria-disabled"));
    expect(goal).toHaveFocus();
    await user.click(goal);
    await waitFor(() => expect(goal).toBeChecked());
  });
});
