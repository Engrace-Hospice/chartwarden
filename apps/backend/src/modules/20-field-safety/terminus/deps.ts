// apps/backend/src/modules/20-field-safety/terminus/deps.ts - GAP-032: the one dep bag the terminus entry
// and executor share. Everything is optional-by-binding: an unbound port degrades to a RECORDED skip in the
// ledger (`pager_unbound`, `voice_unbound`, `jurisdiction_unavailable`), never to a refusal to enter the
// terminus. The terminus is a fact about an unanswered alert; the ledger carries the truth about each effect.
import type {
  EmergencyServiceJurisdictionReader,
  MembershipId,
  SosContactCaller,
} from "@chartwarden/types";
import type { SosTerminusPort } from "../jobs/terminus-port";
import type { SafetyDecipherPort } from "../routes/read-service-drizzle";
import type { SafetySeamStore } from "../seams/store";

/** The names the emergency-contact call speaks. Read at execution time, never persisted in the ledger. */
export interface SpokenNames {
  readonly agencyName: string;
  readonly subjectDisplayName: string;
}

export interface TerminusDeps {
  /** The platform page to ChartWarden ops. Unbound => `page_ops` rows settle `skipped / pager_unbound`. */
  readonly pager?: SosTerminusPort;
  /** M36's voice call to the consented contact. Unbound => `dial_contact` rows settle `voice_unbound`. */
  readonly caller?: SosContactCaller;
  /** Platform kill switch (`CHARTWARDEN_SOS_CONTACT_DIAL=enabled`). OFF until the Twilio sandbox run + legal read. */
  readonly dialEnabled: boolean;
  /** Opens the sealed contact and the SOS coordinate inside M20's boundary. */
  readonly decipher?: SafetyDecipherPort;
  /** The consent reader the dial re-checks at execution time (three-valued). */
  readonly store: SafetySeamStore;
  /** M40's seam, resolved lazily so a late-bound registry is honoured. Throwing is read as `unavailable`. */
  readonly jurisdictions?: () => EmergencyServiceJurisdictionReader;
  /** Org legal/display name and the clinician's display name for the script. */
  readonly speakNames?: (
    organizationId: string,
    membershipId: MembershipId,
  ) => Promise<SpokenNames>;
}
