// Runtime discovery for seeded, non-patient resources used by the #852 dynamic route walk.
// IDs come from authenticated product APIs in the current tenant; none are copied from seed constants.
import type { Page } from "@playwright/test";

interface IdRow {
  readonly id?: unknown;
}

async function getJson(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response.json();
  }, path);
}

function firstId(value: unknown, key: "items" | "orders", source: string): string {
  const rows = (value as Record<string, unknown> | null)?.[key];
  const id = Array.isArray(rows) ? (rows[0] as IdRow | undefined)?.id : undefined;
  if (typeof id !== "string" || !id) {
    throw new Error(`e2e fixtures: ${source} returned no seeded resource id`);
  }
  return id;
}

export interface SeededResourceIds {
  readonly admissionId: string;
  readonly medicaidClaimId: string;
  readonly medicationOrderId: string;
}

/** Resolve one seeded resource of each supported kind through the signed-in browser session. */
export async function discoverSeededResourceIds(
  page: Page,
  patientId: string,
): Promise<SeededResourceIds> {
  const [admissions, medicaidClaims, medicationOrders] = await Promise.all([
    getJson(page, `/api/v1/patients/${encodeURIComponent(patientId)}/admissions`),
    getJson(page, "/api/v1/medicaid-claims?limit=1"),
    getJson(page, "/api/v1/medication-orders"),
  ]);
  return {
    admissionId: firstId(admissions, "items", "patient admissions"),
    medicaidClaimId: firstId(medicaidClaims, "items", "Medicaid claims"),
    medicationOrderId: firstId(medicationOrders, "orders", "medication orders"),
  };
}
