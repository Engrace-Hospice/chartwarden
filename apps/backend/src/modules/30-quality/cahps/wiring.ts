// apps/backend/src/modules/30-quality/cahps/wiring.ts — GAP-087. The one place the composition root assembles M30's
// CAHPS pipeline: the tenant-DEK cipher over the injected key ring, the vendor-adapter factory map from
// `@chartwarden/cahps-vendors`, and the M5/M6 ports the sampler reads through. The root passes the SAME result to the
// route mount (R-11 config sealing, R-15 file download) and to the worker deps (sample cron + export worker), so
// there is exactly one cipher and one adapter map.
import { CAHPS_ADAPTER_FACTORIES } from "@chartwarden/cahps-vendors";
import type { DbClient } from "@chartwarden/db";
import type { M30ReadActor } from "../routes/actor";
import { readExportFile } from "./export-job-store";
import { type CahpsKeyProvider, type CahpsPhiCipher, createCahpsPhiCipher } from "./phi-cipher";
import type { CahpsCaregiverContact, CahpsDeathFacts, CahpsPipelineDeps } from "./pipeline";

export interface M30CahpsWiringInput {
  readonly db: DbClient;
  /** Resolved lazily (the key ring registers after route mount) — the `getTenantKeyProvider()` thunk shape. */
  readonly keys: CahpsKeyProvider;
  readonly outboxPublisher?: CahpsPipelineDeps["outboxPublisher"];
  /** M6 `cahpsDeathCandidatesForOrg`, bound to the db. */
  readonly deathsForOrg: (
    organizationId: string,
    period: { readonly from: string; readonly to: string },
  ) => Promise<ReadonlyArray<CahpsDeathFacts>>;
  /** M5 `primaryCaregiverContactForOrg`, bound to the db. */
  readonly caregiverContactForOrg: (
    organizationId: string,
    patientId: string,
  ) => Promise<CahpsCaregiverContact | null>;
}

export interface M30CahpsWiring {
  readonly cipher: CahpsPhiCipher;
  readonly pipeline: CahpsPipelineDeps;
  /** R-11: the adapter factories (validate a supplied configuration) + the cipher (seal it). */
  readonly writePorts: {
    readonly cahpsCipher: CahpsPhiCipher;
    readonly cahpsAdapterFactories: typeof CAHPS_ADAPTER_FACTORIES;
  };
  /** R-15b: the sealed-file reader. */
  readonly exportFile: (
    actor: M30ReadActor,
    exportId: string,
  ) => Promise<{ filename: string; mimeType: string; bytes: Buffer } | null>;
}

export function buildM30CahpsWiring(input: M30CahpsWiringInput): M30CahpsWiring {
  const cipher = createCahpsPhiCipher(input.keys);
  return {
    cipher,
    pipeline: {
      db: input.db,
      cipher,
      adapterFactories: CAHPS_ADAPTER_FACTORIES,
      deathsForOrg: input.deathsForOrg,
      caregiverContactForOrg: input.caregiverContactForOrg,
      outboxPublisher: input.outboxPublisher,
    },
    writePorts: { cahpsCipher: cipher, cahpsAdapterFactories: CAHPS_ADAPTER_FACTORIES },
    exportFile: (actor, exportId) =>
      readExportFile(input.db, cipher, actor.organizationId, exportId),
  };
}
