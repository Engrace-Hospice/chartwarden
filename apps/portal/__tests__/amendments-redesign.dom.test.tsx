import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createApiClient } from "@chartwarden/ui";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Handler = (path: string, method: string, body: Record<string, unknown> | null) => Response | Promise<Response>;
function renderAmendments(handler: Handler) {
  window.history.pushState({}, "", `/p/${P1}/amendments`);
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  const client = createApiClient({ baseUrl: "http://localhost", fetch: async (input) => {
    const req = input instanceof Request ? input : new Request(input);
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? JSON.parse(await req.text()) as Record<string, unknown> : null;
    requests.push({ path, method: req.method, body });
    if (path === "/api/v1/portal/care-summary") return json({ patient: { layLabel: "Example patient" } });
    return handler(path, req.method, body);
  } });
  return { ...render(<PortalApp client={client} />), requests };
}
const amendment = { id: "req1", targetKind: "encounter_narrative", requestedChange: "The visit was on Monday, not Tuesday.", status: "submitted", submittedAt: "2026-10-10T12:00:00Z" };

describe("PR4.3 patient correction requests", () => {
  it("shows a readable tracked history, and does not imply a direct record edit", async () => {
    renderAmendments((path) => path.endsWith("/amendments") ? json({ items: [amendment] }) : json({ ok: true }));
    const list = await screen.findByRole("list", { name: "Correction request history" });
    expect(within(list).getByText(amendment.requestedChange)).toBeTruthy();
    expect(within(list).getByText("Submitted")).toBeTruthy();
    expect(screen.getByText(/does not automatically change the record/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("requires reviewing the content before posting an amendment", async () => {
    const { requests } = renderAmendments((path) => path.endsWith("/amendments") ? json({ items: [] }) : json({ ok: true }));
    const text = await screen.findByRole("textbox", { name: "Describe the correction" });
    expect(screen.getByRole("button", { name: /Review request/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(text, { target: { value: "The home phone number is outdated." } });
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    expect(screen.getByRole("heading", { name: "Review before sending" })).toBeTruthy();
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit request" }));
    expect((screen.getByRole("textbox", { name: "Describe the correction" }) as HTMLTextAreaElement).value).toBe("The home phone number is outdated.");
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(requests.filter((r) => r.method === "POST")).toHaveLength(1));
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({ targetKind: "patient_demographic", requestedChange: "The home phone number is outdated." });
    expect(await screen.findByText(/Your correction request was submitted for review/)).toBeTruthy();
  });

  it("keeps the reviewed draft after an unsuccessful submission", async () => {
    renderAmendments((path, method) => method === "POST" ? json({}, 422) : path.endsWith("/amendments") ? json({ items: [] }) : json({}, 404));
    fireEvent.change(await screen.findByRole("textbox", { name: "Describe the correction" }), { target: { value: "Please review this visit entry." } });
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Please review this visit entry.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit request" }));
    expect((screen.getByRole("textbox", { name: "Describe the correction" }) as HTMLTextAreaElement).value).toContain("Please review");
  });

  it("prevents duplicate submissions while the POST is pending", async () => {
    let resolvePost: ((value: Response) => void) | undefined;
    const { requests } = renderAmendments((path, method) => method === "POST"
      ? new Promise<Response>((resolve) => { resolvePost = resolve; })
      : path.endsWith("/amendments") ? json({ items: [] }) : json({}, 404));
    fireEvent.change(await screen.findByRole("textbox", { name: "Describe the correction" }), { target: { value: "Please check the visit date." } });
    fireEvent.click(screen.getByRole("button", { name: /Review request/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(requests.filter((r) => r.method === "POST")).toHaveLength(1));
    await act(async () => { resolvePost?.(json({ ok: true })); });
  });

  it("distinguishes history load failures from having no requests and retries", async () => {
    let reads = 0;
    renderAmendments((path) => {
      if (!path.endsWith("/amendments")) return json({}, 404);
      reads += 1;
      return reads === 1 ? json({}, 503) : json({ items: [] });
    });
    const error = await screen.findByRole("alert");
    expect(within(error).getByRole("heading", { name: "Requests unavailable" })).toBeTruthy();
    fireEvent.click(within(error).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No requests submitted yet" })).toBeTruthy();
    expect(reads).toBe(2);
  });

  it("renders user-submitted strings as plain text", async () => {
    renderAmendments((path) => path.endsWith("/amendments") ? json({ items: [{ ...amendment, requestedChange: "<script>alert(1)</script>" }] }) : json({}, 404));
    expect(await screen.findByText("<script>alert(1)</script>")).toBeTruthy();
    expect(document.querySelector(".wx-amendments-request script")).toBeNull();
  });

  it("does not display an old patient's requests after switching and receiving a late response", async () => {
    let resolveOld: ((value: Response) => void) | undefined;
    let reads = 0;
    renderAmendments((path) => {
      if (!path.endsWith("/amendments")) return json({}, 404);
      reads += 1;
      return reads === 1 ? new Promise<Response>((resolve) => { resolveOld = resolve; })
        : json({ items: [{ ...amendment, id: "other", requestedChange: "New patient request" }] });
    });
    await waitFor(() => expect(reads).toBe(1));
    window.history.pushState({}, "", `/p/${P2}/amendments`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("New patient request")).toBeTruthy();
    await act(async () => { resolveOld?.(json({ items: [{ ...amendment, requestedChange: "Old patient private request" }] })); });
    expect(screen.queryByText("Old patient private request")).toBeNull();
  });
});
