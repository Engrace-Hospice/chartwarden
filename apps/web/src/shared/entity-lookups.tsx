import { EntityLookupField, useApiClient } from "@wardenx/ui";
import type {
  ApiClient,
  EntityLookupFieldProps,
  EntityLookupLoadInput,
  EntityLookupLoadResult,
  EntityLookupOption,
} from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../shell/session";

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
  return id.length > 8 ? id.slice(0, 8) : id;
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
        description: `${p.status} · DOB ${p.dob}`,
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
      description: `${r.status} · ${r.canonical.identifierType}`,
    })),
    nextCursor: null,
  };
}

async function loadMembers(
  client: ApiClient,
  organizationId: string,
  input: EntityLookupLoadInput,
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
        label: optionLabel(m.displayName ?? m.email ?? "Unnamed member", shortId(m.membershipId)),
        searchLabel: m.displayName ?? m.email ?? m.membershipId,
        description: m.email ?? m.status,
      })),
    nextCursor: null,
  };
}

async function loadAdmissions(
  client: ApiClient,
  input: EntityLookupLoadInput,
  state?: string,
  patientId?: string,
): Promise<EntityLookupLoadResult> {
  const query: Record<string, string | number> = { limit: input.limit };
  if (input.cursor) query.cursor = input.cursor;
  if (state) query.state = state;
  if (patientId) query.patientId = patientId;
  const { data, error } = await client.GET("/api/v1/admissions", {
    params: { query },
  } as never);
  if (error) throw error;
  const rawItems = ((
    data as {
      items?: Array<{ id: string; state: string }>;
      nextCursor?: string | null;
    }
  )?.items ?? []) as Array<{ id: string; state: string }>;
  const needle = input.query.trim().toLowerCase();
  const items = needle
    ? rawItems.filter(
        (a) => a.id.toLowerCase().includes(needle) || a.state.toLowerCase().includes(needle),
      )
    : rawItems;
  return {
    options: items.map((a) => ({
      id: a.id,
      label: optionLabel(`Admission ${shortId(a.id)}`, a.state),
      searchLabel: a.id,
      description: "Admission record",
    })),
    nextCursor: (data as { nextCursor?: string | null } | undefined)?.nextCursor ?? null,
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
      description: p.npi ? `${p.status} · NPI ${p.npi}` : p.status,
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
    (input: EntityLookupLoadInput) =>
      loadLocations(client, providerEntityId, input),
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

export function MembershipLookupField(props: LookupProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const organizationId = session?.organizationId ?? "";
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadMembers(client, organizationId, input),
    [client, organizationId],
  );
  return (
    <EntityLookupField
      {...props}
      loadOptions={loadOptions}
      placeholder={props.placeholder ?? "Search staff by name or email..."}
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

export function AdmissionLookupField(
  props: LookupProps & { patientId?: string; state?: string },
): JSX.Element {
  const client = useApiClient();
  const { patientId, state, noMatchesContent, ...rest } = props;
  const loadOptions = useCallback(
    (input: EntityLookupLoadInput) => loadAdmissions(client, input, state, patientId),
    [client, patientId, state],
  );
  return (
    <EntityLookupField
      {...rest}
      loadOptions={loadOptions}
      noMatchesContent={
        noMatchesContent ?? (patientId ? <AdmissionNoMatchesActions patientId={patientId} /> : undefined)
      }
      placeholder={props.placeholder ?? "Search admissions..."}
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
