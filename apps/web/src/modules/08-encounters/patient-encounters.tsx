import {
  Button,
  DataTable,
  EmptyState,
  LoadingSpinner,
  Modal,
  PatientBanner,
  PatientWorkspaceLayout,
  RightDetailPanel,
  StatusPill,
  ageYears,
  t,
  useApiClient,
} from "@chartwarden/ui";

import type { DataTableColumn } from "@chartwarden/ui";

// apps/web/src/modules/08-encounters — patient encounters / visits (M8 §5.2, Track B / ADR-0030).

// Spec: docs/design/screens/clinical/WARDENX_UI_ENCOUNTERS.md — "Use Patient Workspace."

// The per-patient list reached from the patient chart "Encounters / Visits" tab: a Patient Workspace

// (banner + shared module rail) over an encounters table | a right rail with the selected encounter's

// discipline, service date, and §2.2 lifecycle status. The server owns the authoritative status

// (ADR-0030, no frontend authz). Reads GET /api/v1/encounters?patientId (+ the patient summary for the

// banner). Rows label by encounter TYPE + discipline, never fabricated note text — the note body lives

// on the encounter read (/patients/:id/encounters/:encounterId).

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CSSProperties, JSX, ReactNode } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { AdmissionLookupField } from "../../shell/entity-lookups";

import { useSession } from "../../shell/session";

import { ChartModuleRail } from "../../shell/chart-module-rail";

import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import {
  type EncounterDiscipline,
  type EncounterType,
  disciplinesForRoles,
  encounterTypesForDisciplines,
  legalDisciplinesFor,
} from "./encounters-api";

interface EncounterRow {
  id: string;

  patientId: string;

  encounterType: string;

  discipline: string;

  serviceDate: string;

  status: string;

  isF2f: boolean;

  signedAt: string | null;

  cosignedAt: string | null;
}

interface PatientSummary {
  mrn: string;

  lastName: string;

  firstName: string;

  dob: string;

  status: string;
}

type EncounterCreateField = "admissionId" | "encounterType" | "discipline" | "serviceDate";

type EncounterCreateFieldErrors = Partial<Record<EncounterCreateField, string>>;

function validationDetails(error: unknown): Array<{ field?: string; message?: string }> {
  const body = error as {
    details?: unknown;
    error?: {
      details?: unknown;
    };
  } | null;

  const raw = body?.error?.details ?? body?.details;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((detail) => {
    if (typeof detail !== "object" || detail === null) return [];
    const row = detail as { field?: unknown; message?: unknown };
    return [
      {
        field: typeof row.field === "string" ? row.field : undefined,
        message: typeof row.message === "string" ? row.message : undefined,
      },
    ];
  });
}

function createFieldFromPath(path: string | undefined): EncounterCreateField | null {
  if (!path) return null;

  const normalized = path
    .replace(/^body\./, "")
    .replace(/^data\./, "")
    .split(".")
    .at(-1);

  if (
    normalized === "admissionId" ||
    normalized === "encounterType" ||
    normalized === "discipline" ||
    normalized === "serviceDate"
  ) {
    return normalized;
  }

  return null;
}

function createFieldErrors(error: unknown): EncounterCreateFieldErrors {
  const result: EncounterCreateFieldErrors = {};

  for (const detail of validationDetails(error)) {
    const field = createFieldFromPath(detail.field);
    if (field && detail.message && !result[field]) {
      result[field] = detail.message;
    }
  }

  return result;
}

function createErrorMessage(error: unknown, fallback: string): string {
  const body = error as {
    message?: string;
    title?: string;
    detail?: string;
    error?: {
      message?: string;
      title?: string;
      detail?: string;
    };
  } | null;

  return (
    body?.error?.detail ??
    body?.error?.message ??
    body?.error?.title ??
    body?.detail ??
    body?.message ??
    body?.title ??
    fallback
  );
}

function FieldError({ message }: { message?: string }): JSX.Element | null {
  if (!message) return null;

  return (
    <span role="alert" style={fieldErrorStyle}>
      {message}
    </span>
  );
}

export function PatientEncounters(): JSX.Element {
  const client = useApiClient();

  const navigate = useNavigate();

  const session = useSession();

  const { patientId } = useParams<{ patientId: string }>();

  const [items, setItems] = useState<EncounterRow[]>([]);

  const [patient, setPatient] = useState<PatientSummary | null>(null);

  const [status, setStatus] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const [prnOpen, setPrnOpen] = useState(false);

  const load = useCallback(async () => {
    if (!patientId) return;

    setLoading(true);

    setError(null);

    const [eRes, pRes] = await Promise.all([
      client.GET("/api/v1/encounters", { params: { query: { patientId } } }),

      client.GET("/api/v1/patients/{id}", {
        params: { path: { id: patientId } },
      }),
    ]);

    if (pRes.data) setPatient(pRes.data as PatientSummary);

    if (eRes.error) {
      setError("Could not load encounters for this patient.");

      setLoading(false);

      return;
    }

    setItems((eRes.data?.encounters ?? []) as EncounterRow[]);

    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const visible = status ? items.filter((e) => e.status === status) : items;

    return [...visible].sort((a, b) => Date.parse(b.serviceDate) - Date.parse(a.serviceDate));
  }, [items, status]);

  const selected = items.find((e) => e.id === selectedId) ?? null;

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>

          <StatusPill
            label={stateLabel(patient.status)}
            tone={ENCOUNTER_TONE[patient.status] ?? "neutral"}
          />
        </>
      }
    />
  ) : (
    <PatientBanner name="Encounters" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="encounters" />

        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <h1
              style={{
                margin: 0,
                fontFamily: t.fontDisplay,
                fontWeight: 500,
                fontSize: "1.375rem",
                color: t.onSurface,
              }}
            >
              Encounters / Visits
            </h1>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <label className="wx-filter-field">
                <span>Status</span>
                <select
                  className="wx-select"
                  aria-label="Encounter status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All</option>
                  <option value="draft">Draft</option>
                  <option value="finalized">Finalized</option>
                  <option value="signed">Signed</option>
                  <option value="cosign_pending">Cosign Pending</option>
                  <option value="cosigned">Cosigned</option>
                  <option value="voided">Voided</option>
                </select>
              </label>

              {status ? (
                <Button size="sm" tone="tertiary" onClick={() => setStatus("")}>
                  Clear
                </Button>
              ) : null}

              {session?.permissions?.includes("encounter.author") ? (
                <Button size="sm" onClick={() => setPrnOpen(true)}>
                  New Encounter
                </Button>
              ) : null}
            </div>
          </div>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && items.length === 0 ? (
            <LoadingSpinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No encounters"
              description="No encounters match the current filter."
            />
          ) : (
            <div style={{ width: "100%", overflowX: "auto" }}>
              <DataTable
                ariaLabel="Patient encounters"
                caption="Encounters recorded for the selected patient"
                rows={rows}
                columns={ENCOUNTER_COLUMNS}
                getRowId={(encounter) => encounter.id}
                selectedRowId={selectedId}
                onRowSelect={(encounter) => setSelectedId(encounter.id)}
              />
            </div>
          )}
        </div>

        <RightDetailPanel
          title={selected ? stateLabel(selected.encounterType) : "Encounter detail"}
        >
          {selected ? (
            <>
              <dl style={detailGrid}>
                <dt style={dt}>Status</dt>

                <dd style={dd}>
                  <StatusPill
                    label={stateLabel(selected.status)}
                    tone={ENCOUNTER_TONE[selected.status] ?? "neutral"}
                  />
                </dd>

                <dt style={dt}>Discipline</dt>

                <dd style={dd}>{stateLabel(selected.discipline)}</dd>

                <dt style={dt}>Service date</dt>

                <dd style={dd} className="tabular-nums">
                  {selected.serviceDate.slice(0, 10)}
                </dd>

                <dt style={dt}>Face-to-face</dt>

                <dd style={dd}>{selected.isF2f ? "Yes" : "No"}</dd>

                {selected.signedAt ? (
                  <>
                    <dt style={dt}>Signed</dt>

                    <dd style={dd} className="tabular-nums">
                      {selected.signedAt.slice(0, 16).replace("T", " ")}
                    </dd>
                  </>
                ) : null}
              </dl>

              <Button
                type="button"
                onClick={() => navigate(`/patients/${patientId}/encounters/${selected.id}`)}
                style={{ marginTop: "1rem", width: "100%" }}
              >
                Open encounter
              </Button>
              {/* #91 — a draft has somewhere to be finished: the HearthNote composer (template menu +
                  per-section free text). Offered only on `draft`, because the composer's writes are
                  refused on any other status by `checkMutableForEdit`. */}
              {selected.status === "draft" && session?.permissions?.includes("encounter.author") ? (
                <Button
                  type="button"
                  tone="secondary"
                  onClick={() =>
                    navigate(`/patients/${patientId}/encounters/${selected.id}/compose`)
                  }
                  style={{ marginTop: "0.5rem", width: "100%" }}
                >
                  Compose note
                </Button>
              ) : null}
            </>
          ) : (
            <p style={meta}>
              Select an encounter to see its discipline, service date, and lifecycle status here.
            </p>
          )}
        </RightDetailPanel>
      </div>

      <PrnEncounterModal
        open={prnOpen}
        patientId={patientId ?? ""}
        onClose={() => setPrnOpen(false)}
        onCreated={(id) => {
          setPrnOpen(false);

          navigate(`/patients/${patientId}/encounters/${id}`);
        }}
      />
    </PatientWorkspaceLayout>
  );
}

/** Every authoring discipline — the fallback when the caller's role keys name none (e.g. an administrator). */
const ALL_DISCIPLINES: readonly EncounterDiscipline[] = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  "md",
  "np",
  "pt",
  "ot",
  "slp",
];

function PrnEncounterModal({
  open,
  patientId,
  onClose,
  onCreated,
}: {
  open: boolean;
  patientId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const [admissionId, setAdmissionId] = useState("");
  const [encounterType, setEncounterType] = useState<string>("routine_visit");
  const [discipline, setDiscipline] = useState<string>("rn");
  // F-083 (#195) — offer only (type × discipline) pairs the server accepts (`ENCOUNTER_DISCIPLINE_RULES`,
  // a 422 otherwise, and no HearthNote template exists for an illegal pair), narrowed to the caller's own
  // clinical disciplines when their role keys name any. Not a check — the server decides.
  const roleDisciplines = useMemo(
    () => disciplinesForRoles(session?.roles ?? []),
    [session?.roles],
  );
  const typeOptions = useMemo(
    () =>
      encounterTypesForDisciplines(roleDisciplines.length > 0 ? roleDisciplines : ALL_DISCIPLINES),
    [roleDisciplines],
  );
  const disciplineOptions = useMemo(
    () =>
      legalDisciplinesFor(encounterType as EncounterType).filter(
        (d) => roleDisciplines.length === 0 || roleDisciplines.includes(d),
      ),
    [encounterType, roleDisciplines],
  );
  useEffect(() => {
    if (!typeOptions.includes(encounterType as EncounterType) && typeOptions[0]) {
      setEncounterType(typeOptions[0]);
    }
  }, [typeOptions, encounterType]);
  useEffect(() => {
    if (!disciplineOptions.includes(discipline as EncounterDiscipline)) {
      setDiscipline(disciplineOptions[0] ?? "");
    }
  }, [disciplineOptions, discipline]);
  const [serviceDate, setServiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<EncounterCreateFieldErrors>({});

  if (!open) return null;

  function clearFieldError(field: EncounterCreateField): void {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function validate(): boolean {
    const next: EncounterCreateFieldErrors = {};

    if (!admissionId.trim()) {
      next.admissionId = "Select the active admission for this encounter.";
    }

    if (!encounterType.trim()) {
      next.encounterType = "Select an encounter type.";
    }

    if (!discipline.trim()) {
      next.discipline = "Select a discipline.";
    }

    if (!serviceDate.trim()) {
      next.serviceDate = "Service date is required.";
    }

    setFieldErrors(next);
    setFormError(null);

    return Object.keys(next).length === 0;
  }

  async function submit(): Promise<void> {
    if (!validate()) return;

    setBusy(true);
    setFormError(null);
    setFieldErrors({});

    const { data, error: err } = await client.POST("/api/v1/encounters", {
      body: {
        patientId,
        admissionId,
        encounterType,
        discipline,
        serviceDate,
      },
    } as never);

    setBusy(false);

    if (err || !data) {
      const mapped = createFieldErrors(err);

      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        setFormError(null);
      } else {
        setFormError(
          createErrorMessage(
            err,
            "The encounter could not be created. Review the information and try again.",
          ),
        );
      }

      return;
    }

    onCreated((data as { id: string }).id);
  }

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} ariaLabel="New Encounter" width="34rem">
      <div
        style={{
          padding: "1.25rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontFamily: t.fontDisplay, fontWeight: 500 }}>New Encounter</h2>
          <p style={modalHint}>
            Start an unscheduled encounter for the selected patient. Choose the active admission,
            visit type, discipline, and service date.
          </p>
        </div>

        {formError ? (
          <div role="alert" style={formErrorStyle}>
            <strong>Encounter could not be created.</strong>
            <span>{formError}</span>
          </div>
        ) : null}

        <div style={modalField}>
          <AdmissionLookupField
            label="Active admission"
            patientId={patientId}
            state="active"
            value={admissionId}
            onChange={(value) => {
              setAdmissionId(value);
              clearFieldError("admissionId");
            }}
            required
          />
          <FieldError message={fieldErrors.admissionId} />
        </div>

        <label style={modalField}>
          <span style={modalLabel}>Encounter type</span>
          <select
            value={encounterType}
            onChange={(event) => {
              setEncounterType(event.target.value);
              clearFieldError("encounterType");
            }}
            style={{
              ...selectStyle,
              ...(fieldErrors.encounterType ? fieldControlErrorStyle : null),
            }}
            aria-invalid={Boolean(fieldErrors.encounterType)}
          >
            {typeOptions.map((value) => (
              <option key={value} value={value}>
                {stateLabel(value)}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.encounterType} />
        </label>

        <label style={modalField}>
          <span style={modalLabel}>Discipline</span>
          <select
            value={discipline}
            onChange={(event) => {
              setDiscipline(event.target.value);
              clearFieldError("discipline");
            }}
            style={{
              ...selectStyle,
              ...(fieldErrors.discipline ? fieldControlErrorStyle : null),
            }}
            aria-invalid={Boolean(fieldErrors.discipline)}
          >
            {disciplineOptions.map((value) => (
              <option key={value} value={value}>
                {stateLabel(value)}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.discipline} />
        </label>

        <label style={modalField}>
          <span style={modalLabel}>Service date</span>
          <input
            type="date"
            value={serviceDate}
            onChange={(event) => {
              setServiceDate(event.target.value);
              clearFieldError("serviceDate");
            }}
            style={{
              ...selectStyle,
              ...(fieldErrors.serviceDate ? fieldControlErrorStyle : null),
            }}
            aria-invalid={Boolean(fieldErrors.serviceDate)}
          />
          <FieldError message={fieldErrors.serviceDate} />
        </label>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
            paddingTop: "0.25rem",
          }}
        >
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Create Encounter
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: t.fontMono,

        fontSize: "0.78rem",

        color: t.onSurfaceVariant,

        background: t.surfaceContainer,

        borderRadius: "9999px",

        padding: "0.15rem 0.55rem",
      }}
    >
      {children}
    </span>
  );
}

const f2fBadge: CSSProperties = {
  background: t.primaryTint,

  color: t.primary,

  borderRadius: "9999px",

  padding: "0.05rem 0.45rem",

  fontSize: "0.72rem",

  fontWeight: 600,
};

const selectStyle: CSSProperties = {
  minHeight: "2.25rem",

  padding: "0.4rem 0.6rem",

  borderRadius: t.radiusMd,

  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 60%, transparent)",

  background: t.surfaceLow,

  color: t.onSurface,

  fontSize: "0.85rem",
};

const detailGrid: CSSProperties = {
  display: "grid",

  gridTemplateColumns: "auto 1fr",

  alignItems: "center",

  gap: "0.5rem 1rem",

  margin: 0,

  fontSize: "0.8rem",
};

const dt: CSSProperties = { fontWeight: 600, color: t.onSurfaceVariant };

const dd: CSSProperties = { margin: 0, color: t.onSurface };

const meta: CSSProperties = {
  fontSize: "0.78rem",

  color: t.onSurfaceVariant,

  margin: "0.25rem 0 0",
};

const modalField: CSSProperties = {
  display: "flex",

  flexDirection: "column",

  gap: "0.35rem",
};

const modalLabel: CSSProperties = {
  fontSize: "0.8125rem",

  fontWeight: 650,

  color: t.onSurface,
};

const modalHint: CSSProperties = {
  margin: "0.3rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.78rem",
  lineHeight: 1.45,
};

const formErrorStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  padding: "0.7rem 0.8rem",
  borderRadius: t.radiusMd,
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  color: t.error,
  fontSize: "0.78rem",
  lineHeight: 1.4,
};

const fieldErrorStyle: CSSProperties = {
  color: t.error,
  fontSize: "0.72rem",
  lineHeight: 1.35,
};

const fieldControlErrorStyle: CSSProperties = {
  borderColor: t.error,
};

const ENCOUNTER_COLUMNS: readonly DataTableColumn<EncounterRow>[] = [
  {
    id: "encounter",

    header: "Encounter",

    cell: (encounter) => (
      <span style={{ display: "grid", gap: "0.2rem" }}>
        <span style={{ color: t.onSurface, fontWeight: 600 }}>
          {stateLabel(encounter.encounterType)}
        </span>

        <span className="tabular-nums" style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
          {encounter.serviceDate.slice(0, 10)}
        </span>
      </span>
    ),
  },

  {
    id: "discipline",

    header: "Discipline",

    priority: "secondary",

    cell: (encounter) => stateLabel(encounter.discipline),
  },

  {
    id: "status",

    header: "Status",

    cell: (encounter) => (
      <StatusPill
        label={stateLabel(encounter.status)}
        tone={ENCOUNTER_TONE[encounter.status] ?? "neutral"}
      />
    ),
  },

  {
    id: "f2f",

    header: "F2F",

    priority: "tertiary",

    cell: (encounter) =>
      encounter.isF2f ? (
        <span style={f2fBadge}>F2F</span>
      ) : (
        <span style={{ color: t.muted }}>—</span>
      ),
  },
];
