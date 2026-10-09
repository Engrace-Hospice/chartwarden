// apps/backend/src/bootstrap/render-payload-sources.ts - the ports every module's typed render-payload producer
// reads (GAP-033): the patient's name / MRN / DOB (M5's `PatientReader`), a physician's printed name, credentials
// and NPI (M40's `MdmEntityProvider`), and the printed name of the signing member (M1 `membership` -> `user`).
// Owned here, in the Foundation layer, so M6 / M11 / M12 share ONE implementation without importing each other
// (ADR-0005). Resolved lazily through the boot-registered seams; a seam that is unregistered or throws reads as
// "did not resolve" (null) - the producer then omits the payload and M22 refuses the id-only event loudly,
// instead of the signing transaction failing on a lookup.
import { type DbClient, schema } from "@wardenx/db";
import { RenderPayloadError } from "@wardenx/types";
import { eq } from "drizzle-orm";
import { buildFoundationSiteReader } from "./foundation-site-reader";
import { getSeam } from "./index";

export interface RenderPatientFacts {
  readonly name: string;
  readonly mrn: string;
  readonly dateOfBirth: string | null;
}

export interface RenderPhysicianFacts {
  readonly name: string;
  readonly credentials: string | null;
  readonly npi: string | null;
}

export interface RenderSourcesPort {
  patient(organizationId: string, patientId: string): Promise<RenderPatientFacts | null>;
  physician(organizationId: string, physicianId: string): Promise<RenderPhysicianFacts | null>;
}

/** The slice of M40's `MdmEntityProvider.resolvePhysician` the producers read (structural; no M40 import). */
interface PhysicianResolver {
  resolvePhysician(
    organizationId: string,
    physicianId: string,
  ): Promise<{
    canonical: {
      displayName: string;
      credentials: string | null;
      identifierType: string | null;
      identifierValue: string | null;
    };
  } | null>;
}

/** Raised when a typed render payload cannot be built (a source did not resolve). The call site omits the
 *  payload and logs ids only; M22 then refuses the id-only event (DLQ) instead of drawing a blank form. */
export class RenderPayloadBuildError extends Error {
  readonly code = "RENDER_PAYLOAD_UNAVAILABLE";
  constructor(
    readonly artifact: string,
    readonly why: string,
  ) {
    super(`${artifact} render payload could not be built: ${why}`);
    this.name = "RenderPayloadBuildError";
  }
}

export function createSeamRenderSources(): RenderSourcesPort {
  return {
    async patient(organizationId, patientId) {
      try {
        const p = await getSeam("PatientReader").findById({ organizationId, id: patientId });
        if (!p) return null;
        return {
          name: `${p.firstName} ${p.lastName}`.trim(),
          mrn: p.mrn,
          dateOfBirth: p.dateOfBirth ?? null,
        };
      } catch {
        return null;
      }
    },
    async physician(organizationId, physicianId) {
      try {
        const provider = getSeam("MdmEntityProvider") as unknown as PhysicianResolver;
        const r = await provider.resolvePhysician(organizationId, physicianId);
        if (!r) return null;
        const { canonical } = r;
        return {
          name: canonical.displayName,
          credentials: canonical.credentials,
          npi: canonical.identifierType === "npi" ? canonical.identifierValue : null,
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The printed name of the member who signed, read from the signing transaction's own tenant-scoped `tx`
 * (`membership` -> `user`). Null when the membership or its user carries no name - the caller then refuses to build
 * a signature record rather than print a blank signer.
 */
export async function membershipPrintedName(
  tx: DbClient,
  membershipId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.id, membershipId))
    .limit(1);
  const name = row?.name?.trim();
  return name === undefined || name === "" ? null : name;
}

/** What a producer's builder reads: the signing transaction's own `tx`, the facts ports, the letterhead name. */
export interface RenderBuildCtx {
  readonly tx: DbClient;
  readonly organizationId: string;
  readonly sources: RenderSourcesPort;
  /** The hospice's legal name (the document letterhead); null when the row names no provider entity. */
  readonly hospiceName: (providerEntityId: string | null) => Promise<string | null>;
}

/** The standard build context: seam-backed facts plus the provider entity's legal name from M1's site reader. */
export function createRenderBuildCtx(
  tx: DbClient,
  organizationId: string,
  sources: RenderSourcesPort = createSeamRenderSources(),
): RenderBuildCtx {
  const sites = buildFoundationSiteReader();
  return {
    tx,
    organizationId,
    sources,
    hospiceName: async (providerEntityId) =>
      providerEntityId ? sites.providerEntityLegalName(tx, organizationId, providerEntityId) : null,
  };
}

/** Structured, PHI-free report sink (ids and paths only) for a payload that could not be built. */
export const logRenderPayload = (event: string, detail: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`);
};

/**
 * Run a typed render-payload builder inside the signing transaction. A source that did not resolve
 * ({@link RenderPayloadBuildError}) or a payload that failed its schema ({@link RenderPayloadError}) is reported by
 * name (never values) and returns `undefined`: the event is then published without `renderPayload` and M22 refuses
 * it (retry -> DLQ), which is the loud, recoverable outcome. A SQL error is NOT caught (it would leave the
 * transaction aborted anyway).
 */
export async function buildRenderPayloadOrOmit<T>(
  eventPrefix: string,
  log: (event: string, detail: Record<string, unknown>) => void,
  detail: Record<string, unknown>,
  build: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await build();
  } catch (err) {
    if (err instanceof RenderPayloadBuildError) {
      log(`${eventPrefix}.render_payload_unavailable`, {
        ...detail,
        artifact: err.artifact,
        why: err.why,
      });
      return undefined;
    }
    if (err instanceof RenderPayloadError) {
      log(`${eventPrefix}.render_payload_invalid`, {
        ...detail,
        artifact: err.templateKey,
        violations: err.violations.map((v) => v.split(":")[0]),
      });
      return undefined;
    }
    throw err;
  }
}
