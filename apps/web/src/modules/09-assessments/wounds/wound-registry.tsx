// apps/web/src/modules/09-assessments/wounds — the patient's WOUNDS (M9 Assessments, longitudinal; route
// /patients/:patientId/wounds).
//
// A wound is registered once and observed at every visit after: each observation is dated, carries the descriptors the
// clinician recorded, and the visit note states the observations made at its encounter. This screen is the register
// of the patient's wounds — site, cause, stage, the latest measurement, when it was last observed and which way it is
// going — with a right-hand drawer for the selected wound (history, record, correct, close). The list defaults to the
// open wounds. The server scopes every read and write; nothing here decides who may do what.
//
// Wound sites and notes are PHI-adjacent: neither goes into a URL or a log. The route carries the patient id only.
import {
  Button,
  DataTable,
  type DataTableColumn,
  DeniedState,
  Drawer,
  EmptyState,
  ErrorState,
  Glyph,
  LoadingSpinner,
  PatientWorkspaceLayout,
  SelectField,
  StatusPill,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import { type JSX, useState } from "react";
import { useParams } from "react-router-dom";
import { ChartModuleRail } from "../../../shell/chart-module-rail";
import {
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../../shell/patient-context";
import { WoundDrawer } from "./wound-drawer";
import { STATUS_TONE, TREND_TONE, measurementWithArea, shortDate } from "./wound-format";
import {
  ETIOLOGY_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  TREND_LABELS,
  siteHeading,
} from "./wound-labels";
import { WoundRegisterForm } from "./wound-register-form";
import {
  WOUND_ERROR_COPY,
  type WoundListItem,
  type WoundListResponse,
  type WoundStatusFilter,
  fetchWounds,
} from "./wounds-api";

const FILTER_OPTIONS: readonly { value: WoundStatusFilter; label: string }[] = [
  { value: "open", label: "Open wounds" },
  { value: "healed", label: "Healed" },
  { value: "resolved_other", label: "Resolved (another reason)" },
  { value: "all", label: "All wounds" },
];

const COLUMNS: readonly DataTableColumn<WoundListItem>[] = [
  {
    id: "site",
    header: "Site",
    cell: (w) => (
      <>
        <span className="wx-row-title">{siteHeading(w.siteCode, w.laterality)}</span>
        {w.onsetOn ? <span className="wx-row-sub">Since {shortDate(w.onsetOn)}</span> : null}
      </>
    ),
  },
  {
    id: "cause",
    header: "Cause and stage",
    cell: (w) => (
      <>
        {ETIOLOGY_LABELS[w.etiology]}
        {w.latestObservation?.stage ? (
          <span className="wx-row-sub">{STAGE_LABELS[w.latestObservation.stage]}</span>
        ) : null}
      </>
    ),
  },
  {
    id: "size",
    header: "Latest measurement",
    cell: (w) =>
      w.latestObservation === null
        ? "—"
        : (measurementWithArea(w.latestObservation) ?? "Not measured"),
  },
  {
    id: "observed",
    header: "Last observed",
    priority: "secondary",
    cell: (w) =>
      w.latestObservation === null ? "Not yet observed" : shortDate(w.latestObservation.observedAt),
  },
  {
    id: "trend",
    header: "Trend",
    priority: "secondary",
    cell: (w) =>
      w.latestObservation?.trend ? (
        <StatusPill
          label={TREND_LABELS[w.latestObservation.trend]}
          tone={TREND_TONE[w.latestObservation.trend]}
        />
      ) : (
        "—"
      ),
  },
  {
    id: "status",
    header: "Status",
    priority: "tertiary",
    cell: (w) => <StatusPill label={STATUS_LABELS[w.status]} tone={STATUS_TONE[w.status]} />,
  },
];

export function WoundRegistry(): JSX.Element {
  const client = useApiClient();
  const { patientId = "" } = useParams<{ patientId: string }>();
  const [status, setStatus] = useState<WoundStatusFilter>("open");
  const [selected, setSelected] = useState<WoundListItem | null>(null);
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);

  const wounds = useLoad<WoundListResponse>(
    `${patientId}:${status}`,
    () => fetchWounds(client, patientId, status),
    WOUND_ERROR_COPY,
  );
  const identity = useChartIdentity(patientId);
  const rows = wounds.data?.wounds ?? [];

  function select(wound: WoundListItem): void {
    if (busy) return;
    setRegistering(false);
    setSelected(wound);
  }
  function startRegistering(): void {
    if (busy) return;
    setSelected(null);
    setRegistering(true);
  }
  /** A new wound is open and has no observations yet: show it, selected, so the first observation is one click away. */
  function registered(wound: WoundListItem): void {
    setRegistering(false);
    setStatus("open");
    setSelected(wound);
    void wounds.reload(true);
  }

  const drawer = registering ? (
    <Drawer
      title="Register a wound"
      label="Register a wound"
      icon="plus"
      closeDisabled={busy}
      onClose={() => (busy ? undefined : setRegistering(false))}
    >
      <WoundRegisterForm
        patientId={patientId}
        onRegistered={(wound) => registered({ ...wound, latestObservation: null })}
        onCancel={() => setRegistering(false)}
        onBusyChange={setBusy}
      />
    </Drawer>
  ) : selected ? (
    <WoundDrawer
      key={selected.id}
      patientId={patientId}
      summary={selected}
      onClose={() => setSelected(null)}
      onChanged={() => void wounds.reload(true)}
      onBusyChange={setBusy}
    />
  ) : null;

  const failureKind = wounds.failure?.kind;
  // "Open" and "All" are the whole register as far as they go: an empty one means no wound, and registering one is the way forward.
  const filtered = status === "healed" || status === "resolved_other";

  return (
    <PatientWorkspaceLayout
      banner={<ChartPatientBanner patientId={patientId} identity={identity} />}
      rail={<PatientSummaryPanel identity={identity} />}
    >
      <div>
        <ChartModuleRail patientId={patientId} current="wounds" />
        <div className={`wx-list-drawer${drawer ? " has-drawer" : ""}`}>
          <section className="wx-list-drawer-main" aria-labelledby="wounds-title">
            <header className="wx-page-head">
              <div>
                <h1 id="wounds-title">Wounds</h1>
                <p>
                  Each wound is registered once and observed at every visit. The visit note states
                  what was recorded at its encounter.
                </p>
              </div>
              <Button disabled={busy} onClick={startRegistering}>
                <Glyph name="plus" size={16} /> Register wound
              </Button>
            </header>

            <div className="wx-list-toolbar wx-list-toolbar-fields">
              <SelectField
                label="Show"
                value={status}
                options={FILTER_OPTIONS}
                disabled={busy}
                onChange={(event) => setStatus(event.target.value as WoundStatusFilter)}
              />
            </div>

            {wounds.failure ? (
              failureKind === "forbidden" ? (
                <DeniedState subject="this patient's wounds" />
              ) : (
                <ErrorState
                  title="Wounds unavailable"
                  description={wounds.failure.message}
                  onRetry={() => void wounds.reload()}
                />
              )
            ) : wounds.loading && wounds.data === null ? (
              <LoadingSpinner label="Loading wounds" />
            ) : rows.length === 0 ? (
              <EmptyState
                title={filtered ? "No wounds match" : "No wounds recorded"}
                description={
                  filtered
                    ? "No wound of this patient has that status."
                    : status === "all"
                      ? "This patient has no wound on record. Register one when a wound is found."
                      : "This patient has no open wound. Register one when a wound is found."
                }
                action={
                  filtered ? undefined : (
                    <Button tone="secondary" disabled={busy} onClick={startRegistering}>
                      Register wound
                    </Button>
                  )
                }
              />
            ) : (
              <DataTable
                rows={rows}
                columns={COLUMNS}
                getRowId={(w) => w.id}
                selectedRowId={selected?.id ?? null}
                onRowSelect={select}
                ariaLabel="Wounds"
              />
            )}
          </section>
          {drawer}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}
