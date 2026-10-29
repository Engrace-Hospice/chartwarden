import { ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { filterIpuNavigation, useIpuNavigationAvailability } from "./ipu-navigation";
import { type Session, SessionProvider } from "./session";

const paths = ["/admissions", "/admissions/readmit", "/ipu", "/ipu/admissions", "/ipu/census"];
const clinical: Session = {
  userId: "clinician-1",
  organizationId: "org-1",
  permissions: ["m37.unit.read", "m37.ipu_admission.read", "m37.census.read"],
  isAdmin: false,
};

function NavigationProbe(): JSX.Element {
  const { enabled, hasActiveUnit, isAdmin } = useIpuNavigationAvailability();
  const visible = filterIpuNavigation(
    paths.map((path) => ({ path })),
    enabled,
    hasActiveUnit,
    isAdmin,
  );
  return <output>{visible.map((item) => item.path).join(",")}</output>;
}

function mount(session: Session, enabled: boolean, GET: ReturnType<typeof vi.fn>): void {
  render(
    <ApiClientProvider client={{ GET } as unknown as ApiClient}>
      <SessionProvider session={session}>
        <FeatureFlagProvider flags={{ ipu_module_enabled: enabled }}>
          <NavigationProbe />
        </FeatureFlagProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("IPU navigation availability", () => {
  it("hides IPU entirely when the tenant flag is off", () => {
    const GET = vi.fn();
    mount(clinical, false, GET);
    expect(screen.getByText("/admissions,/admissions/readmit")).toBeTruthy();
    expect(GET).not.toHaveBeenCalled();
  });

  it("shows all permitted IPU pages to clinical staff with an active unit", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { items: [{ isActive: true }] } });
    mount(clinical, true, GET);
    await waitFor(() => expect(screen.getByText(paths.join(","))).toBeTruthy());
    expect(GET).toHaveBeenCalledWith("/api/v1/inpatient-units");
  });

  it("hides IPU from clinical staff when every configured unit is inactive", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { items: [{ isActive: false }] } });
    mount(clinical, true, GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.getByText("/admissions,/admissions/readmit")).toBeTruthy();
  });

  it("keeps only unit configuration visible to an administrator without an active unit", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { items: [] } });
    mount({ ...clinical, isAdmin: true }, true, GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.getByText("/admissions,/admissions/readmit,/ipu")).toBeTruthy();
  });

  it("fails closed for clinical staff if unit availability cannot be read", async () => {
    const GET = vi.fn().mockRejectedValue(new Error("Unavailable"));
    mount(clinical, true, GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.getByText("/admissions,/admissions/readmit")).toBeTruthy();
  });
});
