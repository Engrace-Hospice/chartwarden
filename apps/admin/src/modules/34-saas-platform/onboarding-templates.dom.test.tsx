// @vitest-environment jsdom
// The onboarding-step catalog is shown in every tenant's wizard, so adding or editing a step is a named operator's decision like every
// other platform write: behind a reason, one Idempotency-Key per attempt.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OnboardingTemplates } from "./onboarding-templates";
import { ok, refused, renderAt, stubClient } from "./onboarding/test-support";

const LIST = "/api/v1/platform/onboarding-templates";
const EMPTY_PAGE = { items: [], nextCursor: null, hasMore: false };

function mount(post: Parameters<typeof stubClient>[0]["POST"]) {
  const client = stubClient({
    GET: { [LIST]: () => ok(EMPTY_PAGE) },
    ...(post ? { POST: post } : {}),
  });
  renderAt(
    "/onboarding/templates?template=new",
    [{ path: "/onboarding/templates", element: <OnboardingTemplates /> }],
    client,
  );
  return client;
}
const fillAndAsk = async () => {
  fireEvent.change(await screen.findByLabelText("Key"), { target: { value: "staff_training" } });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Staff training" } });
  fireEvent.change(screen.getByLabelText("Step order"), { target: { value: "40" } });
  const buttons = screen.getAllByRole("button", { name: "Add template" });
  fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
};

describe("OnboardingTemplates: saving a step", () => {
  it("asks why, then sends the reason and an Idempotency-Key with the step", async () => {
    const client = mount({ [LIST]: () => ok({ key: "staff_training" }, 201) });
    await fillAndAsk();
    fireEvent.change(await screen.findByLabelText(/^Reason/), {
      target: { value: "Customers asked for a training step, CHG-6001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      { params: { header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe(LIST);
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({
      key: "staff_training",
      title: "Staff training",
      canonicalOrder: 40,
      isCanonical: false,
      reason: "Customers asked for a training step, CHG-6001",
    });
  });

  it("sends nothing until a reason is given", async () => {
    const client = mount({ [LIST]: () => ok({}, 201) });
    await fillAndAsk();
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(client.POST).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says why the server refused, in the prompt", async () => {
    mount({
      [LIST]: () => refused(409, "ONBOARDING_TEMPLATE_CANONICAL", "that step is canonical"),
    });
    await fillAndAsk();
    fireEvent.change(await screen.findByLabelText(/^Reason/), {
      target: { value: "Customers asked for a training step, CHG-6001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/that step is canonical/)).toBeTruthy();
  });
});
