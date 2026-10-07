// apps/backend/src/modules/18-evv/jobs/wiring.ts — the composition-root builder for the M18 aggregator ports
// (GAP-056). It is the ONE place that decides what is live and what is a fail-closed stub.
//
//   LIVE   — `stateCodeForProviderEntity` (M1's `FoundationSiteReader.providerEntitySubmissionProfile`, org-explicit
//            under `withOrgContext`), and the per-state vendor selection (`EVV_AGGREGATOR_STATES`, validated at boot).
//   STUBBED (fail-closed) — everything that needs the external aggregator or another module's not-yet-published
//            capability:
//     • the Sandata transport is the DENY transport (`transport_failure` on submit, never a fabricated accept);
//     • credentials are the unbound store (throws — a DLQ-visible row failure);
//     • `patientStateIdentifier` — M5's `state_id` is envelope-encrypted and M5 publishes no decrypting reader seam;
//     • `clinicianNpi` — no per-clinician NPI is stored anywhere yet (the Sandata body allows null).
// Wiring a real aggregator = a real `SandataTransport` + a KMS-backed `AggregatorCredentialStore` + those two readers.
import type { DbClient } from "@wardenx/db";
import {
  OpenModelAdapter,
  SandataAdapter,
  StateAggregatorRegistry,
  createDenySandataTransport,
} from "@wardenx/evv-aggregators";
import { withOrgContext } from "@wardenx/tenancy";
import { buildFoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import {
  type EvvAggregatorDeps,
  EvvAggregatorPortUnboundError,
  type EvvSubmissionFactsPort,
  createUnboundAggregatorCredentialStore,
  parseEvvAggregatorStateConfigs,
} from "./ports";

/** The production fact readers: M1's state is live; the two M5/M2-owned facts are fail-closed `null`-then-throw. */
export function createEvvSubmissionFactsPort(db: DbClient): EvvSubmissionFactsPort {
  const siteReader = buildFoundationSiteReader();
  return {
    async stateCodeForProviderEntity(organizationId, providerEntityId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const profile = await siteReader.providerEntitySubmissionProfile(
          tx as DbClient,
          organizationId,
          providerEntityId,
        );
        return profile?.stateCode ?? null;
      });
    },
    async patientStateIdentifier() {
      throw new EvvAggregatorPortUnboundError("EvvSubmissionFactsPort.patientStateIdentifier");
    },
    async clinicianNpi() {
      return null;
    },
  };
}

/** Build the aggregator deps. `rawStates` is `process.env.EVV_AGGREGATOR_STATES` (blank ⇒ nothing is submitted). */
export function buildEvvAggregatorDeps(
  db: DbClient,
  rawStates: string | undefined,
): EvvAggregatorDeps {
  const registry = new StateAggregatorRegistry(parseEvvAggregatorStateConfigs(rawStates), {
    defaultAdapters: [
      new SandataAdapter({ transport: createDenySandataTransport() }),
      new OpenModelAdapter(),
    ],
  });
  return {
    registry,
    credentials: createUnboundAggregatorCredentialStore(),
    facts: createEvvSubmissionFactsPort(db),
  };
}
