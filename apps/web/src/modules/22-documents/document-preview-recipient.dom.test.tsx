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

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "http://localhost");
  urls.push(url);
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

function mount() {
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
});
