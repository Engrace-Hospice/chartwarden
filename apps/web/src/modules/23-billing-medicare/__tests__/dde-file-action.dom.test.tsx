import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// One-click "File in DDE" (ADR-0052, #766): the offered items follow the subject's state, a click posts
// {itemType, subjectId} with an Idempotency-Key, and the server's refusal (an open item exists) shows inline.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DdeFileAction, claimDdeOptions, noticeDdeOptions } from "../dde-file-action";

const SUBJECT = "a1a2a3a4-0000-4000-8000-000000000009";

function renderAction(options: ReturnType<typeof claimDdeOptions>, post: ReturnType<typeof vi.fn>) {
  const client = { POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <DdeFileAction subjectId={SUBJECT} options={options} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("DDE options by subject state", () => {
  it("offers adjust / cancel on an adjudicated claim, the return correction on a rejected one", () => {
    expect(claimDdeOptions("paid").map((o) => o.itemType)).toEqual(["adjustment", "cancel"]);
    expect(claimDdeOptions("ack_rejected").map((o) => o.itemType)).toEqual(["rtp_correction"]);
    expect(claimDdeOptions("submitted")).toEqual([]);
    expect(claimDdeOptions("draft")).toEqual([]);
    expect(claimDdeOptions("voided")).toEqual([]);
  });

  it("offers a notice item until the notice is accepted or cancelled", () => {
    expect(noticeDdeOptions("noe", "ack_rejected").map((o) => o.itemType)).toEqual(["noe"]);
    expect(noticeDdeOptions("notr", "ack_accepted")).toEqual([]);
    expect(noticeDdeOptions("notr", "cancelled")).toEqual([]);
  });
});

describe("DdeFileAction", () => {
  it("renders nothing without options", () => {
    renderAction([], vi.fn());
    expect(screen.queryByRole("region", { name: "File in DDE" })).toBeNull();
  });

  it("posts the item with an Idempotency-Key and links to the queue", async () => {
    const POST = vi.fn(async () => ({
      data: { id: "x" },
      error: undefined,
      response: new Response(null, { status: 201 }),
    }));
    renderAction(claimDdeOptions("paid"), POST);
    fireEvent.click(screen.getByRole("button", { name: "Adjust claim" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [path, init] = POST.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(path).toBe("/api/v1/billing/dde-items");
    expect(init.body).toEqual({ itemType: "adjustment", subjectId: SUBJECT });
    expect(init.params.header["Idempotency-Key"]).toBeTruthy();
    const link = await screen.findByRole("link", { name: "Open the DDE queue" });
    expect(link.getAttribute("href")).toBe("/billing/dde");
  });

  it("sends one request for a double click and posts a notice item type", async () => {
    let release: (v: unknown) => void = () => {};
    const POST = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderAction(noticeDdeOptions("noe", "ack_rejected"), POST);
    const button = screen.getByRole("button", { name: "File NOE in DDE" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(POST).toHaveBeenCalledTimes(1);
    const [, init] = POST.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(init.body).toEqual({ itemType: "noe", subjectId: SUBJECT });
    release({ data: {}, error: undefined, response: new Response(null, { status: 201 }) });
    await screen.findByRole("link", { name: "Open the DDE queue" });
  });

  it("starts clean for another subject when keyed by it", async () => {
    const POST = vi.fn(async () => ({
      data: {},
      error: undefined,
      response: new Response(null, { status: 201 }),
    }));
    const client = { POST } as unknown as ApiClient;
    const view = (id: string) => (
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <DdeFileAction key={id} subjectId={id} options={claimDdeOptions("paid")} />
        </ApiClientProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view("a"));
    fireEvent.click(screen.getByRole("button", { name: "Adjust claim" }));
    await screen.findByRole("link", { name: "Open the DDE queue" });
    rerender(view("b"));
    expect(screen.queryByRole("link", { name: "Open the DDE queue" })).toBeNull();
  });

  it("shows the server's refusal inline when an open item already exists", async () => {
    const POST = vi.fn(async () => ({
      data: undefined,
      error: {
        error: { message: "an open DDE item of this type already exists for this subject" },
      },
      response: new Response(null, { status: 409 }),
    }));
    renderAction(claimDdeOptions("ack_rejected"), POST);
    fireEvent.click(screen.getByRole("button", { name: "Correct returned claim" }));
    expect(await screen.findByText(/open DDE item of this type already exists/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open the DDE queue" })).toBeNull();
  });
});
