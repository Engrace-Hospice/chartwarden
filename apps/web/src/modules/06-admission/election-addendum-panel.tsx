// apps/web/src/modules/06-admission/election-addendum-panel.tsx — the Election Statement Addendum section of
// the patient Election & Certification view (FY2027, 42 CFR 418.24(b)(6), (c), (d)): "Patient Notification of
// Hospice Non-Covered Items, Services, and Drugs", mandatory for elections effective on/after 2026-10-01.
//
// One flat clinical section (no boxes inside boxes): status + due countdown in the header, label/value rows,
// the current non-covered list, and the version history table. Selecting a version opens the right-hand drawer
// (election-addendum-drawer.tsx, the admissions-drawer pattern) where it is edited, furnished, or acknowledged.
// Shows only what the M6 read returns; the server owns every rule (ADR-0030).
import {
  Button,
  DataTable,
  EmptyState,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import {
  type AddendumOverview,
  type AddendumVersion,
  type ElectionAddendumApi,
  createElectionAddendumApi,
} from "./election-addendum-api";
import {
  type AddendumPermissions,
  ElectionAddendumDrawer,
  NonCoveredList,
} from "./election-addendum-drawer";
import {
  ADDENDUM_STATUS_LABEL,
  ADDENDUM_STATUS_TONE,
  ADDENDUM_WINDOW_LABEL,
  acknowledgementLabel,
  countdownLabel,
  countdownTone,
  nextDue,
  usDate,
} from "./election-addendum-format";

export function ElectionAddendumPanel({
  admissionId,
  api: injected,
}: {
  admissionId: string;
  /** Test seam; production builds the typed client API. */
  api?: ElectionAddendumApi;
}): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const api = useMemo(() => injected ?? createElectionAddendumApi(client), [injected, client]);
  const perms = session?.permissions;
  const can: AddendumPermissions = {
    write: !perms || perms.includes("election_addendum.write"),
    acknowledge: !perms || perms.includes("election_addendum.acknowledge"),
  };

  const [ov, setOv] = useState<AddendumOverview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  const load = useCallback(async () => {
    try {
      setOv(await api.overview(admissionId));
      setError(null);
    } catch (e) {
      setOv(null);
      setError(e instanceof Error ? e.message : "Could not load the election addendum.");
    }
  }, [api, admissionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = async (): Promise<void> => {
    setDrafting(true);
    try {
      const next = await api.draft(admissionId);
      setOv(next);
      setSelectedId(next.current?.id ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not draft the addendum.");
    } finally {
      setDrafting(false);
    }
  };

  const current = ov?.current ?? null;
  const due = ov ? nextDue(ov) : null;
  const selected = ov?.history.find((v) => v.id === selectedId) ?? null;

  const header = (
    <header>
      <span className="wx-clinical-section-icon" aria-hidden>
        <Glyph name="file-check" size={22} strokeWidth={1.6} />
      </span>
      <div className="wx-addendum-head-text">
        <h3>Election Statement Addendum</h3>
        <p>Patient Notification of Hospice Non-Covered Items, Services, and Drugs</p>
      </div>
      <div className="wx-clinical-section-aside">
        {current ? (
          <StatusPill
            label={ADDENDUM_STATUS_LABEL[current.status]}
            tone={ADDENDUM_STATUS_TONE[current.status]}
          />
        ) : null}
        {due ? (
          <StatusPill label={countdownLabel(due.dueAt)} tone={countdownTone(due.dueAt)} />
        ) : null}
      </div>
    </header>
  );

  let body: JSX.Element;
  if (ov === undefined) {
    body = <LoadingSpinner />;
  } else if (ov === null) {
    body = (
      <InlineAlert tone="error">{error ?? "Could not load the election addendum."}</InlineAlert>
    );
  } else if (!ov.required && ov.history.length === 0) {
    body = (
      <p className="wx-row-sub">
        Not mandatory: this election
        {ov.electionEffectiveDate ? ` took effect ${usDate(ov.electionEffectiveDate)},` : " is"}{" "}
        before October 1, 2026 (42 CFR 418.24(b)(6)).
      </p>
    );
  } else {
    body = (
      <div className="wx-addendum-body">
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <dl className="wx-kv">
          <dt>Election effective</dt>
          <dd className="wx-nums">{usDate(ov.electionEffectiveDate)}</dd>
          <dt>Open window</dt>
          <dd>
            {due
              ? `${ADDENDUM_WINDOW_LABEL[due.kind] ?? due.kind} — due ${usDate(due.dueAt)}`
              : "None"}
          </dd>
          <dt>Current version</dt>
          <dd>{current ? `Version ${current.versionNumber}` : "Not drafted"}</dd>
          {current && acknowledgementLabel(current) ? (
            <>
              <dt>Acknowledgement</dt>
              <dd>{acknowledgementLabel(current)}</dd>
            </>
          ) : null}
        </dl>

        {current ? (
          <div className="wx-addendum-group">
            <h4 className="wx-addendum-subhead">Not covered by the hospice</h4>
            {current.contentSource === "scanned_paper" ? (
              <p className="wx-row-sub">
                On the signed paper copy — open version {current.versionNumber} for the scan.
              </p>
            ) : current.noNonCoveredItems ? (
              <p className="wx-row-sub">
                All conditions, items, services, and drugs are related and covered.
              </p>
            ) : current.items.length > 0 ? (
              <NonCoveredList items={current.items} />
            ) : (
              <p className="wx-row-sub">No non-covered items recorded yet.</p>
            )}
          </div>
        ) : (
          <EmptyState
            title="No addendum yet"
            description="Draft it from the plan of care. It must be furnished within 5 calendar days of the election's effective date."
          />
        )}

        <div className="wx-action-row">
          {can.write && ov.inCare && ov.required ? (
            <Button
              tone={current ? "secondary" : "primary"}
              loading={drafting}
              onClick={() => void draft()}
            >
              {!current
                ? "Draft addendum"
                : current.status === "draft"
                  ? "Refresh from plan of care"
                  : "Start update"}
            </Button>
          ) : null}
          {current ? (
            <Button tone="tertiary" onClick={() => setSelectedId(current.id)}>
              Open version {current.versionNumber}
            </Button>
          ) : null}
        </div>

        {ov.history.length > 0 ? (
          <DataTable<AddendumVersion>
            ariaLabel="Addendum versions"
            rows={ov.history}
            getRowId={(v) => v.id}
            selectedRowId={selectedId}
            onRowSelect={(v) => setSelectedId(v.id)}
            columns={[
              {
                id: "v",
                header: "Version",
                cell: (v) => `v${v.versionNumber}`,
                priority: "primary",
              },
              {
                id: "trigger",
                header: "Reason",
                cell: (v) => (v.trigger === "initial" ? "Initial" : "Plan of care update"),
                priority: "secondary",
              },
              {
                id: "status",
                header: "Status",
                cell: (v) => (
                  <StatusPill
                    label={ADDENDUM_STATUS_LABEL[v.status]}
                    tone={ADDENDUM_STATUS_TONE[v.status]}
                  />
                ),
                priority: "primary",
              },
              {
                id: "furnished",
                header: "Furnished",
                cell: (v) => usDate(v.furnishedAt),
                priority: "tertiary",
              },
            ]}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className={`wx-addendum-split${selected ? " has-drawer" : ""}`}>
      <section className="wx-clinical-section" aria-label="Election Statement Addendum">
        {header}
        <div className="wx-clinical-section-body">{body}</div>
      </section>
      {selected ? (
        <ElectionAddendumDrawer
          admissionId={admissionId}
          version={selected}
          api={api}
          can={can}
          onChanged={() => void load()}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}
