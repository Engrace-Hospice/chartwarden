// §4.12 — a disclosure / survey-export open must name its recipient. The server refuses the mint with
// no resolvable partner (403), so the dialog asks for one instead of offering an action that cannot work.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { DocumentPreviewDialog } from "./document-actions";

const DOCUMENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const VERSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PARTNER = "cccccccc-3333-4333-8333-cccccccccccc";

let urls: URL[] = [];

let refuseStepUp = false;
let dropNetwork = false;
let refuseBaa = false;

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "http://localhost");
  urls.push(url);
  if (dropNetwork && url.pathname.endsWith("/content")) throw new TypeError("Failed to fetch");
  if (refuseBaa && url.pathname.endsWith("/content")) {
    return new Response(
      JSON.stringify({ error: { code: "FORBIDDEN", message: "No executed BAA is on file." } }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  if (refuseStepUp && url.pathname.endsWith("/content")) {
    return new Response(JSON.stringify({ error: { code: "STEP_UP_REQUIRED", message: "x" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const body = url.pathname.endsWith("/content")
    ? {
        url: "https://objects.example.test/x",
        expiresAt: "2099-01-01T00:00:00.000Z",
        documentVersionId: VERSION,
        accessKind: "disclosure_export",
      }
    : {
        results: [
          {
            id: PARTNER,
            status: "active",
            canonical: {
              displayName: "Lakeside Hospice Partners",
              identifierType: "ccn",
              identifierValue: "123456",
            },
          },
        ],
      };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["clinician"],
  permissions: [],
  isAdmin: false,
};

function mount(
  opts: { stepUp?: boolean; offline?: boolean; baa?: boolean; session?: boolean } = {},
) {
  refuseStepUp = opts.stepUp === true;
  dropNetwork = opts.offline === true;
  refuseBaa = opts.baa === true;
  const onClose = vi.fn();
  const dialog = (
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <DocumentPreviewDialog
          open
          documentId={DOCUMENT}
          versionId={VERSION}
          versionNumber={2}
          onClose={onClose}
        />
      </ToastProvider>
    </ApiClientProvider>
  );
  const view = render(
    opts.session ? <SessionProvider session={SESSION}>{dialog}</SessionProvider> : dialog,
  );
  return { ...view, onClose };
}

async function pickPartner(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText("Search name or identifier..."), {
    target: { value: "Lakeside" },
  });
  fireEvent.click(await screen.findByText("Lakeside Hospice Partners"));
}

const contentCalls = () => urls.filter((u) => u.pathname.endsWith("/content"));

describe("DocumentPreviewDialog — disclosure recipient", () => {
  beforeEach(() => {
    urls = [];
    window.sessionStorage.clear();
    vi.spyOn(globalThis, "open").mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends no recipient for an internal purpose and shows no recipient field", async () => {
    mount();
    expect(screen.queryByText("Recipient type")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(contentCalls()).toHaveLength(1));
    const q = contentCalls()[0]?.searchParams;
    expect(q?.get("purpose")).toBe("treatment");
    expect(q?.has("recipientKind")).toBe(false);
  });

  it.each(["disclosure", "survey_export"])(
    "%s asks for a recipient and keeps Open disabled until one is chosen",
    (purpose) => {
      mount();
      fireEvent.change(screen.getByLabelText("Reason for access"), { target: { value: purpose } });
      expect(screen.getByLabelText("Recipient type")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(contentCalls()).toHaveLength(0);
    },
  );

  it("sends the chosen partner's kind and id with the mint, then opens the URL and closes", async () => {
    const { onClose } = mount();
    fireEvent.change(screen.getByLabelText("Reason for access"), {
      target: { value: "disclosure" },
    });
    fireEvent.change(screen.getByLabelText("Recipient type"), { target: { value: "payer" } });
    fireEvent.change(screen.getByPlaceholderText("Search name or identifier..."), {
      target: { value: "Lakeside" },
    });
    fireEvent.click(await screen.findByText("Lakeside Hospice Partners"));
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await waitFor(() => expect(contentCalls()).toHaveLength(1));
    const q = contentCalls()[0]?.searchParams;
    expect(q?.get("purpose")).toBe("disclosure");
    expect(q?.get("recipientKind")).toBe("payer");
    expect(q?.get("recipientEntityId")).toBe(PARTNER);
    // The lookup followed the recipient type: a payer search, not the facility search left over from before.
    expect(urls.some((u) => u.pathname === "/api/v1/mdm/payer/search")).toBe(true);
    // The minted URL is opened in a new tab without handing it a reference back to this page.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(globalThis.open).toHaveBeenCalledWith(
      "https://objects.example.test/x",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("forgets the chosen partner after a detour through an internal purpose", async () => {
    mount();
    const reason = screen.getByLabelText("Reason for access");
    fireEvent.change(reason, { target: { value: "disclosure" } });
    fireEvent.change(screen.getByPlaceholderText("Search name or identifier..."), {
      target: { value: "Lakeside" },
    });
    fireEvent.click(await screen.findByText("Lakeside Hospice Partners"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.change(reason, { target: { value: "treatment" } });
    fireEvent.change(reason, { target: { value: "disclosure" } });
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    // Choosing again is what sends a recipient: nothing from before the detour rides along.
    fireEvent.change(screen.getByPlaceholderText("Search name or identifier..."), {
      target: { value: "Lakeside" },
    });
    fireEvent.click(await screen.findByText("Lakeside Hospice Partners"));
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await waitFor(() => expect(contentCalls()).toHaveLength(1));
    expect(contentCalls()[0]?.searchParams.get("recipientEntityId")).toBe(PARTNER);
  });

  it("offers a step-up link when the server asks for a fresh verification", async () => {
    mount({ stepUp: true });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Confirm your identity");
    expect(screen.getByRole("link", { name: "Verify now" }).getAttribute("href")).toContain(
      "/step-up?returnTo=",
    );
  });

  it("recovers from a network failure instead of sticking on Opening…", async () => {
    mount({ offline: true });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be reached");
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
  });

  it("drops the old failure message once the user changes the selection", async () => {
    mount({ stepUp: true });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Reason for access"), {
      target: { value: "payment" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("link", { name: "Verify now" })).toBeNull();
  });

  it("names the recipient in the request a step-up refusal answers", async () => {
    mount({ stepUp: true });
    fireEvent.change(screen.getByLabelText("Reason for access"), {
      target: { value: "disclosure" },
    });
    await pickPartner();
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await screen.findByRole("alert");
    expect(contentCalls()).toHaveLength(1);
    const q = contentCalls()[0]?.searchParams;
    expect(q?.get("purpose")).toBe("disclosure");
    expect(q?.get("recipientKind")).toBe("facility");
    expect(q?.get("recipientEntityId")).toBe(PARTNER);
  });

  it("shows the server's reason for a 403 that is not a step-up, with no verify link", async () => {
    mount({ baa: true });
    fireEvent.change(screen.getByLabelText("Reason for access"), {
      target: { value: "disclosure" },
    });
    await pickPartner();
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    expect((await screen.findByRole("alert")).textContent).toContain("No executed BAA");
    expect(screen.queryByRole("link", { name: "Verify now" })).toBeNull();
  });

  it("ties the 'choose a recipient' hint to the disabled Open button", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Reason for access"), {
      target: { value: "disclosure" },
    });
    const open = screen.getByRole("button", { name: "Open" });
    const hint = document.getElementById(open.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toContain("Choose a recipient to continue.");
  });

  it("restores the reason and recipient after the step-up round trip", async () => {
    const first = mount({ stepUp: true, session: true });
    fireEvent.change(screen.getByLabelText("Reason for access"), {
      target: { value: "disclosure" },
    });
    await pickPartner();
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await screen.findByRole("link", { name: "Verify now" });
    first.unmount();

    mount({ session: true }); // back from /step-up: a fresh mount of the same dialog
    expect((screen.getByLabelText("Reason for access") as HTMLSelectElement).value).toBe(
      "disclosure",
    );
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("discards the stashed choices when the user cancels instead of verifying", async () => {
    const { onClose } = mount({ stepUp: true, session: true });
    fireEvent.change(screen.getByLabelText("Reason for access"), {
      target: { value: "disclosure" },
    });
    await pickPartner();
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await screen.findByRole("link", { name: "Verify now" });
    expect(window.sessionStorage.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(0);
  });
});
