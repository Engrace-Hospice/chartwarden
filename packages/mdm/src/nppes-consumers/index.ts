// @wardenx/mdm — M29 NPPES-sync consumer logic (M40-T09, §4.7, §7.11–7.12).
// Pure decisions + port-bound handlers M40 runs on M29's `m29.nppes.provider_synced` /
// `provider_deactivated` events. M29 is Wave H, so the backend registration is a deny-stub
// forward-seam; this logic is real + tested now, ready to wire when M29 lands.
export {
  decideProviderSynced,
  decideProviderDeactivated,
  handleProviderSynced,
  handleProviderDeactivated,
  type NppesCanonicalPhysician,
  type NppesProviderSnapshot,
  type M29ProviderSyncedPayload,
  type M29ProviderDeactivatedPayload,
  type NppesProvenance,
  type ProviderSyncedDecision,
  type ProviderDeactivatedOutcome,
  type NppesConsumerPorts,
} from "./apply";
