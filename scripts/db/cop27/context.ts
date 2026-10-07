/**
 * COP27 API seed — discover the organization's existing setup through read routes only.
 *
 * The seed never creates org configuration (provider entities, locations, MDM physicians, users, roles).
 * It reads what the organization already has and picks from it; anything missing turns the dependent steps
 * into clear skips. Physician-only steps (CTI signature, F2F attestation, for-cause cosign) need a signed-in
 * user holding `medical_director` or `hospice_physician`: the admin itself when it holds one, otherwise an
 * optional existing physician account supplied through the environment.
 */
import { type Session, must } from "./http";

/** Role keys that satisfy `cti.is_hospice_md`, the F2F attestation predicate and the discharge-order signer. */
export const PHYSICIAN_ROLE_KEYS = ["medical_director", "hospice_physician"] as const;

export interface MdmPhysician {
  readonly id: string;
  readonly name: string;
  readonly npi: string | null;
  readonly isNp: boolean;
}

export interface SeedContext {
  readonly admin: Session;
  /** Accounts to try, in order, for anything scoped to a patient or a sited admission. */
  readonly sessions: readonly Session[];
  readonly adminRoles: readonly string[];
  readonly adminMembershipId: string | null;
  /** The session that signs physician-only documents, or null when nobody available holds the role. */
  readonly physician: Session | null;
  readonly physicianLabel: string;
  readonly providerEntity: { readonly id: string; readonly name: string } | null;
  readonly location: {
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
    readonly address: { line1: string; city: string; state: string; postalCode: string };
  } | null;
  /** MDM physician for the hospice medical director / certifying physician fields. */
  readonly hospiceMd: MdmPhysician | null;
  /** MDM physician for the attending fields (distinct from hospiceMd when the directory allows). */
  readonly attending: MdmPhysician | null;
  /** A scheduling-directory membership with the RN discipline (visit performer), or null. */
  readonly rnMembershipId: string | null;
  readonly rnLabel: string;
}

interface AuthContext {
  userId: string;
  membershipId: string | null;
  displayName: string | null;
  roles: string[];
}

export async function authContext(session: Session): Promise<AuthContext> {
  return must<AuthContext>("auth context", session.client.GET("/api/v1/auth/context"));
}

async function findProviderEntity(
  admin: Session,
  preferredId: string | undefined,
): Promise<SeedContext["providerEntity"]> {
  const page = await must<{ items: Array<{ id: string; legalName: string; status: string }> }>(
    "list provider entities",
    admin.client.GET("/api/v1/provider-entities", { params: { query: { limit: 50 } } }),
  );
  const active = page.items.filter((p) => p.status === "active");
  const hit = preferredId ? active.find((p) => p.id === preferredId) : active[0];
  return hit ? { id: hit.id, name: hit.legalName } : null;
}

async function findLocation(
  admin: Session,
  providerEntityId: string,
): Promise<SeedContext["location"]> {
  const page = await must<{
    items: Array<{
      id: string;
      name: string;
      addressLine1: string;
      city: string;
      state: string;
      postalCode: string;
      timezone: string;
    }>;
  }>(
    "list locations",
    admin.client.GET("/api/v1/locations", {
      params: { query: { providerEntityId, status: "active", limit: 50 } },
    }),
  );
  // A home-care site (not the inpatient unit) is where routine-home-care admissions are sited.
  const hit = page.items.find((l) => !/inpatient|ipu/i.test(l.name)) ?? page.items[0] ?? undefined;
  if (!hit) return null;
  return {
    id: hit.id,
    name: hit.name,
    timezone: hit.timezone,
    address: {
      line1: hit.addressLine1,
      city: hit.city,
      state: hit.state,
      postalCode: hit.postalCode,
    },
  };
}

async function listMdmPhysicians(admin: Session): Promise<MdmPhysician[]> {
  const res = await must<{
    results: Array<{
      id: string;
      status: string;
      canonical: { displayName: string; identifierValue: string | null; isNp?: boolean };
    }>;
  }>(
    "search MDM physicians",
    admin.client.GET("/api/v1/mdm/{kind}/search", {
      params: { path: { kind: "physician" }, query: { limit: 50 } },
    }),
  );
  return res.results
    .filter((r) => r.status === "active")
    .map((r) => ({
      id: r.id,
      name: r.canonical.displayName,
      npi: r.canonical.identifierValue,
      isNp: r.canonical.isNp === true,
    }));
}

/**
 * An RN to perform the demo visits: the scheduling directory's RN discipline, preferring one whose membership
 * is sited (default locations) — the scheduler refuses to site a visit for a membership without one.
 */
async function findRn(admin: Session): Promise<{ id: string | null; label: string }> {
  const staff = await must<
    Array<{ membershipId: string; displayName: string; discipline: string | null }>
  >("scheduling staff directory", admin.client.GET("/api/v1/scheduling/staff"));
  const rns = staff.filter((s) => s.discipline === "rn");
  if (rns.length === 0) return { id: null, label: "none" };
  const members = await must<{
    members: Array<{ membershipId: string; defaultLocationIds: string[] }>;
  }>(
    "list members",
    admin.client.GET("/api/v1/orgs/{id}/members", {
      params: { path: { id: admin.organizationId } },
    }),
  );
  const sited = new Set(
    members.members.filter((m) => m.defaultLocationIds.length > 0).map((m) => m.membershipId),
  );
  const rn = rns.find((r) => sited.has(r.membershipId)) ?? rns[0];
  if (!rn) return { id: null, label: "none" };
  return {
    id: rn.membershipId,
    label: `${rn.displayName}${sited.has(rn.membershipId) ? "" : " (no default location — visits will be refused)"}`,
  };
}

export interface DiscoverInput {
  readonly admin: Session;
  readonly physicianSession: Session | null;
  readonly providerEntityId?: string;
}

export async function discoverContext(input: DiscoverInput): Promise<SeedContext> {
  const { admin } = input;
  const adminCtx = await authContext(admin);
  const adminIsPhysician = adminCtx.roles.some((r) =>
    (PHYSICIAN_ROLE_KEYS as readonly string[]).includes(r),
  );
  let physician: Session | null = adminIsPhysician ? admin : null;
  let physicianLabel = adminIsPhysician ? `${admin.email} (admin holds a physician role)` : "none";
  if (!physician && input.physicianSession) {
    const ctx = await authContext(input.physicianSession);
    if (ctx.roles.some((r) => (PHYSICIAN_ROLE_KEYS as readonly string[]).includes(r))) {
      physician = input.physicianSession;
      physicianLabel = `${input.physicianSession.email} (${ctx.roles.join(", ")})`;
    } else {
      physicianLabel = `none — ${input.physicianSession.email} holds no physician role (${ctx.roles.join(", ")})`;
    }
  }

  const providerEntity = await findProviderEntity(admin, input.providerEntityId);
  const location = providerEntity ? await findLocation(admin, providerEntity.id) : null;
  const physicians = await listMdmPhysicians(admin);
  const mds = physicians.filter((p) => !p.isNp);
  const hospiceMd = mds[0] ?? null;
  const attending = mds[1] ?? mds[0] ?? null;
  const rn = await findRn(admin);

  return {
    admin,
    adminRoles: adminCtx.roles,
    adminMembershipId: adminCtx.membershipId,
    physician,
    sessions: physician && physician !== admin ? [admin, physician] : [admin],
    physicianLabel,
    providerEntity,
    location,
    hospiceMd,
    attending,
    rnMembershipId: rn.id,
    rnLabel: rn.label,
  };
}

export function describeContext(ctx: SeedContext): string[] {
  return [
    `organization:      ${ctx.admin.organizationName} (${ctx.admin.organizationId})`,
    `admin:             ${ctx.admin.email} roles=[${ctx.adminRoles.join(", ")}]`,
    `physician signer:  ${ctx.physicianLabel}`,
    `provider entity:   ${ctx.providerEntity ? `${ctx.providerEntity.name} (${ctx.providerEntity.id})` : "NONE — admission scenarios will be skipped"}`,
    `service location:  ${ctx.location ? `${ctx.location.name} (${ctx.location.id}, ${ctx.location.timezone})` : "NONE"}`,
    `MDM hospice MD:    ${ctx.hospiceMd ? `${ctx.hospiceMd.name} (${ctx.hospiceMd.id})` : "NONE — admission scenarios will be skipped"}`,
    `MDM attending:     ${ctx.attending ? `${ctx.attending.name} (${ctx.attending.id})` : "NONE"}`,
    `RN (visits):       ${ctx.rnLabel}`,
    ...(ctx.physician
      ? []
      : [
          "NOTE: no physician account — CTI signatures, F2F, prescribing, the transfer-in scenarios (03-06, 08-09)",
          "      and anything past a sited admission are skipped. Set WARDENX_SEED_PHYSICIAN_EMAIL/PASSWORD to an",
          "      existing medical_director account for full coverage.",
        ]),
  ];
}
