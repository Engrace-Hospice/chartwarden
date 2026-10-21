import {
  Button,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/37-ipu — the IPU bedside pane (§5; #91). `/ipu/admissions/:id`.
//
// One admission, and everything about it that a shift working the unit has to act on: the restraints
// under their reassessment clock, the CoP 418.108 GIP criterion and its reassessment trail, the respite
// episode against its 5-day cap, the visitors currently on the unit, and the restrictions in force for
// this patient.
//
// This screen could not have been written before #169 and #172. Four of its five sections read from
// routes that did not exist: `GET /ipu-admissions/:id/restraints`, `.../gip-criteria`,
// `.../irc-episodes` and `GET /ipu-visitors` were all added by #169 precisely because the writes they
// feed — reassess, release, check-out — were keyed by ids obtainable only from the POST that created
// them. A bedside pane whose restraint card could not find the restraint it was standing next to is not
// a pane; and #172 added the restriction list this one's fifth section reads.
//
// The reassessment clock is the reason this screen exists at all. A behavioral restraint is reassessed
// every 15 minutes (§2.10, CoP 418.110); the countdown is rendered from the row's own interval so what a
// nurse sees is the cadence the physician's order set, not a platform default.
//
// WHAT THE SERVER OWNS (ADR-0030 — no frontend authz): every write here is refused or allowed
// server-side. The action sets narrow which BUTTON a row shows; an unrecognised state keeps its actions.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  type AdmissionView,
  type GipCriteriaRow,
  type IrcEpisodeRow,
  type RestraintRow,
  type RestrictionRow,
  type VisitorRow,
  isAdmissionOpen,
  isRestraintLive,
  restraintDueAt,
} from "./ipu-api";
import {
  ApplyRestraintModal,
  ApplyRestrictionModal,
  AttestGipModal,
  CheckInVisitorModal,
  CheckOutVisitorModal,
  IrcCapOverrideModal,
  LiftRestrictionModal,
  ReassessGipModal,
  ReassessRestraintModal,
  ReleaseRestraintModal,
} from "./ipu-modals";

const titleCase = (value: string): string =>
  value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

const stateTone = (state: string): StatusTone =>
  state === "active"
    ? "success"
    : state === "discharged" || state === "transferred" || state === "closed"
      ? "neutral"
      : state === "deceased"
        ? "critical"
        : "warning";

const formatInstant = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * "Due in 12 min" / "Overdue by 4 min" — rendered against the restraint's OWN interval.
 *
 * Overdue is stated, never enforced: the platform's reassessment watchdog is what raises
 * `m37.restraint.reassessment_due`, and a frontend that disabled the button on its own clock reading
 * would take away the control at exactly the moment it is most needed.
 */
function dueLabel(row: RestraintRow, nowMs: number): { text: string; tone: StatusTone } {
  const due = restraintDueAt(row);
  if (!due) return { text: "Cadence unknown", tone: "neutral" };
  const deltaMin = Math.round((due.getTime() - nowMs) / 60_000);
  if (deltaMin < 0)
    return {
      text: `Overdue by ${Math.abs(deltaMin)} min`,
      // `critical` rather than `error`: an overdue reassessment is a SAFETY state, not a failed
      // operation, and CoP 418.110 is what makes it one.
      tone: "critical",
    };
  return { text: `Due in ${deltaMin} min`, tone: deltaMin <= 5 ? "warning" : "success" };
}

export function IpuBedside(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();

  const [admission, setAdmission] = useState<AdmissionView | null>(null);
  const [restraints, setRestraints] = useState<RestraintRow[]>([]);
  const [gipCriteria, setGipCriteria] = useState<GipCriteriaRow[]>([]);
  const [ircEpisodes, setIrcEpisodes] = useState<IrcEpisodeRow[]>([]);
  const [visitors, setVisitors] = useState<VisitorRow[]>([]);
  const [restrictions, setRestrictions] = useState<RestrictionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [applyRestraintOpen, setApplyRestraintOpen] = useState(false);
  const [reassessTarget, setReassessTarget] = useState<RestraintRow | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<RestraintRow | null>(null);
  const [attestOpen, setAttestOpen] = useState(false);
  const [reassessGipOpen, setReassessGipOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<IrcEpisodeRow | null>(null);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [checkOutTarget, setCheckOutTarget] = useState<VisitorRow | null>(null);
  const [applyRestrictionOpen, setApplyRestrictionOpen] = useState(false);
  const [liftTarget, setLiftTarget] = useState<string | null>(null);

  // One clock tick a minute drives the reassessment countdown. Deliberately not a timer per row.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const admissionRes = await client.GET("/api/v1/ipu-admissions/{id}", {
      params: { path: { id } },
    });
    if (admissionRes.error || !admissionRes.data) {
      setError("This admission is not available to you.");
      setLoading(false);
      return;
    }
    const adm = admissionRes.data as AdmissionView;
    setAdmission(adm);
    setError(null);

    const [r, g, e, v, x] = await Promise.all([
      client.GET("/api/v1/ipu-admissions/{id}/restraints", { params: { path: { id } } }),
      client.GET("/api/v1/ipu-admissions/{id}/gip-criteria", { params: { path: { id } } }),
      client.GET("/api/v1/ipu-admissions/{id}/irc-episodes", { params: { path: { id } } }),
      client.GET("/api/v1/ipu-visitors", { params: { query: { ipuAdmissionId: id } } }),
      client.GET("/api/v1/ipu-visitor-restrictions", {
        params: { query: { patientId: adm.patientId } },
      }),
    ]);
    setRestraints(r.data?.items ?? []);
    setGipCriteria(g.data?.items ?? []);
    setIrcEpisodes(e.data?.items ?? []);
    setVisitors(v.data?.items ?? []);
    setRestrictions(x.data?.items ?? []);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const liveRestraints = useMemo(
    () => restraints.filter((r) => isRestraintLive(r.state)),
    [restraints],
  );
  const onUnitVisitors = useMemo(() => visitors.filter((v) => v.checkedOutAt === null), [visitors]);
  const activeIrc = ircEpisodes.find((e) => e.state === "active") ?? ircEpisodes[0] ?? null;

  if (loading) return <LoadingSpinner />;
  if (error || !admission || !id)
    return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  const open = isAdmissionOpen(admission.state);
  const isGip = admission.kind === "gip";
  const isIrc = admission.kind === "irc";

  return (
    <>
      <DetailPageLayout
        header={
          <PageHeader title="Bedside" breadcrumb="IPU / Admissions / Bedside">
            <div style={headerMetaStyle}>
              <StatusPill tone={stateTone(admission.state)} label={titleCase(admission.state)} />
              <span style={levelBadgeStyle}>{admission.kind.toUpperCase()}</span>
              <span>
                Admission <code className="wx-data-md">{admission.id}</code>
              </span>
            </div>
          </PageHeader>
        }
        aside={
          <RightDetailPanel title="Visitor restrictions">
            {restrictions.length === 0 ? (
              <p style={asideEmptyStyle}>No restrictions in force for this patient.</p>
            ) : (
              <ul style={asideListStyle}>
                {restrictions.map((r) => (
                  <li key={r.id} style={asideItemStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <Glyph name="alert" size={14} />
                      <strong>{titleCase(r.restrictionKind)}</strong>
                    </div>
                    <p style={asideRationaleStyle}>{r.rationale}</p>
                    <p style={asideMetaStyle}>Applied {formatInstant(r.appliedAt)}</p>
                    <Button size="sm" tone="tertiary" onClick={() => setLiftTarget(r.id)}>
                      Lift restriction
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {open ? (
              <div style={{ marginTop: "0.75rem" }}>
                <Button size="sm" tone="secondary" onClick={() => setApplyRestrictionOpen(true)}>
                  Apply restriction
                </Button>
              </div>
            ) : null}
          </RightDetailPanel>
        }
      >
        <div style={stackStyle}>
          {/* ── restraints ───────────────────────────────────────────────────────────────────── */}
          <Section
            heading="Restraints"
            note="A restraint requires a signed physician order (CoP 418.110) and is reassessed on the cadence that order set."
            action={
              open ? (
                <Button size="sm" tone="secondary" onClick={() => setApplyRestraintOpen(true)}>
                  Apply restraint
                </Button>
              ) : null
            }
          >
            {restraints.length === 0 ? (
              <p style={emptyStyle}>
                No restraints recorded. The default IPU posture is restraint-free.
              </p>
            ) : (
              <ul style={cardListStyle}>
                {restraints.map((row) => {
                  const live = isRestraintLive(row.state);
                  const due = dueLabel(row, nowMs);
                  return (
                    <li key={row.id} style={cardStyle}>
                      <div style={cardHeadStyle}>
                        <strong>{titleCase(row.restraintKind)}</strong>
                        <StatusPill
                          tone={live ? "warning" : "neutral"}
                          label={titleCase(row.state)}
                        />
                        {live ? <StatusPill tone={due.tone} label={due.text} /> : null}
                      </div>
                      <p style={cardMetaStyle}>
                        {titleCase(row.category)} · every {row.reassessmentIntervalMinutes} min ·
                        applied {formatInstant(row.appliedAt)} · {row.reassessmentCount}{" "}
                        reassessment
                        {row.reassessmentCount === 1 ? "" : "s"}
                        {row.releasedAt ? ` · released ${formatInstant(row.releasedAt)}` : ""}
                      </p>
                      {live ? (
                        <div style={cardActionsStyle}>
                          <Button size="sm" tone="primary" onClick={() => setReassessTarget(row)}>
                            Reassess
                          </Button>
                          <Button size="sm" tone="tertiary" onClick={() => setReleaseTarget(row)}>
                            Release
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {/* ── GIP criteria ─────────────────────────────────────────────────────────────────── */}
          {isGip ? (
            <Section
              heading="GIP criteria"
              note="CoP 418.108 permits general inpatient care under three criteria. An admission cannot be confirmed until one is attested, and it is reassessed as the stay continues."
              action={
                open ? (
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <Button size="sm" tone="secondary" onClick={() => setAttestOpen(true)}>
                      Attest criterion
                    </Button>
                    {gipCriteria.length > 0 ? (
                      <Button size="sm" tone="tertiary" onClick={() => setReassessGipOpen(true)}>
                        Reassess criterion
                      </Button>
                    ) : null}
                  </div>
                ) : null
              }
            >
              {gipCriteria.length === 0 ? (
                <p style={emptyStyle}>
                  No criterion attested. This admission cannot be confirmed until a physician
                  attests one.
                </p>
              ) : (
                <ul style={cardListStyle}>
                  {gipCriteria.map((row) => (
                    <li key={row.id} style={cardStyle}>
                      <div style={cardHeadStyle}>
                        <strong>{titleCase(row.criterionKind)}</strong>
                      </div>
                      <p style={cardMetaStyle}>
                        Attested {formatInstant(row.attestedAt)} · physician{" "}
                        <code className="wx-data-md">{row.attestingPhysicianId}</code>
                      </p>
                      {row.reassessments.length > 0 ? (
                        <ul style={trailStyle}>
                          {row.reassessments.map((re) => (
                            <li key={re.id}>
                              {formatInstant(re.reassessedAt)} —{" "}
                              {re.criterionStillMet ? "still met" : "no longer met"}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p style={cardMetaStyle}>No reassessments recorded yet.</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          {/* ── IRC episode ──────────────────────────────────────────────────────────────────── */}
          {isIrc ? (
            <Section
              heading="Respite episode"
              note="Inpatient respite is capped at 5 consecutive days. The override extends it by at most 2 and may be invoked once."
              action={
                open && activeIrc && !activeIrc.capOverrideInvoked ? (
                  <Button size="sm" tone="secondary" onClick={() => setOverrideTarget(activeIrc)}>
                    Override cap
                  </Button>
                ) : null
              }
            >
              {ircEpisodes.length === 0 ? (
                <p style={emptyStyle}>No respite episode recorded for this admission.</p>
              ) : (
                <ul style={cardListStyle}>
                  {ircEpisodes.map((row) => (
                    <li key={row.id} style={cardStyle}>
                      <div style={cardHeadStyle}>
                        <strong>Day {row.consecutiveDayCount}</strong>
                        <StatusPill
                          tone={row.state === "active" ? "success" : "neutral"}
                          label={titleCase(row.state)}
                        />
                        {row.capOverrideInvoked ? (
                          <StatusPill tone="warning" label="Cap override invoked" />
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          {/* ── visitors ─────────────────────────────────────────────────────────────────────── */}
          <Section
            heading="Visitors"
            note="Check-in is refused by a restriction in force. A visitor is checked out by whoever is on shift when they leave."
            action={
              open ? (
                <Button size="sm" tone="secondary" onClick={() => setCheckInOpen(true)}>
                  Check in visitor
                </Button>
              ) : null
            }
          >
            {visitors.length === 0 ? (
              <p style={emptyStyle}>No visitors recorded for this admission.</p>
            ) : (
              <ul style={cardListStyle}>
                {visitors.map((row) => (
                  <li key={row.id} style={cardStyle}>
                    <div style={cardHeadStyle}>
                      <strong>{titleCase(row.relationship)}</strong>
                      <StatusPill
                        tone={row.checkedOutAt ? "neutral" : "success"}
                        label={row.checkedOutAt ? "Departed" : "On unit"}
                      />
                      {row.maskRequired ? (
                        <StatusPill tone="warning" label="Mask required" />
                      ) : null}
                    </div>
                    <p style={cardMetaStyle}>
                      In {formatInstant(row.checkedInAt)}
                      {row.checkedOutAt ? ` · out ${formatInstant(row.checkedOutAt)}` : ""}
                    </p>
                    {row.checkedOutAt === null ? (
                      <div style={cardActionsStyle}>
                        <Button size="sm" tone="tertiary" onClick={() => setCheckOutTarget(row)}>
                          Check out
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {onUnitVisitors.length > 0 ? (
              <p style={cardMetaStyle}>
                {onUnitVisitors.length} visitor{onUnitVisitors.length === 1 ? "" : "s"} currently on
                the unit.
              </p>
            ) : null}
          </Section>

          {liveRestraints.length > 0 ? (
            <p style={cardMetaStyle}>
              {liveRestraints.length} active restraint
              {liveRestraints.length === 1 ? "" : "s"} on this patient.
            </p>
          ) : null}
        </div>
      </DetailPageLayout>

      <ApplyRestraintModal
        open={applyRestraintOpen}
        admissionId={id}
        patientId={admission.patientId}
        onClose={() => setApplyRestraintOpen(false)}
        onDone={() => void load()}
      />
      <ReassessRestraintModal
        open={reassessTarget !== null}
        restraint={reassessTarget}
        onClose={() => setReassessTarget(null)}
        onDone={() => void load()}
      />
      <ReleaseRestraintModal
        open={releaseTarget !== null}
        restraint={releaseTarget}
        onClose={() => setReleaseTarget(null)}
        onDone={() => void load()}
      />
      <AttestGipModal
        open={attestOpen}
        admissionId={id}
        onClose={() => setAttestOpen(false)}
        onDone={() => void load()}
      />
      <ReassessGipModal
        open={reassessGipOpen}
        admissionId={id}
        onClose={() => setReassessGipOpen(false)}
        onDone={() => void load()}
      />
      <IrcCapOverrideModal
        open={overrideTarget !== null}
        admissionId={id}
        episode={overrideTarget}
        onClose={() => setOverrideTarget(null)}
        onDone={() => void load()}
      />
      <CheckInVisitorModal
        open={checkInOpen}
        admissionId={id}
        onClose={() => setCheckInOpen(false)}
        onDone={() => void load()}
      />
      <CheckOutVisitorModal
        open={checkOutTarget !== null}
        visitor={checkOutTarget}
        onClose={() => setCheckOutTarget(null)}
        onDone={() => void load()}
      />
      <ApplyRestrictionModal
        open={applyRestrictionOpen}
        patientId={admission.patientId}
        onClose={() => setApplyRestrictionOpen(false)}
        onDone={() => void load()}
      />
      <LiftRestrictionModal
        open={liftTarget !== null}
        restrictionId={liftTarget}
        onClose={() => setLiftTarget(null)}
        onDone={() => void load()}
      />
    </>
  );
}

function Section({
  heading,
  note,
  action,
  children,
}: {
  heading: string;
  note: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={sectionStyle}>
      <div style={sectionHeadStyle}>
        <div>
          <h2 style={sectionTitleStyle}>{heading}</h2>
          <p style={sectionNoteStyle}>{note}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const stackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1.25rem",
};

const sectionStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-low)",
  padding: "1rem 1.125rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const sectionHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const sectionTitleStyle: CSSProperties = { margin: 0, fontSize: "0.95rem", fontWeight: 650 };

const sectionNoteStyle: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  maxWidth: "48ch",
};

const cardListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.625rem",
};

const cardStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
  borderRadius: "var(--radius-md)",
  padding: "0.75rem 0.875rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const cardHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  fontSize: "0.875rem",
};

const cardMetaStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const cardActionsStyle: CSSProperties = { display: "flex", gap: "0.5rem" };

const trailStyle: CSSProperties = {
  margin: 0,
  paddingLeft: "1rem",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const emptyStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};

const headerMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
  flexWrap: "wrap",
};

const levelBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  fontSize: "0.75rem",
  fontWeight: 650,
};

const asideListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const asideItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  fontSize: "0.8rem",
};

const asideRationaleStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const asideMetaStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.7rem",
  color: "var(--color-on-surface-variant)",
};

const asideEmptyStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};
