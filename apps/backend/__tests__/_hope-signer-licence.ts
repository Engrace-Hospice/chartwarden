// apps/backend/__tests__/_hope-signer-licence.ts — CW-AC-46: signing a HOPE record now reads the signer's licences through M17's
// `CredentialReader` seam, so every suite that signs through the DB backend must register one (an unregistered or denying seam
// is a 503 `M10_SIGNER_LICENCE_UNVERIFIABLE`, nothing signed). The suites whose subject is NOT the licence call this: it
// reports every HOPE licence kind as active for every membership, so they keep proving what they prove.
//
// The licence control itself is proven in `m10-hope-signer-licence.live.test.ts`, over the REAL Drizzle credential store as
// the NOBYPASSRLS app role. Do not use this helper there.
import type { CredentialGrant } from "@chartwarden/types";
import { registerSeam } from "../src/bootstrap/index";
import { LICENCE_KIND_OF_DISCIPLINE } from "../src/modules/10-hope/hope-signer-licence";

const EVERY_HOPE_LICENCE: readonly CredentialGrant[] = [
  ...new Set(Object.values(LICENCE_KIND_OF_DISCIPLINE)),
].map((kind) => ({ kind, status: "active" as const }));

/** Register a `CredentialReader` that holds an active licence in every HOPE discipline for any membership. */
export function registerLicencedHopeSigners(): void {
  registerSeam("CredentialReader", {
    async activeCredentialsAsOf() {
      return EVERY_HOPE_LICENCE;
    },
  });
}
