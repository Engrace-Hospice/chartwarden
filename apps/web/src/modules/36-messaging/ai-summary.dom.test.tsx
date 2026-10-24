// M36 WP 6.5 (ADR-0095) - the AI summary panel: absent unless enabled; labelled "draft - not verified"; every point cited; an uncertainty line always;
// model text is TEXT (never markup); "Copy to draft" is the only way text reaches the composer and nothing here can send; the human decision is recorded.
import type { MessagingAiDraftDto, MessagingAiSummaryDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { type JSX, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSummaryPanel } from "./ai-summary-panel";
import { AI_GUARDRAIL, AI_PANEL_TITLE } from "./ai-wording";
import { useAiAssist, useAiEnabled } from "./use-ai-assist";

const STATUS = "/api/v1/messaging/ai/status";
const SUMMARY = "/api/v1/messaging/channels/{id}/summaries";
const DRAFT = "/api/v1/messaging/channels/{id}/draft-replies";
const OUTCOME = "/api/v1/messaging/channels/{id}/ai-outcomes";

const summary = (over: Partial<MessagingAiSummaryDto> = {}): MessagingAiSummaryDto => ({
  label: "AI summary - draft - not verified",
  invocation_id: "11111111-1111-4111-8111-111111111111",
  invoked_at: "2026-10-23T12:00:00.000Z",
  status: "ok",
  points: [
    {
      text: "Pain reported since morning",
      confidence: "high",
      sources: [
        { n: 1, message_id: "m-loaded", sent_at: "2026-10-23T09:00:00.000Z" },
        { n: 2, message_id: "m-not-loaded", sent_at: "2026-10-23T10:00:00.000Z" },
      ],
    },
  ],
  open_questions: ["Whether PRN was given"],
  included_count: 28,
  withheld_count: 2,
  input_hash: "h",
  ...over,
});
const drafts = (): MessagingAiDraftDto => ({
  label: "AI draft - edit before sending",
  invocation_id: "22222222-2222-4222-8222-222222222222",
  invoked_at: "2026-10-23T12:01:00.000Z",
  drafts: [{ text: "On it, calling the family." }],
  included_count: 28,
  withheld_count: 2,
});

function Harness({ jump = vi.fn() }: { jump?: (id: string) => void }): JSX.Element {
  const enabled = useAiEnabled();
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const ai = useAiAssist("chan-1", draft);
  return (
    <main>
      {enabled ? (
        <button type="button" aria-expanded={ai.open} onClick={ai.toggle}>
          AI summary
        </button>
      ) : null}
      {enabled && ai.open ? (
        <AiSummaryPanel
          view={ai.view}
          loadedMessageIds={new Set(["m-loaded"])}
          canDraft
          copiedText={copied}
          onClose={ai.close}
          onCancel={ai.cancel}
          onRegenerate={ai.regenerate}
          onNotUseful={ai.notUseful}
          onDraftReply={ai.draftReply}
          onBackToSummary={ai.backToSummary}
          onJump={jump}
          onCopyToDraft={(text) => {
            ai.copyToDraft(text);
            setCopied(text);
            setDraft((c) => (c.trim() ? `${c}\n${text}` : text));
          }}
        />
      ) : null}
      <label>
        Message
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
    </main>
  );
}

function mount(opts: { enabled?: boolean; summary?: () => unknown; draft?: () => unknown } = {}) {
  const GET = vi.fn((path: string) =>
    Promise.resolve(
      path === STATUS
        ? { data: { enabled: opts.enabled ?? true }, response: { status: 200 } }
        : { error: {}, response: { status: 404 } },
    ),
  );
  const POST = vi.fn((path: string) => {
    if (path === SUMMARY)
      return Promise.resolve(opts.summary?.() ?? { data: summary(), response: { status: 200 } });
    if (path === DRAFT)
      return Promise.resolve(opts.draft?.() ?? { data: drafts(), response: { status: 200 } });
    return Promise.resolve({ response: { status: 204 } });
  });
  const jump = vi.fn();
  render(
    <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
      <Harness jump={jump} />
    </ApiClientProvider>,
  );
  return { GET, POST, jump };
}
const outcomes = (POST: ReturnType<typeof vi.fn>) =>
  POST.mock.calls
    .filter((c) => c[0] === OUTCOME)
    .map((c) => (c[1] as { body: { outcome: string } }).body.outcome);

afterEach(() => cleanup());

describe("AI summary panel", () => {
  it("is absent when the tenant flag or permission says no (no button, no request)", async () => {
    const { GET, POST } = mount({ enabled: false });
    await waitFor(() => expect(GET).toHaveBeenCalledWith(STATUS));
    expect(screen.queryByRole("button", { name: "AI summary" })).toBeNull();
    expect(POST).not.toHaveBeenCalled();
  });

  it("generates only on the explicit click, then shows the label, the guardrail, cited points, the uncertainty line and the counts", async () => {
    const { POST } = mount();
    const trigger = await screen.findByRole("button", { name: "AI summary" });
    expect(POST).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    expect(await screen.findByText(AI_PANEL_TITLE)).toBeTruthy();
    expect(screen.getByText(AI_GUARDRAIL)).toBeTruthy();
    expect(await screen.findByText("Pain reported since morning")).toBeTruthy();
    expect(screen.getByText(/Unclear from the messages:.*Whether PRN was given/)).toBeTruthy();
    expect(
      screen.getByText("Based on 28 messages you can see · 2 messages not included"),
    ).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "AI summary" })).toBeTruthy();
    // the panel offers no way to send, order or create a task
    for (const name of [/^send/i, /order/i, /create task/i])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("makes a citation a link only for a message that is loaded; the other stays plain text", async () => {
    const { jump } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    const cite = await screen.findByRole("button", { name: "Source message 1" });
    fireEvent.click(cite);
    expect(jump).toHaveBeenCalledWith("m-loaded");
    expect(screen.queryByRole("button", { name: "Source message 2" })).toBeNull();
    expect(screen.getByText("[2]")).toBeTruthy();
  });

  it("always shows an uncertainty line, even when the model listed none", async () => {
    mount({
      summary: () => ({ data: summary({ open_questions: [] }), response: { status: 200 } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    expect(
      await screen.findByText(/No open questions were found, but a summary can miss things/),
    ).toBeTruthy();
  });

  it("renders model text as text: markup in a point is shown literally and creates no element", async () => {
    mount({
      summary: () => ({
        data: summary({
          points: [
            {
              text: '<img src=x onerror="alert(1)"> [click](https://evil.example)',
              confidence: "low",
              sources: [{ n: 1, message_id: "m-loaded", sent_at: "2026-10-23T09:00:00.000Z" }],
            },
          ],
        }),
        response: { status: 200 },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    await screen.findByText(/<img src=x/);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
  });

  it("says 'Too little to summarise' and offers no points", async () => {
    mount({
      summary: () => ({
        data: summary({ status: "insufficient_context", points: [], open_questions: [] }),
        response: { status: 200 },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    expect(await screen.findByText("Too little to summarise.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy to draft" })).toBeNull();
  });

  it.each([
    [{ error: { error: { code: "AI_UNAVAILABLE" } }, response: { status: 503 } }, /AI unavailable/],
    [{ error: {}, response: { status: 429 } }, /AI limit/],
    [
      { error: { error: { code: "AI_OUTPUT_REFUSED" } }, response: { status: 422 } },
      /stated a dose, an order or a diagnosis/,
    ],
    [
      { error: { error: { code: "AI_NOT_AVAILABLE_FOR_CHANNEL" } }, response: { status: 422 } },
      /not available for this conversation/,
    ],
  ])("shows a plain problem sentence instead of an answer (%#)", async (response, text) => {
    mount({ summary: () => response });
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("Copy to draft puts text in the composer for the person to edit, records accepted, then edited once when they change it", async () => {
    const { POST } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy to draft" }));
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(box.value).toContain("- Pain reported since morning");
    await waitFor(() => expect(outcomes(POST)).toEqual(["accepted"]));
    expect(screen.getByText(/Copied to the message box/)).toBeTruthy();
    fireEvent.change(box, { target: { value: "I will call the family." } });
    await waitFor(() => expect(outcomes(POST)).toEqual(["accepted", "edited"]));
    fireEvent.change(box, { target: { value: "I will call the family now." } });
    await act(async () => undefined);
    expect(outcomes(POST)).toEqual(["accepted", "edited"]);
  });

  it("a copied text that is then sent as it is (box cleared) stays accepted", async () => {
    const { POST } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy to draft" }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "" } });
    await act(async () => undefined);
    expect(outcomes(POST)).toEqual(["accepted"]);
  });

  it("Not useful and closing without copying record rejected; Regenerate asks again", async () => {
    const { POST } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not useful" }));
    await waitFor(() => expect(outcomes(POST)).toEqual(["rejected"]));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("a draft reply goes to the composer only on Copy to draft; the panel sends nothing", async () => {
    const { POST } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft a reply" }));
    expect(await screen.findByText("On it, calling the family.")).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Copy to draft/ }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "On it, calling the family.",
    );
    // the only POSTs are: the summary, the draft, and (after the click) the decision - never a message
    const paths = POST.mock.calls.map((c) => c[0]);
    expect(paths.filter((p) => !(p === SUMMARY || p === DRAFT || p === OUTCOME))).toEqual([]);
  });

  it("closes with Escape and has no axe violations", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "AI summary" }));
    await screen.findByText("Pain reported since morning");
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
