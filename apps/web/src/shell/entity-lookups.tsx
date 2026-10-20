import { EntityLookupField, humanizeIdentifier, useApiClient } from "@wardenx/ui";
import type {
  ApiClient,
  EntityLookupFieldProps,
  EntityLookupLoadInput,
  EntityLookupLoadResult,
  EntityLookupOption,
} from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "./session";

type LookupProps = Omit<EntityLookupFieldProps, "loadOptions">;
type MdmKind =
  | "physician"
  | "facility"
  | "payer"
  | "pharmacy"
  | "referral_source"
  | "dme_vendor"
  | "funeral_home";

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 5) : id;
}

function optionLabel(primary: ReactNode, secondary?: string | null): JSX.Element {
  return (
    <span style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}>
      <span>{primary}</span>
      {secondary ? (
        <code style={{ color: "var(--color-on-surface-variant)", fontFamily: "var(--font-mono)" }}>
          {secondary}
        </code>
      ) : null}
    </span>
  );
}

async function loadPatients(
  client: ApiClient,
  input: EntityLookupLoadInput,
  status?: string,
): Promise<EntityLookupLoadResult> {
  const query: Record<string, string | number> = { limit: input.limit };
  if (input.query) query.q = input.query;
  if (input.cursor) query.cursor = input.cursor;
  if (status) query.status = status;
  const { data, error } = await client.GET("/api/v1/patients", { params: { query } });
  if (error) throw error;
  return {
    options: (data?.items ?? []).map((p) => {
      const name = `${p.lastName}, ${p.firstName}`;
      return {
        id: p.id,
        label: optionLabel(name, p.mrn || shortId(p.id)),
        searchLabel: name,
        description: `${humanizeIdentifier(p.status)} · DOB ${p.dob}`,
      };
    }),
    nextCursor: data?.nextCursor ?? null,
  };
}

/** F-238 — referrals by the name they were received with (or referrer / dx), newest first. */
async function loadReferrals(
  client: ApiClient,
  input: EntityLookupLoadInput,
  includeConverted: boolean,
): Promise<EntityLookupLoadResult> {
  const query: Record<string, string | number | boolean> = { limit: input.limit };
  if (input.query) query.q = input.query;
  if (input.cursor) query.cursor = input.cursor;
  if (includeConverted) query.includeConverted = true;
  const { data, error } = await client.GET("/api/v1/referrals", { params: { query } });
  if (error) throw error;
  return {
    options: (data?.items ?? []).map((r) => {
      const name = r.patientNameAtReceipt ?? `Referral ${shortId(r.id)}`;
      const received = r.receivedAt ? r.receivedAt.slice(0, 10) : null;
      return {
        id: r.id,
        label: optionLabel(name, received),
        searchLabel: name,
        description: [
          humanizeIdentifier(r.state),
          r.patientDobAtReceipt ? `DOB ${r.patientDobAtReceipt}` : null,
          r.referrerOrganization ?? null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }),
    nextCursor: data?.nextCursor ?? null,
  };
}

async function loadMdm(
  client: ApiClient,
  kind: MdmKind,
  input: EntityLookupLoadInput,
): Promise<EntityLookupLoadResult> {
  const query: Record<string, string | number> = { limit: input.limit };
  if (input.query) query.q = input.query;
  const { data, error } = await client.GET("/api/v1/mdm/{kind}/search", {
    params: { path: { kind }, query },
  });
  if (error) throw error;
  return {
    options: (data?.results ?? []).map((r) => ({
      id: r.id,
      label: optionLabel(r.canonical.displayName, r.canonical.identifierValue ?? shortId(r.id)),
      searchLabel: r.canonical.displayName,
      description: `${humanizeIdentifier(r.status)} · ${humanizeIdentifier(r.canonical.identifierType)}`,
    })),
    nextCursor: null,
  };
}

/** Which id a member option carries: the org membership (default) or the member's user id. */
type MemberIdKind = "membership" | "user";

async function loadMembers(
  client: ApiClient,
  organizationId: string,
  input: EntityLookupLoadInput,
  idKind: MemberIdKind = "membership",
): Promise<EntityLookupLoadResult> {
  if (!organizationId) return { options: [], nextCursor: null };
  const query = input.query ? { q: input.query } : {};
  const { data, error } = await client.GET("/api/v1/orgs/{id}/members", {
    params: { path: { id: organizationId }, query },
  });
  if (error) throw error;
  return {
    options: (data?.members ?? [])
      .filter((m) => m.status === "active")
      .map((m) => ({
        id: m.membershipId,
        // Keep the lookup value in membership-id space for its existing consumers, while allowing
        // workflows whose public contract names the M2 user (such as patient assignments) to resolve
        // the corresponding user id without a second roster request.
        metadata: { userId: m.userId },
        label: optionLabel(m.displayName ?? m.email ?? "Unnamed member", shortId(m.membershipId)),
        searchLabel: m.displayName ?? m.email ?? m.membershipId,
        description: m.email ?? m.status,
      })),
    nextCursor: null,
  };
}

/**
 * Care-team staff for the assign dialog: GET /orgs/{id}/care-team-staff (patient.assign, allowlisted
 * fields — name and role labels, no email), so a clinician who may assign but lacks `member.manage` can
 * still pick someone. Option ids are membership ids with the user id in metadata, like loadMembers.
 */
class StaffLookupForbiddenError extends Error {}

async function loadCareTeamStaff(
  client: ApiClient,
  organizationId: string,
  input: EntityLookupLoadInput,
): Promise<EntityLookupLoadResult> {
  if (!organizationId) return { options: [], nextCursor: null };
  const { data, error, response } = await client.GET("/api/v1/orgs/{id}/care-team-staff", {
    params: {
      path: { id: organizationId },
      query: { ...(input.query ? { q: input.query } : {}), limit: input.limit },
    },
  });
  if (error) throw response?.status === 403 ? new StaffLookupForbiddenError() : error;
  return {
    options: (data?.staff ?? []).map((m) => {
      const name = m.displayName ?? "Unnamed staff member";
      return {
        id: m.membershipId,
        metadata: { userId: m.userId },
        label: optionLabel(name, m.roleLabels.join(", ") || null),
        searchLabel: name,
      };
    }),
    nextCursor: null,
  };
}

/**
 * F-066 (#161) — the patient's admissions, newest first, from the read F-065 added.
 *
 * This used to page `GET /api/v1/admissions`, the ORG-WIDE census: it takes no patient filter and its
 * items are `{ id, state, version }` with no `patientId`, so the options could not be narrowed to the
 * patient and could not even be LABELLED with whose they were. `AdmissionLookupField` accepted a
 * `patientId` prop and destructured it into `_patientId` — accepted and dropped. The clerk therefore
 * chose an opaque uuid from every admission in the organization; the issue called the old raw text
 * input a transcription error waiting to become a billing error, and picking the wrong tenant-wide row
 * from a list of `Admission 3f2a1b0c` is the same error with a dropdown around it.
 */
async function loadPatientAdmissions(
  client: ApiClient,
  patientId: string | undefined,
  input: EntityLookupLoadInput,
  state?: string,
): Promise<EntityLookupLoadResult> {
  // No patient chosen yet: the field is disabled and says so — never a list nobody can choose from.
  if (!patientId) return { options: [], nextCursor: null };
  const { data, error } = await client.GET("/api/v1/patients/{patientId}/admissions", {
    params: { path: { patientId } },
  });
  if (error) throw error;
  const patientItems = (data?.items ?? []) as Array<{
    id: string;
    state: string;
    admissionAt: string | null;
    dischargedAt: string | null;
  }>;
  // Optional lifecycle filter (e.g. `state="active"` for clinical creates) — applied client-side
  // because the patient-scoped read answers every admission in one page.
  const rawItems = state ? patientItems.filter((a) => a.state === state) : patientItems;
  const needle = input.query.trim().toLowerCase();
  const items = needle
    ? rawItems.filter(
        (a) =>
          a.id.toLowerCase().includes(needle) ||
          a.state.toLowerCase().includes(needle) ||
          (a.admissionAt ?? "").toLowerCase().includes(needle),
      )
    : rawItems;
  return {
    options: items.map((a) => ({
      // The admission a human recognises is the one they can DATE. The uuid stays as the secondary,
      // because it is what the wizard sends and a biller reconciling against a record may need it.
      id: a.id,
      label: optionLabel(
        a.admissionAt ? `Admitted ${a.admissionAt.slice(0, 10)}` : "Admission (no date recorded)",
        shortId(a.id),
      ),
      searchLabel: a.admissionAt ?? a.id,
      description: a.dischargedAt
        ? `${a.state} · discharged ${a.dischargedAt.slice(0, 10)}`
        : `${a.state} · open`,
    })),
    // The route answers the patient's admissions in one page — there is no cursor to follow.
    nextCursor: null,
  };
}

async function loadProviderEntities(
  client: ApiClient,
  input: EntityLookupLoadInput,
): Promise<EntityLookupLoadResult> {
  const query: { q?: string; cursor?: string; limit: number } = { limit: input.limit };
  if (input.query) query.q = input.query;
  if (input.cursor) query.cursor = input.cursor;
  const { data, error } = await client.GET("/api/v1/provider-entities", {
    params: { query },
  });
  if (error) throw error;
  return {
    options: (data.items ?? []).map((p) => ({
      id: p.id,
      label: optionLabel(p.legalName, p.ccn),
      searchLabel: p.legalName,
      description: p.npi
        ? `${humanizeIdentifier(p.status)} · NPI ${p.npi}`
        : humanizeIdentifier(p.status),
    })),
    nextCursor: data.nextCursor ?? null,
  };
}

async function loadLocations(
  client: ApiClient,
  providerEntityId: string | undefined,
  input: EntityLookupLoadInput,
): Promise<EntityLookupLoadResult> {
  if (!providerEntityId) return { options: [], nextCursor: null };
  const query: { providerEntityId: string; q?: string; limit: number } = {
    providerEntityId,
    limit: input.limit,
  };
  if (input.query) query.q = input.query;
  const getLocations = client.GET as unknown as (
    path: "/api/v1/locations",
    init: { params: { query: typeof query } },
  ) => Promise<{
    data?: {
      items?: Array<{
        id: string;
        providerEntityId: string;
        name: string;
        addressLine1: string;
        addressLine2?: string | null;
        city: string;
        state: string;
        postalCode: string;
        status: string;
      }>;
    };
    error?: unknown;
  }>;
  const { data, error } = await getLocations("/api/v1/locations", {
    params: { query },
  });
  if (error) throw error;
  const rows = data?.items ?? [];
  return {
    options: rows.map((location) => {
      const description = [
        location.addressLine1,
        `${location.city}, ${location.state} ${location.postalCode}`,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        id: location.id,
        label: optionLabel(location.name, location.status),
        searchLabel: location.name,
        description,
      };
    }),
    nextCursor: null,
  };
}

async function loadPatientPayers(
  client: ApiClient,
  patientId: string,
  input: EntityLookupLoadInput,
): Promise<EntityLookupLoadResult> {
  if (!patientId) return { options: [], nextCursor: null };
  const { data, error } = await client.GET("/api/v1/patients/{id}/payers", {
    params: { path: { id: patientId } },
  });
  if (error) throw error;
  const needle = input.query.trim().toLowerCase();
  const rows = (data?.payers ?? []).filter((p) =>
    [p.id, p.payerId, p.coverageKind, p.rank].some((v) => String(v).toLowerCase().includes(needle)),
  );
  return {
    options: rows.map((p) => ({
      id: p.id,
      label: optionLabel(`Payer ${shortId(p.payerId)}`, shortId(p.id)),
      searchLabel: p.payerId,
      description: `Rank ${p.rank} · ${p.coverageKind}`,
    })),
    nextCursor: null,
  };
}

export function PatientLookupField(props: LookupProps & { status?: string }): JSX.Element {
  const client = useApiClient();
  const { status, ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadPatients(client, input, status),
    [client, status],
  );
  return (
    <EntityLookupField
      {...rest}
      loadOptions={loadOptions}
      placeholder={props.placeholder ?? "Search patient name or MRN..."}
    />
  );
}

/** F-238 — pick the referral (prospect) records belong to; converted referrals only when asked. */
export function ReferralLookupField(
  props: LookupProps & { includeConverted?: boolean },
): JSX.Element {
  const client = useApiClient();
  const { includeConverted = false, ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadReferrals(client, input, includeConverted),
    [client, includeConverted],
  );
  return (
    <EntityLookupField
      {...rest}
      loadOptions={loadOptions}
      placeholder={props.placeholder ?? "Search referral by patient name..."}
    />
  );
}

export function ProviderEntityLookupField(props: LookupProps): JSX.Element {
  const client = useApiClient();
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadProviderEntities(client, input),
    [client],
  );
  return (
    <EntityLookupField
      {...props}
      loadOptions={loadOptions}
      placeholder={props.placeholder ?? "Search provider entity or CCN..."}
    />
  );
}

export function LocationLookupField(
  props: LookupProps & { providerEntityId?: string },
): JSX.Element {
  const client = useApiClient();
  const { providerEntityId, ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadLocations(client, providerEntityId, input),
    [client, providerEntityId],
  );
  return (
    <EntityLookupField
      {...rest}
      disabled={props.disabled || !providerEntityId}
      loadOptions={loadOptions}
      placeholder={
        props.placeholder ??
        (providerEntityId ? "Search service location..." : "Choose a provider first")
      }
    />
  );
}

export function MembershipLookupField(props: LookupProps & { idKind?: MemberIdKind }): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const organizationId = session?.organizationId ?? "";
  const { idKind = "membership", ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadMembers(client, organizationId, input, idKind),
    [client, organizationId, idKind],
  );
  return (
    <EntityLookupField
      {...rest}
      loadOptions={loadOptions}
      placeholder={props.placeholder ?? "Search staff by name or email..."}
    />
  );
}

export function CareTeamStaffLookupField(props: LookupProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const organizationId = session?.organizationId ?? "";
  const [forbidden, setForbidden] = useState(false);
  const loadOptions = useCallback(
    async (input: EntityLookupLoadInput) => {
      try {
        const result = await loadCareTeamStaff(client, organizationId, input);
        setForbidden(false);
        return result;
      } catch (err) {
        // A 403 is a permission answer, not an outage: say so instead of the generic "Lookup unavailable".
        if (err instanceof StaffLookupForbiddenError) {
          setForbidden(true);
          return { options: [], nextCursor: null };
        }
        throw err;
      }
    },
    [client, organizationId],
  );
  return (
    <EntityLookupField
      {...props}
      loadOptions={loadOptions}
      // The search input already carries the browser's own clear (x); a second button doubled it.
      clearable={false}
      error={props.error ?? (forbidden ? "You don't have permission to look up staff." : undefined)}
      hint={props.hint ?? "Search by name. Up to 25 shown."}
      placeholder={props.placeholder ?? "Search staff by name..."}
    />
  );
}

export function MdmEntityLookupField(props: LookupProps & { kind: MdmKind }): JSX.Element {
  const client = useApiClient();
  const { kind, ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadMdm(client, kind, input),
    [client, kind],
  );
  return (
    <EntityLookupField
      {...rest}
      loadOptions={loadOptions}
      placeholder={props.placeholder ?? "Search name or identifier..."}
    />
  );
}

/**
 * F-066 (#161) — `patientId` scopes the read, and is now actually used. An admission is only meaningful
 * against the patient it belongs to: every clinical create keyed by `admissionId` is a create FOR a
 * patient, so a lookup that spans the organization can only ever offer wrong answers alongside the
 * right one. Until a patient is chosen the field is disabled and says why, rather than listing the
 * whole census.
 */
export function AdmissionLookupField(
  props: LookupProps & { patientId?: string; state?: string },
): JSX.Element {
  const client = useApiClient();
  const { patientId, state, noMatchesContent, ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadPatientAdmissions(client, patientId, input, state),
    [client, patientId, state],
  );
  return (
    <EntityLookupField
      {...rest}
      loadOptions={loadOptions}
      noMatchesContent={
        noMatchesContent ??
        (patientId ? <AdmissionNoMatchesActions patientId={patientId} /> : undefined)
      }
      disabled={props.disabled ?? !patientId}
      hint={props.hint ?? (patientId ? undefined : "Choose a patient first.")}
      placeholder={props.placeholder ?? "Search this patient's admissions..."}
    />
  );
}

function AdmissionNoMatchesActions({ patientId }: { patientId: string }): JSX.Element {
  const encodedPatientId = encodeURIComponent(patientId);
  return (
    <span style={lookupEmptyActionsStyle}>
      <span>No active admissions found.</span>
      <span style={lookupEmptyLinkRowStyle}>
        <Link to={`/admissions/new?patientId=${encodedPatientId}`} style={lookupEmptyLinkStyle}>
          Direct admission
        </Link>
        <Link to={`/referrals/new?patientId=${encodedPatientId}`} style={lookupEmptyLinkStyle}>
          Start referral
        </Link>
      </span>
    </span>
  );
}

export function PatientPayerLookupField(props: LookupProps & { patientId: string }): JSX.Element {
  const client = useApiClient();
  const { patientId, ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadPatientPayers(client, patientId, input),
    [client, patientId],
  );
  return (
    <EntityLookupField
      {...rest}
      loadOptions={loadOptions}
      placeholder={props.placeholder ?? "Search patient payers..."}
    />
  );
}

const lookupEmptyActionsStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.45rem",
  width: "100%",
} as const;

const lookupEmptyLinkRowStyle = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
} as const;

const lookupEmptyLinkStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-primary)",
  fontSize: "0.75rem",
  fontWeight: 650,
  textDecoration: "none",
} as const;
