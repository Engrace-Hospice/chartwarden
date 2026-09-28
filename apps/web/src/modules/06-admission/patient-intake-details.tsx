import { Button, EmptyState, LoadingSpinner, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { MdmEntityLookupField } from "../../shell/entity-lookups";

interface AddressView {
  id?: string;
  kind?: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
  isPrimary?: boolean;
  current?: boolean;
}

interface PatientPayer {
  id: string;
  payerId: string;
  rank: number;
  coverageKind: string;
  subscriberId: string;
  groupNumber: string | null;
  binPcn: string | null;
  current: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface Props {
  patientId: string;
  onSaved?: () => void | Promise<void>;
}

type LoadState = "loading" | "ready" | "error";

export function PatientIntakeDetails({ patientId, onSaved }: Props): JSX.Element {
  const client = useApiClient();

  const [addresses, setAddresses] = useState<AddressView[]>([]);
  const [payers, setPayers] = useState<PatientPayer[]>([]);
  const [payerNames, setPayerNames] = useState<Record<string, string>>({});

  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  const [addressOpen, setAddressOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);

  const [busy, setBusy] = useState<"address" | "coverage" | null>(null);

  const [address, setAddress] = useState({
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
  });

  const [coverage, setCoverage] = useState({
    payerId: "",
    coverageKind: "",
    subscriberId: "",
    groupNumber: "",
    binPcn: "",
    rank: "1",
    effectiveFrom: new Date().toISOString().slice(0, 10),
  });

  const [addressError, setAddressError] = useState<string | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);

    const [addressRes, payerRes] = await Promise.all([
      client.GET("/api/v1/patients/{id}/addresses", {
        params: {
          path: {
            id: patientId,
          },
        },
      }),

      client.GET("/api/v1/patients/{id}/payers", {
        params: {
          path: {
            id: patientId,
          },
        },
      }),
    ]);

    if (addressRes.error || payerRes.error) {
      setState("error");
      setError("Patient address and coverage information could not be loaded.");
      return;
    }

    const nextAddresses =
      (
        addressRes.data as
          | {
              addresses?: AddressView[];
            }
          | undefined
      )?.addresses ?? [];

    const nextPayers =
      (
        payerRes.data as
          | {
              payers?: PatientPayer[];
            }
          | undefined
      )?.payers ?? [];

    setAddresses(nextAddresses);
    setPayers(nextPayers);

    const ids = [...new Set(nextPayers.map((payer) => payer.payerId).filter(Boolean))];

    const resolved = await Promise.all(
      ids.map(async (payerId) => {
        const result = await client.GET("/api/v1/mdm/{kind}/{id}", {
          params: {
            path: {
              kind: "payer",
              id: payerId,
            },
          },
        });

        const name = (
          result.data as
            | {
                canonical?: {
                  displayName?: string;
                };
              }
            | undefined
        )?.canonical?.displayName;

        return [payerId, name ?? ""] as const;
      }),
    );

    setPayerNames(Object.fromEntries(resolved.filter(([, name]) => Boolean(name))));

    setState("ready");
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentResidence =
    addresses.find((item) => item.current && item.isPrimary && item.kind === "home") ??
    addresses.find((item) => item.current && item.kind === "home") ??
    addresses.find((item) => item.current && item.isPrimary) ??
    null;

  const currentPayers = [...payers]
    .filter((payer) => payer.current)
    .sort((a, b) => a.rank - b.rank);

  async function saveAddress(): Promise<void> {
    setAddressError(null);

    if (!address.line1.trim()) {
      setAddressError("Street address is required.");
      return;
    }

    if (!address.city.trim()) {
      setAddressError("City is required.");
      return;
    }

    if (!address.postalCode.trim()) {
      setAddressError("ZIP / postal code is required.");
      return;
    }

    setBusy("address");

    const result = await client.POST("/api/v1/patients/{id}/addresses", {
      params: {
        path: {
          id: patientId,
        },
      },
      body: {
        kind: "home",
        line1: address.line1.trim(),
        ...(address.line2.trim()
          ? {
              line2: address.line2.trim(),
            }
          : {}),
        city: address.city.trim(),
        ...(address.state.trim()
          ? {
              state: address.state.trim().toUpperCase(),
            }
          : {}),
        postalCode: address.postalCode.trim(),
        isPrimary: true,
      },
    } as never);

    setBusy(null);

    if (result.error) {
      setAddressError(apiErrorMessage(result.error, "The residence address could not be saved."));
      return;
    }

    setAddress({
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
    });

    setAddressOpen(false);

    await load();
    await onSaved?.();
  }

  async function saveCoverage(): Promise<void> {
    setCoverageError(null);

    if (!coverage.payerId) {
      setCoverageError("Select a payer.");
      return;
    }

    if (!coverage.coverageKind.trim()) {
      setCoverageError("Coverage kind is required.");
      return;
    }

    if (!coverage.subscriberId.trim()) {
      setCoverageError("Member / subscriber ID is required.");
      return;
    }

    const rank = Number(coverage.rank);

    if (!Number.isInteger(rank) || rank < 1) {
      setCoverageError("Coverage rank must be 1 or greater.");
      return;
    }

    if (!coverage.effectiveFrom) {
      setCoverageError("Effective date is required.");
      return;
    }

    setBusy("coverage");

    const post = client.POST as unknown as (
      path: string,
      init: unknown,
    ) => Promise<{
      data?: unknown;
      error?: unknown;
    }>;

    const result = await post("/api/v1/patients/{id}/payers", {
      params: {
        path: {
          id: patientId,
        },
      },
      body: {
        payerId: coverage.payerId,
        rank,
        coverageKind: coverage.coverageKind.trim(),
        subscriberId: coverage.subscriberId.trim(),
        groupNumber: coverage.groupNumber.trim() || null,
        binPcn: coverage.binPcn.trim() || null,
        effectiveFrom: coverage.effectiveFrom,
      },
    });

    setBusy(null);

    if (result.error) {
      setCoverageError(apiErrorMessage(result.error, "The coverage could not be saved."));
      return;
    }

    setCoverage({
      payerId: "",
      coverageKind: "",
      subscriberId: "",
      groupNumber: "",
      binPcn: "",
      rank: "1",
      effectiveFrom: new Date().toISOString().slice(0, 10),
    });

    setCoverageOpen(false);

    await load();
    await onSaved?.();
  }

  if (state === "loading") {
    return (
      <div style={loadingBox}>
        <LoadingSpinner />
      </div>
    );
  }

  if (state === "error") {
    return (
      <EmptyState
        title="Patient information unavailable"
        description={error ?? "Address and coverage information could not be loaded."}
      />
    );
  }

  return (
    <div style={shell}>
      <div style={header}>
        <div>
          <h3 style={title}>Patient information</h3>

          <p style={description}>
            Residence address and coverage are optional during intake. You can continue without
            completing them.
          </p>
        </div>

        <StatusPill label="Optional" tone="neutral" />
      </div>

      <div style={grid}>
        {/* ADDRESS */}
        <section style={card}>
          <div style={cardHeader}>
            <div>
              <h4 style={cardTitle}>Residence address</h4>
              <p style={cardDescription}>
                Used as the patient residence / service-location context when available.
              </p>
            </div>

            <Button
              size="sm"
              tone="secondary"
              onClick={() => {
                setAddressError(null);
                setAddressOpen((value) => !value);
              }}
            >
              {currentResidence ? "Change address" : "Add address"}
            </Button>
          </div>

          {currentResidence ? (
            <div style={summaryBox}>
              <strong>{currentResidence.line1}</strong>

              {currentResidence.line2 ? <span>{currentResidence.line2}</span> : null}

              <span>
                {currentResidence.city}
                {currentResidence.state ? `, ${currentResidence.state}` : ""}{" "}
                {currentResidence.postalCode}
              </span>
            </div>
          ) : (
            <div style={emptyBox}>
              <strong>No residence address on file.</strong>
              <span>This does not block referral or admission progress.</span>
            </div>
          )}

          {addressOpen ? (
            <div style={form}>
              <label style={field}>
                <span style={label}>Street address</span>

                <input
                  value={address.line1}
                  onChange={(event) =>
                    setAddress((current) => ({
                      ...current,
                      line1: event.target.value,
                    }))
                  }
                  placeholder="123 Main St"
                  style={input}
                />
              </label>

              <label style={field}>
                <span style={label}>Address line 2</span>

                <input
                  value={address.line2}
                  onChange={(event) =>
                    setAddress((current) => ({
                      ...current,
                      line2: event.target.value,
                    }))
                  }
                  placeholder="Apartment, suite, unit..."
                  style={input}
                />
              </label>

              <div style={threeColumns}>
                <label style={field}>
                  <span style={label}>City</span>

                  <input
                    value={address.city}
                    onChange={(event) =>
                      setAddress((current) => ({
                        ...current,
                        city: event.target.value,
                      }))
                    }
                    style={input}
                  />
                </label>

                <label style={field}>
                  <span style={label}>State</span>

                  <input
                    value={address.state}
                    onChange={(event) =>
                      setAddress((current) => ({
                        ...current,
                        state: event.target.value,
                      }))
                    }
                    placeholder="TX"
                    maxLength={2}
                    style={input}
                  />
                </label>

                <label style={field}>
                  <span style={label}>ZIP / postal code</span>

                  <input
                    value={address.postalCode}
                    onChange={(event) =>
                      setAddress((current) => ({
                        ...current,
                        postalCode: event.target.value,
                      }))
                    }
                    style={input}
                  />
                </label>
              </div>

              {addressError ? (
                <p role="alert" style={errorText}>
                  {addressError}
                </p>
              ) : null}

              <div style={actions}>
                <Button
                  size="sm"
                  tone="tertiary"
                  disabled={busy === "address"}
                  onClick={() => {
                    setAddressOpen(false);
                    setAddressError(null);
                  }}
                >
                  Cancel
                </Button>

                <Button size="sm" loading={busy === "address"} onClick={() => void saveAddress()}>
                  Save address
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        {/* COVERAGE */}
        <section style={card}>
          <div style={cardHeader}>
            <div>
              <h4 style={cardTitle}>Coverage / Payers</h4>

              <p style={cardDescription}>Add insurance coverage when it is known during intake.</p>
            </div>

            <Button
              size="sm"
              tone="secondary"
              onClick={() => {
                setCoverageError(null);
                setCoverageOpen((value) => !value);
              }}
            >
              Add coverage
            </Button>
          </div>

          {currentPayers.length > 0 ? (
            <div style={payerList}>
              {currentPayers.map((payer) => (
                <div key={payer.id} style={payerRow}>
                  <div style={payerMain}>
                    <strong>
                      {payerNames[payer.payerId] ?? `Payer ${shortId(payer.payerId)}`}
                    </strong>

                    <span style={muted}>
                      {humanize(payer.coverageKind)}
                      {" · "}
                      Member {maskIdentifier(payer.subscriberId)}
                    </span>
                  </div>

                  <StatusPill
                    label={payer.rank === 1 ? "Primary" : `Rank ${payer.rank}`}
                    tone={payer.rank === 1 ? "success" : "neutral"}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div style={emptyBox}>
              <strong>No coverage on file.</strong>
              <span>This does not block referral or admission progress.</span>
            </div>
          )}

          {coverageOpen ? (
            <div style={form}>
              <MdmEntityLookupField
                kind="payer"
                label="Payer"
                value={coverage.payerId}
                onChange={(payerId) =>
                  setCoverage((current) => ({
                    ...current,
                    payerId,
                  }))
                }
                required
              />

              <div style={twoColumns}>
                <label style={field}>
                  <span style={label}>Coverage kind</span>

                  <select
                    value={coverage.coverageKind}
                    onChange={(event) =>
                      setCoverage((current) => ({
                        ...current,
                        coverageKind: event.target.value,
                      }))
                    }
                    style={input}
                  >
                    <option value="">Select coverage kind</option>
                    <option value="medicare_ffs">Medicare fee-for-service</option>
                    <option value="medicare_advantage">Medicare Advantage</option>
                    <option value="medicaid">Medicaid</option>
                    <option value="commercial">Commercial</option>
                    <option value="hospice_carve_out">Hospice carve-out</option>
                    <option value="self_pay">Self-pay</option>
                  </select>
                </label>

                <label style={field}>
                  <span style={label}>Rank</span>

                  <input
                    type="number"
                    min={1}
                    value={coverage.rank}
                    onChange={(event) =>
                      setCoverage((current) => ({
                        ...current,
                        rank: event.target.value,
                      }))
                    }
                    style={input}
                  />

                  <span style={fieldHint}>1 = primary</span>
                </label>
              </div>

              <label style={field}>
                <span style={label}>Member / subscriber ID</span>

                <input
                  value={coverage.subscriberId}
                  onChange={(event) =>
                    setCoverage((current) => ({
                      ...current,
                      subscriberId: event.target.value,
                    }))
                  }
                  autoComplete="off"
                  style={input}
                />
              </label>

              <div style={twoColumns}>
                <label style={field}>
                  <span style={label}>Group number</span>

                  <input
                    value={coverage.groupNumber}
                    onChange={(event) =>
                      setCoverage((current) => ({
                        ...current,
                        groupNumber: event.target.value,
                      }))
                    }
                    style={input}
                  />
                </label>

                <label style={field}>
                  <span style={label}>BIN / PCN</span>

                  <input
                    value={coverage.binPcn}
                    onChange={(event) =>
                      setCoverage((current) => ({
                        ...current,
                        binPcn: event.target.value,
                      }))
                    }
                    style={input}
                  />
                </label>
              </div>

              <label style={field}>
                <span style={label}>Effective from</span>

                <input
                  type="date"
                  value={coverage.effectiveFrom}
                  onChange={(event) =>
                    setCoverage((current) => ({
                      ...current,
                      effectiveFrom: event.target.value,
                    }))
                  }
                  style={input}
                />
              </label>

              {coverageError ? (
                <p role="alert" style={errorText}>
                  {coverageError}
                </p>
              ) : null}

              <div style={actions}>
                <Button
                  size="sm"
                  tone="tertiary"
                  disabled={busy === "coverage"}
                  onClick={() => {
                    setCoverageOpen(false);
                    setCoverageError(null);
                  }}
                >
                  Cancel
                </Button>

                <Button size="sm" loading={busy === "coverage"} onClick={() => void saveCoverage()}>
                  Save coverage
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function apiErrorMessage(error: unknown, fallback: string): string {
  const body = error as {
    message?: string;
    detail?: string;
    error?: {
      message?: string;
      detail?: string;
    };
  } | null;

  return body?.detail ?? body?.message ?? body?.error?.detail ?? body?.error?.message ?? fallback;
}

function maskIdentifier(value: string): string {
  const normalized = value.trim();

  if (!normalized) return "—";

  if (["^", "+", "N"].includes(normalized)) {
    return normalized;
  }

  if (normalized.length <= 4) {
    return normalized;
  }

  return `••••${normalized.slice(-4)}`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function shortId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

const shell: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const header: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
};

const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1rem",
  fontWeight: 600,
  color: t.onSurface,
};

const description: CSSProperties = {
  margin: "0.25rem 0 0",
  maxWidth: "44rem",
  color: t.onSurfaceVariant,
  fontSize: "0.8rem",
  lineHeight: 1.45,
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
  gap: "1rem",
};

const card: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  background: t.surfaceLowest,
  padding: "1rem",
};

const cardHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const cardTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontSize: "0.9rem",
  fontWeight: 650,
};

const cardDescription: CSSProperties = {
  margin: "0.2rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.74rem",
  lineHeight: 1.4,
};

const summaryBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  marginTop: "0.9rem",
  padding: "0.75rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.8rem",
};

const emptyBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  marginTop: "0.9rem",
  padding: "0.75rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurfaceVariant,
  fontSize: "0.78rem",
};

const form: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.8rem",
  marginTop: "1rem",
  paddingTop: "1rem",
  borderTop: `1px solid ${t.outlineVariant}`,
};

const field: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
};

const label: CSSProperties = {
  color: t.onSurfaceVariant,
  fontSize: "0.74rem",
  fontWeight: 650,
};

const fieldHint: CSSProperties = {
  color: t.muted,
  fontSize: "0.68rem",
};

const input: CSSProperties = {
  width: "100%",
  minHeight: "2.4rem",
  boxSizing: "border-box",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  padding: "0.45rem 0.6rem",
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.84rem",
};

const twoColumns: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "0.75rem",
};

const threeColumns: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2fr 0.7fr 1.2fr",
  gap: "0.75rem",
};

const payerList: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
  marginTop: "0.9rem",
};

const payerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.7rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
};

const payerMain: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  minWidth: 0,
  color: t.onSurface,
  fontSize: "0.8rem",
};

const muted: CSSProperties = {
  color: t.onSurfaceVariant,
  fontSize: "0.72rem",
};

const errorText: CSSProperties = {
  margin: 0,
  color: t.error,
  fontSize: "0.75rem",
};

const actions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};

const loadingBox: CSSProperties = {
  minHeight: "5rem",
  display: "grid",
  placeItems: "center",
};
