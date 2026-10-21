// apps/web/src/modules/19-oncall — S19.9 EXTERNAL-TRIAGE-VENDOR CONFIGURATION (`/triage/vendors`, §5.1,
// Track B / ADR-0030).
//
// THERE IS NO CREDENTIAL FIELD ON THIS SCREEN, AND THAT ABSENCE IS THE CONTROL. Vendor credentials live in
// the platform secret store (ADR-0026); `external_triage_vendor` has no secret column and §4.2's create
// body has no secret field. A "paste the API key here" box would have had nowhere to put it and would have
// taught an admin to paste it somewhere.
//
// `adapterRegistered` IS THE COLUMN THAT MATTERS, and it is not stored — the server answers it live from
// the adapter registry. A binding whose adapter is not loaded is configured and inert: it cannot carry a
// call. The admin must be able to see that at 4 p.m., not discover it at 2 a.m. when a call needs handing
// off. The adapter registry ships EMPTY on purpose, so a fresh deployment shows every binding as
// unregistered — that is correct and the screen says so rather than hiding the row.
//
// THE BAA IS A PRECONDITION, NOT A CHECKBOX WITH NO CONSEQUENCE. A binding created without it is refused
// rather than created-and-inert, because an inert binding is the worse outcome: the tenant's policy would
// then name a vendor that silently cannot carry a call.
//
// THE PATCH IS DELIBERATELY NARROW — "BAA renewal updates only". Neither the adapter key nor the
// minimization profile can be changed after creation, because either would silently re-point live PHI at a
// different contract. Changing one means creating a new binding, and the screen says that instead of
// offering fields that will be refused.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type MinimizationProfile,
  type VendorBindingView,
  createVendorBinding,
  errorMessage,
  listVendorBindings,
  patchVendorBinding,
} from "./oncall-api";
import {
  DEFAULT_MINIMIZATION_PROFILE,
  MINIMIZATION_PROFILES,
  humanize,
  shortDate,
  shortId,
} from "./oncall-status";
import {
  Card,
  CheckboxField,
  Modal,
  Notice,
  SelectField,
  TextField,
  alertStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./oncall-ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ExternalVendorAdminScreen(): JSX.Element {
  const client = useApiClient();
  const [bindings, setBindings] = useState<VendorBindingView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renewing, setRenewing] = useState<VendorBindingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // create fields
  const [mdmVendorId, setMdmVendorId] = useState("");
  const [name, setName] = useState("");
  const [adapterKey, setAdapterKey] = useState("");
  const [rnAttested, setRnAttested] = useState(false);
  const [baaInEffect, setBaaInEffect] = useState(false);
  const [baaExpiresOn, setBaaExpiresOn] = useState("");
  const [profile, setProfile] = useState(DEFAULT_MINIMIZATION_PROFILE);

  // renew fields
  const [renewBaa, setRenewBaa] = useState(true);
  const [renewExpiry, setRenewExpiry] = useState("");
  const [renewRn, setRenewRn] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listVendorBindings(client);
    if (res.error) {
      setError(errorMessage(res.error, "The vendor bindings could not be loaded."));
      setLoading(false);
      return;
    }
    setBindings(res.bindings ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const inert = bindings.filter((b) => !b.adapterRegistered).length;

  const canCreate =
    UUID_RE.test(mdmVendorId) &&
    name.trim().length >= 2 &&
    adapterKey.trim().length >= 2 &&
    baaInEffect &&
    !busy;

  async function commitCreate(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await createVendorBinding(client, {
      mdmVendorId,
      name,
      adapterKey,
      rnCoverageAttested: rnAttested,
      baaInEffect,
      ...(baaExpiresOn ? { baaExpiresOn } : {}),
      // `profile` is always one of MINIMIZATION_PROFILES — the SelectField below offers no other value.
      defaultMinimizationPolicy: { profile: profile as MinimizationProfile },
    });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "The vendor binding could not be created."));
      return;
    }
    setCreating(false);
    await load();
  }

  async function commitRenew(): Promise<void> {
    if (!renewing) return;
    setBusy(true);
    setActionError(null);
    const res = await patchVendorBinding(client, renewing.id, {
      baaInEffect: renewBaa,
      rnCoverageAttested: renewRn,
      baaExpiresOn: renewExpiry === "" ? null : renewExpiry,
    });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "The binding could not be updated."));
      return;
    }
    setRenewing(null);
    await load();
  }

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="External triage vendors"
            breadcrumb="On-call triage / Configuration"
            actions={
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={primaryButtonCompactStyle}
                  onClick={() => setCreating(true)}
                >
                  Bind a vendor
                </button>
                <Link to="/triage/policy" style={linkButtonStyle}>
                  On-call policy
                </Link>
              </div>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review vendor bindings, adapter readiness, BAA status, and PHI-minimization profiles.
            </div>
          </PageHeader>
        }
        filters={
          <div style={filterShellStyle}>
            <Notice tone="info">
              No credential appears on this page and none can be entered: vendor secrets live in the
              platform secret store. A binding carries vendor identity, adapter readiness, BAA
              status, and outbound PHI minimization.
            </Notice>
            {inert > 0 ? (
              <Notice tone="error" live>
                {inert} binding{inert === 1 ? " has" : "s have"} no loaded adapter. Such a binding
                is configured and inert — it cannot carry a call.
              </Notice>
            ) : null}
            {actionError ? (
              <div role="alert" style={errorBannerStyle}>
                {actionError}
              </div>
            ) : null}
          </div>
        }
        table={
          <div style={tableShellStyle}>
            {bindings.length === 0 ? (
              <div style={emptyShellStyle}>
                <EmptyState
                  title="No external vendors"
                  description="The direct model needs none; every night is answered by your own clinicians."
                />
              </div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={tableHeadRowStyle}>
                    <th style={th}>Vendor</th>
                    <th style={th}>Canonical entity</th>
                    <th style={th}>Adapter</th>
                    <th style={th}>Adapter loaded</th>
                    <th style={th}>BAA</th>
                    <th style={th}>BAA expires</th>
                    <th style={th}>RN coverage</th>
                    <th style={th}>Minimization</th>
                    <th style={th}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {bindings.map((b) => (
                    <tr key={b.id} style={rowLine}>
                      <td style={td}>{b.name}</td>
                      <td style={{ ...td, fontFamily: "var(--font-mono)" }}>
                        {shortId(b.mdmVendorId)}
                      </td>
                      <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{b.adapterKey}</td>
                      <td style={td}>
                        {b.adapterRegistered ? (
                          <StatusPill label="Loaded" tone="success" />
                        ) : (
                          <StatusPill label="Not registered" tone="error" />
                        )}
                      </td>
                      <td style={td}>
                        {b.baaInEffect ? (
                          <StatusPill label="In force" tone="success" />
                        ) : (
                          <StatusPill label="Not in force" tone="error" />
                        )}
                      </td>
                      <td style={td}>
                        {b.baaExpiresOn ? shortDate(b.baaExpiresOn) : "no stated expiry"}
                      </td>
                      <td style={td}>{b.rnCoverageAttested ? "Yes" : "No"}</td>
                      <td style={td}>{humanize(b.minimizationProfile)}</td>
                      <td style={td}>
                        <button
                          type="button"
                          style={busy ? disabledButtonCompactStyle : linkButtonStyle}
                          disabled={busy}
                          onClick={() => {
                            setRenewing(b);
                            setRenewBaa(b.baaInEffect);
                            setRenewRn(b.rnCoverageAttested);
                            setRenewExpiry(b.baaExpiresOn ?? "");
                          }}
                        >
                          BAA renewal
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={tableFootnoteStyle}>
              "No stated expiry" means the BAA carries no end date. The adapter key and minimization
              profile cannot be changed after creation; changing one means binding the vendor again.
            </div>
          </div>
        }
        fullPageScroll
      />

      {creating ? (
        <Modal
          title="Bind an external triage vendor"
          onClose={() => setCreating(false)}
          footer={
            <button
              type="button"
              disabled={!canCreate}
              style={canCreate ? primaryButtonStyle : disabledButtonStyle}
              title={
                canCreate
                  ? undefined
                  : "A canonical vendor id, a name, an adapter key and a BAA in force are all required."
              }
              onClick={() => void commitCreate()}
            >
              Bind
            </button>
          }
        >
          <Notice tone="warning">
            This write needs a recent step-up, and the BAA is a precondition rather than a note: a
            binding without one is refused outright, because a binding that exists but cannot carry
            a call is the worse failure.
          </Notice>
          <TextField
            label="Canonical vendor entity id"
            value={mdmVendorId}
            onChange={setMdmVendorId}
            mono
            hint="Validated against the master-data vendor registry at write."
          />
          <TextField label="Display name" value={name} onChange={setName} />
          <TextField
            label="Adapter key"
            value={adapterKey}
            onChange={setAdapterKey}
            mono
            hint="Selects the installed adapter. If no adapter with this key is loaded, the binding will show as not registered — configured, but unable to carry a call."
          />
          <SelectField
            label="PHI-minimization profile"
            value={profile}
            options={MINIMIZATION_PROFILES.map((p) => ({ value: p, label: humanize(p) }))}
            onChange={setProfile}
          />
          <CheckboxField
            label="The vendor has attested to RN-level coverage"
            checked={rnAttested}
            onChange={setRnAttested}
          />
          <CheckboxField
            label="A BAA is in force (required)"
            checked={baaInEffect}
            onChange={setBaaInEffect}
          />
          <TextField
            label="BAA expiry (optional)"
            value={baaExpiresOn}
            onChange={setBaaExpiresOn}
            type="date"
            hint="Leave blank when the BAA states no end date. Blank means 'no stated expiry', not 'unknown'."
          />
        </Modal>
      ) : null}

      {renewing ? (
        <Modal
          title={`BAA renewal — ${renewing.name}`}
          onClose={() => setRenewing(null)}
          footer={
            <button
              type="button"
              disabled={busy}
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() => void commitRenew()}
            >
              Save
            </button>
          }
        >
          <Notice tone="info">
            Only these three fields can change on an existing binding. The adapter key and
            minimization profile are fixed for the life of the binding.
          </Notice>
          <CheckboxField label="A BAA is in force" checked={renewBaa} onChange={setRenewBaa} />
          <CheckboxField
            label="The vendor has attested to RN-level coverage"
            checked={renewRn}
            onChange={setRenewRn}
          />
          <TextField label="BAA expiry" value={renewExpiry} onChange={setRenewExpiry} type="date" />
        </Modal>
      ) : null}
    </>
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const tableFootnoteStyle: CSSProperties = {
  marginTop: "0.85rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};

const linkButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};

const primaryButtonCompactStyle: CSSProperties = {
  ...primaryButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};

const disabledButtonCompactStyle: CSSProperties = {
  ...disabledButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};
