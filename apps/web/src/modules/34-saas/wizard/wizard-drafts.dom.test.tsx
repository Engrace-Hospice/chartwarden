// @vitest-environment jsdom
// What a form keeps through Re-verify: scoped to the signed-in org and user, in process memory only, forgotten by sign-out, and handed
// to no one else. Exercised through the organisation panel, which keeps its display name and time zone that way.
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAllDrafts } from "../../../shell/ceremony-drafts";
import { stepUpDraftKeys } from "../../../shell/step-up-redirect";
import { OrganisationPanel } from "./organisation-panel";
import {
  ORG_ADMIN,
  RETURNED_FROM_STEP_UP,
  panelProps,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const view = wizardView([wizardStep("account_created", 1)]);
const client = () =>
  stubClient({ PATCH: { "/api/v1/tenant/org-profile": () => refused(403, "STEP_UP_REQUIRED") } });
const panel = <OrganisationPanel {...panelProps(view, "account_created")} />;
const OTHER_USER = { ...ORG_ADMIN, userId: "u-other", membershipId: "m-other" };

async function stashADraft(): Promise<void> {
  const first = renderAt("/x", [{ path: "/x", element: panel }], client());
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Cedar Ridge Hospice" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Organisation profile form" }));
  fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
  await screen.findByText("step-up page");
  first.unmount();
}
const nameOnReturn = (session = ORG_ADMIN): string => {
  renderAt(RETURNED_FROM_STEP_UP, [{ path: "/x", element: panel }], client(), session);
  return (screen.getByLabelText("Display name") as HTMLInputElement).value;
};

beforeEach(() => {
  clearAllDrafts();
  window.sessionStorage.clear();
});
afterEach(() => clearAllDrafts());

describe("wizard drafts", () => {
  it("are filed under the org and the user, and live in memory only", async () => {
    await stashADraft();
    expect(stepUpDraftKeys()).toEqual(["org-1|u-admin|onboarding-wizard|profile"]);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it("come back to the same person on the return from step-up", async () => {
    await stashADraft();
    expect(nameOnReturn()).toBe("Cedar Ridge Hospice");
  });

  it("are not handed to a different user on the same tab", async () => {
    await stashADraft();
    expect(nameOnReturn(OTHER_USER)).toBe("Cedar Ridge"); // the profile the server says, not what the last person typed
  });

  it("are forgotten by sign-out and the idle lock (clearAllDrafts)", async () => {
    await stashADraft();
    clearAllDrafts();
    expect(stepUpDraftKeys()).toEqual([]);
    expect(nameOnReturn()).toBe("Cedar Ridge");
  });
});
