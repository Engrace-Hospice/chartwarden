// @vitest-environment jsdom
// The overview's "Transition status" button used to have no handler, so suspend / resume / activate were
// unreachable from the console. The dialog offers only the targets the §2.2 machine accepts from the tenant's
// current status, requires a reason, and keeps a refusal (e.g. unmet activation guards) visible.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { TenantTransitionDialog, transitionTargets } from "./tenant-transition-dialog";

function renderDialog(
  fromStatus: string,
  post: ReturnType<typeof vi.fn>,
): { onDone: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(
    <ApiClientProvider client={{ POST: post } as unknown as ApiClient}>
      <TenantTransitionDialog
        open
        orgSlug="cedar-ridge"
        tenantName="Cedar Ridge Hospice LLC"
        fromStatus={fromStatus}
        onDone={onDone}
        onClose={onClose}
      />
    </ApiClientProvider>,
  );
  return { onDone, onClose };
}

describe("transitionTargets", () => {
  it.each([
    ["onboarding", ["active"]],
    ["active", ["suspended", "at_risk", "offboarding_initiated"]],
    ["suspended", ["active", "offboarding_initiated"]],
    ["at_risk", ["active", "suspended", "offboarding_initiated"]],
    ["offboarding_initiated", ["final_export_pending"]],
    ["final_export_pending", ["retained"]],
    ["retained", ["destruction_pending"]],
    ["destroyed", []],
    ["provisioning", []],
  ])("from %s offers %j", (from, expected) => {
    expect(transitionTargets(from)).toEqual(expected);
  });
});

describe("TenantTransitionDialog", () => {
  it("activates an onboarding tenant with the operator's reason", async () => {
    const post = vi.fn(async () => ({ data: { tenantAccountId: "t-1", status: "active" } }));
    const { onDone } = renderDialog("onboarding", post);

    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "All onboarding steps verified" },
    });
    fireEvent.click(screen.getByRole("button", { name: /activate tenant/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/api/v1/platform/tenants/{orgSlug}/status", {
      params: { path: { orgSlug: "cedar-ridge" } },
      body: { toStatus: "active", transitionReason: "All onboarding steps verified" },
    });
  });

  it("refuses a too-short reason without sending a request", () => {
    const post = vi.fn();
    renderDialog("active", post);

    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));

    expect(screen.getByRole("alert").textContent).toMatch(/at least 8/i);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the server's reason when the transition is refused", async () => {
    const post = vi.fn(async () => ({
      error: { error: { message: "every canonical onboarding_task must be 'done' or 'skipped'" } },
    }));
    const { onDone } = renderDialog("onboarding", post);

    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Ready to go live" } });
    fireEvent.click(screen.getByRole("button", { name: /activate tenant/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/canonical onboarding_task/);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a network failure shows a retryable message instead of hanging", async () => {
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    const { onDone } = renderDialog("active", post);

    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "Non-payment 30 days" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("re-derives the target when the tenant's status changes under an already-mounted dialog", async () => {
    const post = vi.fn(async () => ({ data: { tenantAccountId: "t-1", status: "suspended" } }));
    const client = { POST: post } as unknown as ApiClient;
    const dialog = (fromStatus: string) => (
      <ApiClientProvider client={client}>
        <TenantTransitionDialog
          open
          orgSlug="cedar-ridge"
          tenantName="Cedar Ridge Hospice LLC"
          fromStatus={fromStatus}
          onDone={vi.fn()}
          onClose={vi.fn()}
        />
      </ApiClientProvider>
    );
    const { rerender } = render(dialog("onboarding"));

    rerender(dialog("active"));
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "Non-payment 30 days" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      "/api/v1/platform/tenants/{orgSlug}/status",
      expect.objectContaining({ body: expect.objectContaining({ toStatus: "suspended" }) }),
    );
  });

  it("begins offboarding through the offboard route, with an export purpose", async () => {
    const post = vi.fn(async () => ({
      data: { tenantAccountId: "t-1", status: "offboarding_initiated" },
    }));
    const { onDone } = renderDialog("active", post);

    fireEvent.change(screen.getByLabelText(/new status/i), {
      target: { value: "offboarding_initiated" },
    });
    fireEvent.change(screen.getByLabelText(/export purpose/i), {
      target: { value: "baa_termination" },
    });
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "BAA terminated by customer" },
    });
    fireEvent.click(screen.getByRole("button", { name: /begin offboarding/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/api/v1/platform/tenants/{orgSlug}/offboard", {
      params: { path: { orgSlug: "cedar-ridge" } },
      body: { transitionReason: "BAA terminated by customer", exportPurpose: "baa_termination" },
    });
  });

  it("walks the offboarding chain through the status route", async () => {
    const post = vi.fn(async () => ({ data: { tenantAccountId: "t-1", status: "retained" } }));
    renderDialog("final_export_pending", post);

    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "Customer downloaded the export" },
    });
    fireEvent.click(screen.getByRole("button", { name: /mark export complete/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      "/api/v1/platform/tenants/{orgSlug}/status",
      expect.objectContaining({ body: expect.objectContaining({ toStatus: "retained" }) }),
    );
  });

  it("labels the destruction step plainly and shows the server's refusal (retention not elapsed / legal hold)", async () => {
    const post = vi.fn(async () => ({
      error: {
        error: { message: "retention_ends_at must be reached before scheduling destruction" },
      },
    }));
    renderDialog("retained", post);

    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "Retention window elapsed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /schedule destruction/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/retention_ends_at/);
  });

  it("says there is nothing to do from a state with no platform-ops transitions", () => {
    renderDialog("destroyed", vi.fn());

    expect(screen.getByText(/no status changes are available/i)).toBeTruthy();
  });
});
