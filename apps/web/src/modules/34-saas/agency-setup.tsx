// apps/web/src/modules/34-saas — Agency setup: the tenant's provider entity (CMS identity: CCN, NPI, EIN) and its
// service locations. The M34 onboarding checks (`ccn_registered`, `org_seeded`, `locations_seeded`) read exactly
// these M2 rows, and until now nothing in either app created them. Backed by the existing M2 org-admin routes
// GET/POST /api/v1/provider-entities and /api/v1/locations (both gated server-side on `org.manage`).
import {
  Button,
  InlineAlert,
  LoadingSpinner,
  PageHeader,
  SelectField,
  TextField,
  WorkQueueLayout,
  useApiClient,
  useRequestGuard,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";

interface ProviderEntityRow {
  id: string;
  legalName: string;
  ccn: string | null;
  npi: string | null;
  status: string;
}
interface LocationRow {
  id: string;
  providerEntityId: string;
  name: string;
  city: string;
  state: string;
  timezone: string;
  status: string;
}

const CCN_SHAPE = /^[0-9A-Z]{6}$/;
const NPI_SHAPE = /^[0-9]{10}$/;
const FISCAL_YEAR_END_SHAPE = /^[0-9]{4}$/;
const STATE_SHAPE = /^[A-Z]{2}$/;
const ZIP_SHAPE = /^\d{5}(-\d{4})?$/;

function serverMessage(err: unknown): string | null {
  const message = (err as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

const UNREACHABLE = "Could not reach the server. Try again.";

export function AgencySetup(): JSX.Element {
  const client = useApiClient();
  const guard = useRequestGuard();
  const [entities, setEntities] = useState<ProviderEntityRow[] | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    const isCurrent = guard();
    try {
      const [pe, loc] = await Promise.all([
        client.GET("/api/v1/provider-entities", { params: { query: { limit: 100 } } }),
        client.GET("/api/v1/locations", { params: { query: { limit: 100 } } }),
      ]);
      if (!isCurrent()) return;
      if (pe.error || loc.error || !pe.data || !loc.data) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setEntities(pe.data.items as unknown as ProviderEntityRow[]);
      setLocations(loc.data.items as unknown as LocationRow[]);
    } catch {
      if (isCurrent()) setLoadError(true);
    }
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Agency setup" breadcrumb="Admin / Organization">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            Register your agency's CMS identity and its service locations. Onboarding cannot finish
            until both exist.
          </p>
        </PageHeader>
      }
      table={
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {loadError ? (
            <>
              <InlineAlert tone="error">Could not load your agency details.</InlineAlert>
              <Button tone="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </>
          ) : null}
          {entities === null && !loadError ? <LoadingSpinner label="Loading…" /> : null}
          {/* Render the sections only once the lists are known: "no provider entity yet" on a failed or pending
              load would invite creating a duplicate CCN/NPI. */}
          {entities !== null ? (
            <>
              <ProviderEntitySection entities={entities} onCreated={load} />
              <LocationSection entities={entities} locations={locations} onCreated={load} />
            </>
          ) : null}
        </div>
      }
    />
  );
}

const EMPTY_ENTITY = { legalName: "", ccn: "", npi: "", taxId: "", fiscalYearEnd: "" };

function ProviderEntitySection({
  entities,
  onCreated,
}: { entities: ProviderEntityRow[]; onCreated: () => Promise<void> }): JSX.Element {
  const client = useApiClient();
  const [form, setForm] = useState(EMPTY_ENTITY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const legalName = form.legalName.trim();
    const ccn = form.ccn.trim().toUpperCase();
    const npi = form.npi.trim();
    const taxId = form.taxId.trim();
    const fiscalYearEnd = form.fiscalYearEnd.trim();
    if (!legalName || !taxId) {
      setError("Enter the legal name and the 9-digit EIN.");
      return;
    }
    if (!CCN_SHAPE.test(ccn)) {
      setError("The CCN is 6 characters (digits or capital letters).");
      return;
    }
    if (!NPI_SHAPE.test(npi)) {
      setError("The NPI is 10 digits.");
      return;
    }
    if (!FISCAL_YEAR_END_SHAPE.test(fiscalYearEnd)) {
      setError("The fiscal year end is MMDD, e.g. 1231.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { error: err } = await client.POST("/api/v1/provider-entities", {
        body: { legalName, ccn, npi, taxId, fiscalYearEnd },
      });
      if (err) {
        setError(serverMessage(err) ?? "The provider entity could not be created.");
        return;
      }
      setForm(EMPTY_ENTITY);
      await onCreated();
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Provider entities">
      <h2 style={{ fontSize: "1rem" }}>Provider entities</h2>
      {entities.length === 0 ? <p>No provider entity yet.</p> : null}
      <ul>
        {entities.map((p) => (
          <li key={p.id}>
            <strong>{p.legalName}</strong> · CCN {p.ccn ?? "—"} · NPI {p.npi ?? "—"} · {p.status}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => void submit(e)}
        style={{ display: "grid", gap: "0.75rem", maxWidth: "28rem" }}
      >
        <TextField
          label="Legal name"
          value={form.legalName}
          onChange={(e) => set("legalName")(e.target.value)}
        />
        <TextField
          label="CCN"
          hint="6-character CMS Certification Number."
          value={form.ccn}
          onChange={(e) => set("ccn")(e.target.value)}
        />
        <TextField
          label="NPI"
          hint="10 digits."
          value={form.npi}
          onChange={(e) => set("npi")(e.target.value)}
        />
        <TextField
          label="Tax ID (EIN)"
          hint="12-3456789. Stored encrypted; never shown again."
          value={form.taxId}
          autoComplete="off"
          onChange={(e) => set("taxId")(e.target.value)}
        />
        <TextField
          label="Fiscal year end (MMDD)"
          value={form.fiscalYearEnd}
          onChange={(e) => set("fiscalYearEnd")(e.target.value)}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add provider entity"}
        </Button>
      </form>
    </section>
  );
}

const EMPTY_LOCATION = {
  providerEntityId: "",
  name: "",
  addressLine1: "",
  city: "",
  state: "",
  postalCode: "",
  timezone: "",
};

function LocationSection({
  entities,
  locations,
  onCreated,
}: {
  entities: ProviderEntityRow[];
  locations: LocationRow[];
  onCreated: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [form, setForm] = useState(EMPTY_LOCATION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const noEntities = entities.length === 0;
  const providerEntityId = form.providerEntityId || entities[0]?.id || "";

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || noEntities) return;
    const name = form.name.trim();
    const addressLine1 = form.addressLine1.trim();
    const city = form.city.trim();
    const timezone = form.timezone.trim();
    const state = form.state.trim().toUpperCase();
    const postalCode = form.postalCode.trim();
    if (!name || !addressLine1 || !city || !timezone) {
      setError("Enter the location name, address, city and time zone.");
      return;
    }
    if (!STATE_SHAPE.test(state)) {
      setError("The state is a 2-letter code, e.g. CA.");
      return;
    }
    if (!ZIP_SHAPE.test(postalCode)) {
      setError("The ZIP code is 5 digits (or ZIP+4).");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { error: err } = await client.POST("/api/v1/locations", {
        body: { providerEntityId, name, addressLine1, city, state, postalCode, timezone },
      });
      if (err) {
        setError(serverMessage(err) ?? "The location could not be created.");
        return;
      }
      setForm((f) => ({ ...EMPTY_LOCATION, providerEntityId: f.providerEntityId, timezone }));
      await onCreated();
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Locations">
      <h2 style={{ fontSize: "1rem" }}>Locations</h2>
      {noEntities ? <p>Add a provider entity first; a location belongs to one.</p> : null}
      {locations.length === 0 && !noEntities ? <p>No location yet.</p> : null}
      <ul>
        {locations.map((l) => (
          <li key={l.id}>
            <strong>{l.name}</strong> · {l.city}, {l.state} · {l.timezone} · {l.status}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => void submit(e)}
        style={{ display: "grid", gap: "0.75rem", maxWidth: "28rem" }}
      >
        <SelectField
          label="Provider entity"
          value={providerEntityId}
          disabled={noEntities}
          onChange={(e) => set("providerEntityId")(e.target.value)}
          options={entities.map((p) => ({ value: p.id, label: p.legalName }))}
        />
        <TextField
          label="Location name"
          value={form.name}
          onChange={(e) => set("name")(e.target.value)}
        />
        <TextField
          label="Address line 1"
          value={form.addressLine1}
          onChange={(e) => set("addressLine1")(e.target.value)}
        />
        <TextField label="City" value={form.city} onChange={(e) => set("city")(e.target.value)} />
        <TextField
          label="State"
          hint="2-letter code."
          value={form.state}
          onChange={(e) => set("state")(e.target.value)}
        />
        <TextField
          label="ZIP code"
          value={form.postalCode}
          onChange={(e) => set("postalCode")(e.target.value)}
        />
        <TextField
          label="Time zone"
          hint="IANA zone, e.g. America/Los_Angeles."
          value={form.timezone}
          onChange={(e) => set("timezone")(e.target.value)}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <Button type="submit" disabled={busy || noEntities}>
          {busy ? "Adding…" : "Add location"}
        </Button>
      </form>
    </section>
  );
}
