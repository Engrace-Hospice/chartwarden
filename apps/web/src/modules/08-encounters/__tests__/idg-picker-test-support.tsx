// Test support for the IDG action item picker's jsdom suites (ADR-0114 S5b): a stub API with a list the test edits, the providers the picker needs and the
// queries the suites share. Synthetic data only. Imported only by *.dom.test.tsx files, never by the app.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ComposerIdgActionItemPicker } from "../composer-idg-action-item-picker";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

export const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const ITEM_1 = "dddddddd-4444-4444-8444-dddddddddd01";
export const ITEM_2 = "dddddddd-4444-4444-8444-dddddddddd02";
export const LIST = `/api/v1/encounters/${ENC}/idg-action-items`;
export const LINK = `/api/v1/encounters/${ENC}/idg-action-item`;
export const TITLE = "IDG follow-up item";
export const DECOY_TITLE = "Call the pharmacy about the SYNTHETIC-DECOY title";
export const NO_ACCESS_CODE = "IDG_ACTION_PERMISSION_REQUIRED";

export interface Item {
  actionItemId: string;
  meetingDate: string;
  decisionKind: string;
  decisionLabel: string;
  dueDate: string | null;
  status: string;
  linked: boolean;
  // Not part of the API: a title that must never reach the screen even if it did arrive.
  title?: string;
}

export const initialItems = (): Item[] => [
  {
    actionItemId: ITEM_1,
    meetingDate: "2026-11-10",
    decisionKind: "referral",
    decisionLabel: "a referral",
    dueDate: "2026-11-17",
    status: "open",
    linked: true,
    title: DECOY_TITLE,
  },
  {
    actionItemId: ITEM_2,
    meetingDate: "2026-11-03",
    decisionKind: "care_plan_update",
    decisionLabel: "an update to the plan of care",
    dueDate: null,
    status: "in_progress",
    linked: false,
  },
];

/** What the stub API holds and what it was asked: reset before every test. */
export const world: { items: Item[]; calls: Call[] } = { items: [], calls: [] };
export const resetWorld = (): void => {
  world.items = initialItems();
  world.calls = [];
};

export const view = () => ({ patientId: PATIENT, items: world.items });
export const puts = (): Call[] => world.calls.filter((c) => c.method === "PUT");
export const reads = (): Call[] => world.calls.filter((c) => c.method === "GET");

/** A promise a test settles by hand, to hold a request in flight. */
export function gate() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The server's answer to a choice: the list with that one item linked. Clearing answers an empty list, as the API does (the list is read again with GET). */
export const applyLink: Responder = (call) => {
  const chosen = (call.body as { actionItemId: string | null }).actionItemId;
  world.items = world.items.map((item) => ({ ...item, linked: item.actionItemId === chosen }));
  return { body: chosen === null ? { patientId: PATIENT, items: [] } : view() };
};
export const refusal = (status: number, code: string, message = "refused"): Responder => {
  return () => ({ status, body: { error: { code, message } } });
};
/** The 403 for a viewer without the `idg.act` key: the CODE is what the picker matches; the message only names the key. */
export const noIdgAct = (): { status: number; body: unknown } => ({
  status: 403,
  body: { error: { code: NO_ACCESS_CODE, message: "requires permission 'idg.act'" } },
});

export function mount(
  over: Record<string, Responder> = {},
  props: { readonly editable?: boolean; readonly onChanged?: () => void } = {},
) {
  const routes: Record<string, Responder> = {
    [`GET ${LIST}`]: () => ({ body: view() }),
    [`PUT ${LINK}`]: applyLink,
    ...over,
  };
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(routes, world.calls),
  });
  const onChanged = props.onChanged ?? vi.fn();
  const rendered = render(
    <ApiClientProvider client={client}>
      <ComposerIdgActionItemPicker
        encounterId={ENC}
        editable={props.editable ?? true}
        onChanged={onChanged}
      />
    </ApiClientProvider>,
  );
  return { user: userEvent.setup(), onChanged, unmount: rendered.unmount };
}

export const referral = /a referral/;
export const planUpdate = /plan of care/;
export const radio = (name: RegExp | string) => screen.getByRole("radio", { name });
export const panel = () => screen.getByRole("group", { name: TITLE });

/** Turns of the event loop given to the answers already on their way, counted rather than timed: enough for a stub answer to be parsed and rendered. */
const SETTLE_TURNS = 20;
/** Lets every answer already on its way be rendered (a panel that is absent must be absent after the answer, not before it). */
export const settled = (): Promise<void> =>
  act(async () => {
    for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
