// M36 WP 3.10: the dialog sends the typed text verbatim, shows the fixed notices, reuses one key pair per open, and maps refusals.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MedicationQuestionDialog } from "./medication-question-dialog";
import {
  ASK_PATH,
  COLLEAGUE,
  NURSE,
  mountWithClient,
  optionsAnswer,
  refusal,
  sentAnswer,
} from "./medication-question-test-fixture";
import {
  DESCRIBE_MEDICATION_HINT,
  NOT_EMERGENCY_NOTICE,
  NO_ORDER_NOTICE,
  SEND_WITHOUT_NURSE_LABEL,
  goesToLine,
} from "./medication-question-wording";
import type { EnabledOptions } from "./use-medication-question-options";

const OPTIONS = optionsAnswer().data as unknown as EnabledOptions;
const open = (
  options: EnabledOptions = OPTIONS,
  post?: ReturnType<typeof vi.fn>,
  get?: (p: string) => unknown,
) => {
  const onSent = vi.fn();
  const onClose = vi.fn();
  const mounted = mountWithClient(
    <MedicationQuestionDialog channelId="c1" options={options} onClose={onClose} onSent={onSent} />,
    { post, get },
  );
  return { ...mounted, onSent, onClose };
};
const type = (text: string) =>
  userEvent.type(screen.getByLabelText("Your question"), text, { delay: null });
const send = () => userEvent.click(screen.getByRole("button", { name: "Send question" }));
const lastBody = (POST: ReturnType<typeof vi.fn>) => POST.mock.calls.at(-1)?.[1];

describe("MedicationQuestionDialog", () => {
  it("shows the no-order and not-the-emergency notices and the assigned nurse", () => {
    open();
    expect(screen.getByText(NO_ORDER_NOTICE)).toBeTruthy();
    expect(screen.getByText(NOT_EMERGENCY_NOTICE)).toBeTruthy();
    expect(screen.getByText(goesToLine(NURSE.display_name))).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryAllByRole("link")).toHaveLength(0);
    expect(within(dialog).queryAllByRole("button", { name: /order/i })).toHaveLength(0);
  });

  it("sends the typed text verbatim with the key pair and the chosen medication", async () => {
    const { POST, onSent } = open();
    await type("  Is 5 mg  too much?\n");
    await userEvent.selectOptions(await screen.findByLabelText("Medication (optional)"), "med1");
    await send();
    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ routed: true, created: true }));
    const [path, init] = POST.mock.calls[0] as [
      string,
      { params: { header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe(ASK_PATH);
    expect(init.body.text).toBe("  Is 5 mg  too much?\n");
    expect(init.body.medication_id).toBe("med1");
    expect(init.body).not.toHaveProperty("allow_unrouted");
    expect(init.params.header["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    expect(init.body.client_message_id).toMatch(/[0-9a-f-]{36}/);
  });

  it("refuses an empty question without calling the server", async () => {
    const { POST } = open();
    await send();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Write your question/);
    expect(POST).not.toHaveBeenCalled();
  });

  it("reuses the same key pair on a retry within one open", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(502, "BAD_GATEWAY"))
      .mockResolvedValueOnce(sentAnswer());
    const { onSent } = open(OPTIONS, post);
    await type("Q");
    await send();
    await screen.findByRole("alert");
    await send();
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    const [first, second] = post.mock.calls.map(([, init]) => init);
    expect(second.params.header["Idempotency-Key"]).toBe(first.params.header["Idempotency-Key"]);
    expect(second.body.client_message_id).toBe(first.body.client_message_id);
  });

  it("rotates only the header key after a 409", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(409, "IDEMPOTENCY_CONFLICT"))
      .mockResolvedValueOnce(sentAnswer());
    open(OPTIONS, post);
    await type("Q");
    await send();
    await screen.findByRole("alert");
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [first, second] = post.mock.calls.map(([, init]) => init);
    expect(second.params.header["Idempotency-Key"]).not.toBe(
      first.params.header["Idempotency-Key"],
    );
    expect(second.body.client_message_id).toBe(first.body.client_message_id);
  });

  it("offers send-without-a-nurse only after a no-nurse refusal, then sends allow_unrouted", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(422, "MEDICATION_QUESTION_NO_NURSE"))
      .mockResolvedValueOnce(sentAnswer({ routed: false }));
    const { onSent } = open(OPTIONS, post);
    expect(screen.queryByRole("button", { name: SEND_WITHOUT_NURSE_LABEL })).toBeNull();
    await type("Q");
    await send();
    expect((await screen.findByRole("alert")).textContent).toMatch(/No nurse is assigned/);
    await userEvent.click(screen.getByRole("button", { name: SEND_WITHOUT_NURSE_LABEL }));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ routed: false, created: true }));
    expect(lastBody(post).body.allow_unrouted).toBe(true);
  });

  it("offers that path at once when the options have no nurse", () => {
    open({ ...OPTIONS, nurse: null });
    expect(screen.getByRole("button", { name: SEND_WITHOUT_NURSE_LABEL })).toBeTruthy();
  });

  it("sends the chosen colleague as the assignee", async () => {
    const { POST } = open();
    await type("Q");
    await userEvent.selectOptions(screen.getByLabelText("Send to"), COLLEAGUE.user_id);
    await send();
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(lastBody(POST).body.assignee_user_id).toBe(COLLEAGUE.user_id);
  });

  it("hides the medication select and says to describe it when the list is refused", async () => {
    open(OPTIONS, undefined, (path) =>
      path.includes("medication-orders") ? { error: {}, response: { status: 403 } } : {},
    );
    expect(await screen.findByText(DESCRIBE_MEDICATION_HINT)).toBeTruthy();
    expect(screen.queryByLabelText("Medication (optional)")).toBeNull();
  });

  it("maps a refused link to its message and keeps the dialog open", async () => {
    const post = vi.fn().mockResolvedValue(refusal(422, "CLINICAL_LINK_NOT_AVAILABLE"));
    const { onSent } = open(OPTIONS, post);
    await type("Q");
    await send();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/cannot link that medication/)).toBeTruthy();
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("rotates both ids when the text is edited after a refused attempt", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(422, "VALIDATION_FAILED"))
      .mockResolvedValueOnce(sentAnswer());
    open(OPTIONS, post);
    await type("Q");
    await send();
    await screen.findByRole("alert");
    await type(" more");
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [first, second] = post.mock.calls.map(([, init]) => init);
    expect(second.params.header["Idempotency-Key"]).not.toBe(
      first.params.header["Idempotency-Key"],
    );
    expect(second.body.client_message_id).not.toBe(first.body.client_message_id);
  });

  it("rotates both ids when the medication or the person changes", async () => {
    const post = vi.fn().mockResolvedValue(refusal(502, "BAD_GATEWAY"));
    open(OPTIONS, post);
    await type("Q");
    await send();
    await screen.findByRole("alert");
    await userEvent.selectOptions(await screen.findByLabelText("Medication (optional)"), "med1");
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await userEvent.selectOptions(screen.getByLabelText("Send to"), COLLEAGUE.user_id);
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    const [a, b, c] = post.mock.calls.map(([, init]) => init);
    expect(new Set([a, b, c].map((x) => x.body.client_message_id)).size).toBe(3);
    expect(new Set([a, b, c].map((x) => x.params.header["Idempotency-Key"])).size).toBe(3);
  });

  it("rotates both ids when switching to send-without-a-nurse", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(422, "MEDICATION_QUESTION_NO_NURSE"))
      .mockResolvedValueOnce(sentAnswer({ routed: false }));
    open(OPTIONS, post);
    await type("Q");
    await send();
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: SEND_WITHOUT_NURSE_LABEL }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [first, second] = post.mock.calls.map(([, init]) => init);
    expect(second.body.client_message_id).not.toBe(first.body.client_message_id);
    expect(second.params.header["Idempotency-Key"]).not.toBe(
      first.params.header["Idempotency-Key"],
    );
  });

  it("closes on Escape", async () => {
    const { onClose } = open();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores Escape while a send is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    const post = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { onClose } = open(OPTIONS, post);
    await type("Q");
    await send();
    await waitFor(() => expect(post).toHaveBeenCalled());
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    release(sentAnswer());
  });

  it("sends on Ctrl+Enter and on Cmd+Enter", async () => {
    const { POST } = open();
    await type("Q");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
  });

  it("marks the empty question invalid and links the error to it", async () => {
    open();
    await send();
    const alert = await screen.findByRole("alert");
    const field = screen.getByLabelText("Your question");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("does not mark the question invalid for a server refusal", async () => {
    open(OPTIONS, vi.fn().mockResolvedValue(refusal(502, "BAD_GATEWAY")));
    await type("Q");
    await send();
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Your question").getAttribute("aria-invalid")).toBeNull();
  });
});
