// @chartwarden/dosespot — the OAuth2 token request, in ONE place so the live client and the connection probe can never drift.
// Shape per `docs/history/m12-dosespot-adapter.md` item 1 (unverified until a sandbox run): Basic `clinicId:clinicKey`, form
// `grant_type=password`, `Username=<clinician id>`, `Password=<clinic key>`, `scope=api`, plus the `Subscription-Key` header.
import type { DoseSpotTenantConfig } from "./tenant-config";

export interface TokenRequest {
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function buildTokenRequest(cfg: DoseSpotTenantConfig, clinicianId: string): TokenRequest {
  const basic = Buffer.from(`${cfg.clinicId}:${cfg.clinicKey}`, "utf8").toString("base64");
  return {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
      "Subscription-Key": cfg.subscriptionKey,
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "password",
      Username: clinicianId,
      Password: cfg.clinicKey,
      scope: "api",
    }).toString(),
  };
}
