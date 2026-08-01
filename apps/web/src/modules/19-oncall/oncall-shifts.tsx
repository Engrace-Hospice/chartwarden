// apps/web/src/modules/19-oncall — S19.5 ON-CALL SHIFT MANAGEMENT (`/triage/shifts`, §5.1, Track B /
// ADR-0030). Spec: docs/design/screens/clinical/WARDENX_UI_ONCALL_ROSTER_PROTOCOLS.md — "Use Work Queue."
//
// `on_call_shift` IS THE SINGLE MOST SURVEY-LOAD-BEARING ROW M19 WRITES: it is the CoP 418.100(c)(2) proof
// that a nurse was reachable at 2 a.m. Everything on this screen is in service of one question — is every
// window covered, per ProviderEntity?
//
// THE COVERAGE VERDICT IS PER PROVIDER ENTITY AND IS NEVER UNIONED. CoP 418.100(c)(2) is per-CCN, so
// `GET /oncall/current` answers per PE and this screen renders it per PE. A union across entities lets one
// covered entity mask another's dark night, and `actors: []` for a PE is a REAL answer — a coverage gap —
// not an empty result. The banner below therefore counts entities with a gap, never "actors found".
//
// §5.1 ASKS FOR A CLINICIAN × TIME CALENDAR. What is built is the sortable shift table plus the live
// per-PE coverage verdict, and the calendar grid is not: a week grid keyed on clinician needs a roster of
// clinicians, and M19 publishes no membership directory — `on_call_shift` carries membership IDs and
// nothing else, so every lane header would read as an opaque id. The table carries the same facts with the
// ids it actually has, and the roster sync from M17 is what fills it.
//
// COVERAGE GAPS ARE ADVISORY AND NEVER BLOCK (§5.1's own rule, and M19 is DR Tier 1): the watchdog emits a
// critical alert on its own 30-minute cadence. This screen surfaces the same finding; it does not gate
// anything on it.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type CurrentOnCallView,
  type OnCallShiftView,
  createShift,
  errorMessage,
  getCurrentOnCall,
  listShifts,
} from "./oncall-api";
import {
  DEFAULT_SHIFT_DISCIPLINE,
  SHIFT_DISCIPLINES,
  SHIFT_STATUS_TONE,
  clockTime,
  dateTime,
  disciplineLabel,
  humanize,
  nowLocalInput,
  shortDate,
  shortId,
  toInstant,
  toneOf,
} from "./oncall-status";
import {
  Card,
  CountGrid,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./oncall-ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** §4.1.1's `shifts` hard max. */
const SHIFT_PAGE = 200;

const DISCIPLINE_FILTERS = [{ value: "", label: "every discipline" }].concat(
  SHIFT_DISCIPLINES.map((d) => ({ value: d, label: disciplineLabel(d) })),
);

export function OnCallShiftsScreen(): JSX.Element {
  const client = useApiClient();
  const [discipline, setDiscipline] = useState("");
  const [shifts, setShifts] = useState<OnCallShiftView[]>([]);
  const [current, setCurrent] = useState<CurrentOnCallView | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // create-shift fields
  const [providerEntityId, setProviderEntityId] = useState("");
  const [startsAt, setStartsAt] = useState(nowLocalInput());
  const [endsAt, setEndsAt] = useState(nowLocalInput(12 * 60));
  const [newDiscipline, setNewDiscipline] = useState(DEFAULT_SHIFT_DISCIPLINE);
  const [primaryMembership, setPrimaryMembership] = useState("");
  const [backupMembership, setBackupMembership] = useState("");
  const [externalActorId, setExternalActorId] = useState("");
  const [externalActorLabel, setExternalActorLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [list, now] = await Promise.all([
      listShifts(client, { limit: SHIFT_PAGE, ...(discipline ? { discipline } : {}) }),
      getCurrentOnCall(client, {}),
    ]);
    if (list.error) {
      setError(errorMessage(list.error, "The on-call roster could not be loaded."));
      setLoading(false);
      return;
    }
    setShifts(list.page?.data ?? []);
    setTruncated(list.page?.has_more ?? false);
    // The live verdict rides the SAME permission as the schedule, so a failure here is an outage rather
    // than an authority answer — and an outage must not be rendered as "nobody is on call".
    setCurrent(now.current);
    setLoading(false);
  }, [client, discipline]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const sorted = [...shifts].sort((a, b) => a.shiftStartsAt.localeCompare(b.shiftStartsAt));
  const gapEntities = current?.perProviderEntity.filter((p) => p.rnCoverageGap) ?? [];
  const activeShifts = shifts.filter((s) => s.status === "active").length;
  const scheduled = shifts.filter((s) => s.status === "scheduled").length;
  const cancelled = shifts.filter((s) => s.status === "cancelled").length;
  const externalCovered = shifts.filter((s) => s.externalActorId !== null).length;

  // The vendor arm supplies no membership and no user id; the two are structurally different actors, which
  // is why an `external` shift is COUNTED separately rather than being folded into "covered".
  const isExternal = newDiscipline === "external";
  const canCreate =
    UUID_RE.test(providerEntityId) &&
    startsAt !== "" &&
    endsAt !== "" &&
    Date.parse(endsAt) > Date.parse(startsAt) &&
    (isExternal ? UUID_RE.test(externalActorId) : UUID_RE.test(primaryMembership)) &&
    !busy;

  async function commitCreate(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await createShift(client, {
      providerEntityId,
      shiftStartsAt: toInstant(startsAt),
      shiftEndsAt: toInstant(endsAt),
      discipline: newDiscipline,
      ...(isExternal
        ? {
            externalActorId,
            ...(externalActorLabel ? { externalActorLabel } : {}),
          }
        : {
            primaryOnCallMembershipId: primaryMembership,
            ...(UUID_RE.test(backupMembership) ? { backupMembershipId: backupMembership } : {}),
          }),
    });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "The shift could not be created."));
      return;
    }
    setCreating(false);
    await load();
  }

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>On-call roster</span>}
        breadcrumb="On-call triage · coverage"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button type="button" style={ghostButtonStyle} onClick={() => setCreating(true)}>
              Add a shift
            </button>
            <Link to="/triage/policy" style={ghostButtonStyle}>
              On-call policy
            </Link>
          </div>
        }
      />

      {gapEntities.length > 0 ? (
        <Notice tone="error" live>
          <strong>
            {gapEntities.length} provider entit{gapEntities.length === 1 ? "y has" : "ies have"} no RN
            covering right now.
          </strong>{" "}
          Coverage is proved per CCN, so this is counted per entity and never unioned — one covered entity
          must not mask another's dark night. The gap is advisory here: it blocks nothing, and the watchdog
          raises its own critical alert on a 30-minute cadence.
        </Notice>
      ) : current ? (
        <Notice tone="success" live>
          Every provider entity in scope has an RN covering as of {dateTime(current.asOf)}.
        </Notice>
      ) : (
        <Notice tone="warning" live>
          The live coverage verdict could not be read. This is an OUTAGE, not an answer — do not read it as
          "nobody is on call".
        </Notice>
      )}

      <Card title="Coverage right now">
        {!current || current.perProviderEntity.length === 0 ? (
          <span style={mutedStyle}>No provider entity is in scope for this read.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Provider entity</th>
                <th style={th}>RN coverage</th>
                <th style={th}>Covering actors</th>
              </tr>
            </thead>
            <tbody>
              {current.perProviderEntity.map((p) => (
                <tr key={p.providerEntityId} style={rowLine}>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(p.providerEntityId)}</td>
                  <td style={td}>
                    {p.rnCoverageGap ? (
                      <StatusPill label="Gap — no RN" tone="error" />
                    ) : (
                      <StatusPill label="Covered" tone="success" />
                    )}
                  </td>
                  <td style={td}>
                    {p.actors.length === 0 ? (
                      <span style={mutedStyle}>nobody — this is an answer, not an empty result</span>
                    ) : (
                      p.actors
                        .map((a) =>
                          a.kind === "membership"
                            ? `${disciplineLabel(a.discipline)} ${shortId(a.membershipId)}${a.isBackup ? " (backup)" : ""}`
                            : `${a.externalActorLabel ?? "external vendor"} ${shortId(a.externalActorId)}`,
                        )
                        .join(" · ")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Schedule">
        <CountGrid
          entries={[
            { label: "On this page", value: shifts.length },
            { label: "Active now", value: activeShifts },
            { label: "Scheduled", value: scheduled },
            { label: "Cancelled", value: cancelled, tone: cancelled > 0 ? "error" : undefined },
            { label: "Vendor-covered", value: externalCovered },
          ]}
        />
        {truncated ? (
          <Notice tone="info">
            More than {SHIFT_PAGE} shifts match. The counts above count the page fetched.
          </Notice>
        ) : null}
      </Card>

      <FilterRow>
        <SelectField
          label="Discipline"
          value={discipline}
          options={DISCIPLINE_FILTERS}
          onChange={setDiscipline}
        />
      </FilterRow>

      <Card title="Shifts">
        {sorted.length === 0 ? (
          <span style={mutedStyle}>
            No on-call shift is scheduled for this window. Add one — or, in the Direct model, let the M17
            roster sync fill it.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Shift</th>
                <th style={th}>Provider entity</th>
                <th style={th}>Window</th>
                <th style={th}>Discipline</th>
                <th style={th}>Primary</th>
                <th style={th}>Backup</th>
                <th style={th}>Source</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id} style={rowLine}>
                  <td style={td}>
                    <Link to={`/triage/shifts/${s.id}`} style={linkStyle}>
                      {shortId(s.id)}
                    </Link>
                  </td>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(s.providerEntityId)}</td>
                  <td style={td}>
                    {shortDate(s.shiftStartsAt)} {clockTime(s.shiftStartsAt)} →{" "}
                    {shortDate(s.shiftEndsAt) === shortDate(s.shiftStartsAt)
                      ? clockTime(s.shiftEndsAt)
                      : `${shortDate(s.shiftEndsAt)} ${clockTime(s.shiftEndsAt)}`}
                  </td>
                  <td style={td}>{disciplineLabel(s.discipline)}</td>
                  <td style={td}>
                    {s.externalActorId
                      ? (s.externalActorLabel ?? "external vendor")
                      : shortId(s.primaryOnCallMembershipId)}
                  </td>
                  <td style={td}>{shortId(s.backupMembershipId)}</td>
                  <td style={td}>
                    {s.m17VisitAssignmentRef ? "M17 roster sync" : s.externalActorId ? "Vendor" : "Manual"}
                  </td>
                  <td style={td}>
                    <StatusPill label={humanize(s.status)} tone={toneOf(SHIFT_STATUS_TONE, s.status)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {creating ? (
        <Modal
          title="Add an on-call shift"
          onClose={() => setCreating(false)}
          footer={
            <button
              type="button"
              disabled={!canCreate}
              style={canCreate ? primaryButtonStyle : disabledButtonStyle}
              title={
                canCreate
                  ? undefined
                  : "A provider entity, a window that ends after it starts, and either a primary membership or an external actor are required."
              }
              onClick={() => void commitCreate()}
            >
              Create
            </button>
          }
        >
          <Notice tone="info">
            The escalation-ladder snapshot is NOT a field here. The tenant policy is pinned onto the shift
            when it activates, so the record can answer "which ladder was in effect that night" with
            something nobody typed.
          </Notice>
          <TextField label="Provider entity id" value={providerEntityId} onChange={setProviderEntityId} mono />
          <TextField label="Starts at" value={startsAt} onChange={setStartsAt} type="datetime-local" />
          <TextField label="Ends at" value={endsAt} onChange={setEndsAt} type="datetime-local" />
          <SelectField
            label="Discipline"
            value={newDiscipline}
            options={SHIFT_DISCIPLINES.map((d) => ({ value: d, label: disciplineLabel(d) }))}
            onChange={setNewDiscipline}
          />
          {isExternal ? (
            <>
              <TextField
                label="External vendor id"
                value={externalActorId}
                onChange={setExternalActorId}
                mono
                hint="A vendor-covered shift names a vendor binding, never a membership — the two are structurally different actors."
              />
              <TextField
                label="Vendor-side label (optional)"
                value={externalActorLabel}
                onChange={setExternalActorLabel}
              />
            </>
          ) : (
            <>
              <TextField
                label="Primary on-call membership id"
                value={primaryMembership}
                onChange={setPrimaryMembership}
                mono
                hint="A shift with no named clinician cannot prove coverage, so the server refuses one."
              />
              <TextField
                label="Backup membership id (optional)"
                value={backupMembership}
                onChange={setBackupMembership}
                mono
              />
            </>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
