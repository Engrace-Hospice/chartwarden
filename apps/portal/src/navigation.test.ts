import { describe, expect, it } from "vitest";
import { portalBreadcrumbs } from "./navigation";

describe("portal breadcrumbs", () => {
  it("links video visits through the Visits page", () => {
    expect(portalBreadcrumbs("/p/patient-1/visits/visit-1/telehealth", "patient-1")).toEqual([
      { label: "Home", href: "/p/patient-1" },
      { label: "Visits", href: "/p/patient-1/visits" },
      { label: "Video visit" },
    ]);
  });
});
