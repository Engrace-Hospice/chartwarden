// apps/backend/src/modules/02-identity/org-admin-site-service.ts — the provider-entity and service-location write
// logic behind `POST/PATCH /provider-entities` and `/locations` (GAP-115), taking the ORGANIZATION EXPLICITLY.
//
// WHY THIS IS A SERVICE. The tenant routes act on the session's own org; the platform onboarding routes
// (M34 `/api/v1/platform/tenants/:orgSlug/…`) act on another tenant's. Both must run the SAME validation, the same
// EIN sealing and the same immutability rules, so the logic lives here once and each route supplies only who is
// asking, which org, and how it audits. Nothing here reads a request, a role or a session: the caller has already
// authorized.
//
// The store is a port, so a caller that must keep the write, a status check and an audit row in ONE transaction
// passes a store bound to that transaction (`createDrizzleSiteAdminRepository(tx, actorUserId)`).
import { randomUUID } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import type {
  LocationDetail,
  LocationPatch,
  ProviderEntityDetail,
  ProviderEntityPatch,
  SiteAdminRepository,
} from "../../bootstrap/site-admin-repository";
import {
  assertStatusTransition,
  normalizeTaxId,
  requireCcn,
  requireFiscalYearEnd,
  requireNpi,
  requirePostalCode,
  requireState,
  requireTimezone,
} from "./org-admin-validation";
import {
  asBody,
  invalid,
  notFound,
  optionalString,
  requiredString,
} from "./routes/admin-route-kit";

/** The injected envelope cipher for `provider_entity.tax_id_encrypted` (KMS-backed in production). */
export interface TaxIdCipherPort {
  /** Sealed under the tenant's own DEK; the row id is bound into the AAD so the blob opens only for that row. */
  encrypt(input: {
    organizationId: string;
    providerEntityId: string;
    plaintext: string;
  }): Promise<string>;
}

export interface SiteWriteDeps {
  readonly store: SiteAdminRepository;
  /** Unbound -> creating a provider entity answers 503 TAX_ID_CIPHER_UNBOUND. */
  readonly taxIdCipher?: TaxIdCipherPort;
  /** Cause logging for a sealing failure (the response never echoes the provider's message). */
  readonly logError?: (cause: unknown, context: { organizationId: string }) => void;
}

/** Fields of a provider entity that identify it to CMS — never editable through PATCH. */
const IMMUTABLE_PE_FIELDS = ["ccn", "npi", "taxId", "fiscalYearEnd", "organizationId"] as const;
const LIFECYCLE_STATUSES = ["created", "active", "suspended", "closed"] as const;

const conflict = (code: string, message: string) => new ChartWardenError(code, message, 409);

function rejectImmutable(body: Record<string, unknown>, fields: readonly string[]): void {
  const present = fields.filter((f) => body[f] !== undefined);
  if (present.length > 0)
    invalid(
      present[0] as string,
      `${present.join(", ")} cannot be changed here — it identifies the record to CMS; contact support for a re-enrolment.`,
    );
}

function requireAnyChange(changed: readonly string[]): void {
  if (changed.length === 0) invalid("body", "Nothing to change: send at least one editable field.");
}

/** The billing address in the limits the 837I writer enforces (N3 55, N4 city 30), so a bad one is refused here. */
function parseBillingAddress(raw: unknown): NonNullable<ProviderEntityPatch["billingAddress"]> {
  const body = asBody(raw);
  return {
    line1: requiredString(body, "line1", 55),
    line2: optionalString(body, "line2", 55) || null,
    city: requiredString(body, "city", 30),
    state: requireState(requiredString(body, "state", 2)),
    postalCode: requirePostalCode(requiredString(body, "postalCode", 10)),
  };
}

function lifecycleStatus(body: Record<string, unknown>): ProviderEntityPatch["status"] | undefined {
  const status = optionalString(body, "status");
  if (status === undefined) return undefined;
  if (!(LIFECYCLE_STATUSES as readonly string[]).includes(status))
    invalid("status", "status must be created, active, suspended or closed");
  return status as ProviderEntityPatch["status"];
}

export async function createProviderEntityForOrg(
  deps: SiteWriteDeps,
  organizationId: string,
  rawBody: unknown,
): Promise<ProviderEntityDetail> {
  const body = asBody(rawBody);
  const ccn = requireCcn(requiredString(body, "ccn", 6));
  const npi = requireNpi(requiredString(body, "npi", 10));
  const taxId = normalizeTaxId(requiredString(body, "taxId", 20));
  if (!taxId) invalid("taxId", "taxId must be a 9-digit EIN (12-3456789).");
  const input = {
    ccn,
    npi,
    legalName: requiredString(body, "legalName"),
    doingBusinessAs: optionalString(body, "doingBusinessAs") || null,
    fiscalIntermediary: optionalString(body, "fiscalIntermediary") || null,
    fiscalYearEnd: requireFiscalYearEnd(requiredString(body, "fiscalYearEnd", 4)),
    iqiesFacilityId: optionalString(body, "iqiesFacilityId", 50) || null,
  };
  const cipher = deps.taxIdCipher;
  if (!cipher)
    throw new ChartWardenError(
      "TAX_ID_CIPHER_UNBOUND",
      "the tax-id envelope cipher (KMS-backed key ring) is not bound; a provider entity cannot be created until it is",
      503,
    );
  // A missing/destroyed tenant key ring or an unbound KEK is an operator problem, not a bug: say so (503) without
  // echoing the provider's message, and log the cause.
  // The id is minted here (not by the store) because it is part of the AAD and so must exist before the seal.
  const id = randomUUID();
  const taxIdEncrypted = await cipher
    .encrypt({ organizationId, providerEntityId: id, plaintext: taxId as string })
    .catch((cause: unknown) => {
      deps.logError?.(cause, { organizationId });
      throw new ChartWardenError(
        "TAX_ID_KEY_UNAVAILABLE",
        "the tenant encryption key is unavailable; contact platform support",
        503,
      );
    });
  const created = await deps.store.createProviderEntity(organizationId, {
    ...input,
    id,
    taxIdEncrypted,
  });
  if ("conflict" in created)
    throw conflict(
      created.conflict === "ccn" ? "CCN_TAKEN" : "NPI_TAKEN",
      `a provider entity with this ${created.conflict.toUpperCase()} already exists`,
    );
  return created;
}

export interface SiteUpdate<T> {
  readonly updated: T;
  /** Field NAMES that changed — never values (the audit payload carries these). */
  readonly changedFields: readonly string[];
}

export async function updateProviderEntityForOrg(
  deps: SiteWriteDeps,
  organizationId: string,
  id: string,
  rawBody: unknown,
): Promise<SiteUpdate<ProviderEntityDetail>> {
  const { store } = deps;
  const body = asBody(rawBody);
  rejectImmutable(body, IMMUTABLE_PE_FIELDS);
  const current = await store.getProviderEntity(organizationId, id);
  if (!current) throw notFound("provider entity");

  const patch: ProviderEntityPatch = {};
  const legalName = optionalString(body, "legalName");
  if (legalName !== undefined) {
    if (legalName === "") invalid("legalName", "legalName cannot be empty");
    patch.legalName = legalName;
  }
  for (const f of ["doingBusinessAs", "fiscalIntermediary", "iqiesFacilityId"] as const) {
    const v = optionalString(body, f, f === "iqiesFacilityId" ? 50 : 200);
    if (v !== undefined) patch[f] = v === "" ? null : v;
  }
  if (body.billingAddress !== undefined)
    patch.billingAddress = parseBillingAddress(body.billingAddress);
  const status = lifecycleStatus(body);
  if (status !== undefined) {
    assertStatusTransition(current.status, status);
    patch.status = status;
  }
  requireAnyChange(Object.keys(patch));
  const updated = await store.updateProviderEntity(organizationId, id, patch);
  if (!updated) throw notFound("provider entity");
  return { updated, changedFields: Object.keys(patch) };
}

export async function createLocationForOrg(
  deps: SiteWriteDeps,
  organizationId: string,
  rawBody: unknown,
): Promise<LocationDetail> {
  const body = asBody(rawBody);
  const input = {
    providerEntityId: requiredString(body, "providerEntityId", 64),
    name: requiredString(body, "name"),
    addressLine1: requiredString(body, "addressLine1"),
    addressLine2: optionalString(body, "addressLine2") || null,
    city: requiredString(body, "city", 100),
    state: requireState(requiredString(body, "state", 2)),
    postalCode: requirePostalCode(requiredString(body, "postalCode", 10)),
    phone: optionalString(body, "phone", 30) || null,
    fax: optionalString(body, "fax", 30) || null,
    timezone: requireTimezone(requiredString(body, "timezone", 64)),
  };
  const created = await deps.store.createLocation(organizationId, input);
  // Not this org's provider entity — the same answer as an unknown one (no existence oracle).
  if (!created) throw notFound("provider entity");
  return created;
}

export async function updateLocationForOrg(
  deps: SiteWriteDeps,
  organizationId: string,
  id: string,
  rawBody: unknown,
): Promise<SiteUpdate<LocationDetail>> {
  const { store } = deps;
  const body = asBody(rawBody);
  rejectImmutable(body, ["providerEntityId", "organizationId"]);
  const current = await store.getLocation(organizationId, id);
  if (!current) throw notFound("location");

  const patch: LocationPatch = {};
  const text = (f: "name" | "addressLine1" | "city", max = 200): void => {
    const v = optionalString(body, f, max);
    if (v === undefined) return;
    if (v === "") invalid(f, `${f} cannot be empty`);
    patch[f] = v;
  };
  text("name");
  text("addressLine1");
  text("city", 100);
  for (const f of ["addressLine2", "phone", "fax"] as const) {
    const v = optionalString(body, f, f === "addressLine2" ? 200 : 30);
    if (v !== undefined) patch[f] = v === "" ? null : v;
  }
  const state = optionalString(body, "state", 2);
  if (state !== undefined) patch.state = requireState(state);
  const postal = optionalString(body, "postalCode", 10);
  if (postal !== undefined) patch.postalCode = requirePostalCode(postal);
  const tz = optionalString(body, "timezone", 64);
  if (tz !== undefined) patch.timezone = requireTimezone(tz);
  const status = lifecycleStatus(body);
  if (status !== undefined) {
    assertStatusTransition(current.status, status);
    if (status === "active") {
      const owner = await store.getProviderEntity(organizationId, current.providerEntityId);
      if (owner?.status !== "active")
        throw conflict(
          "PROVIDER_ENTITY_NOT_ACTIVE",
          "a location can only be activated under an active provider entity",
        );
    }
    patch.status = status;
  }
  requireAnyChange(Object.keys(patch));
  const updated = await store.updateLocation(organizationId, id, patch);
  if (!updated) throw notFound("location");
  return { updated, changedFields: Object.keys(patch) };
}
