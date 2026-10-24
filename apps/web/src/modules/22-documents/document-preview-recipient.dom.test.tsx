// §4.12 — a disclosure / survey-export open must name its recipient. The server refuses the mint with
// no resolvable partner (403), so the dialog asks for one instead of offering an action that cannot work.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentPreviewDialog } from "./document-actions";

const DOCUMENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const VERSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PARTNER = "cccccccc-3333-4333-8333-cccccccccccc";

let urls: URL[] = [];

let refuseStepUp = false;
let dropNetwork = false;

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "http://localhost");
  urls.push(url);
  if (dropNetwork && url.pathname.endsWith("/content")) throw new TypeError("Failed to fetch");
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

function mount(opts: { stepUp?: boolean; offline?: boolean } = {}) {
  refuseStepUp = opts.stepUp === true;
  dropNetwork = opts.offline === true;
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <DocumentPreviewDialog
          open
          documentId={DOCUMENT}
          versionId={VERSION}
          versionNumber={2}
          onClose={() => undefined}
        />
      </ToastProvider>
    </ApiClientProvider>,
  );
}

const contentCalls = () => urls.filter((u) => u.pathname.endsWith("/content"));

describe("DocumentPreviewDialog — disclosure recipient", () => {
  beforeEach(() => {
    urls = [];
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

  it("sends the chosen partner's kind and id with the mint", async () => {
    mount();
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
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
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
});
