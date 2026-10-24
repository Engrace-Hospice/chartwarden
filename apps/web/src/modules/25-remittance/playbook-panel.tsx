import { Button, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the PLAYBOOK section of the denial work panel and of the appeal panel (through the
// appeal's denial), hospice ADR/TPE/QIC PRD milestone 9a-1. It shows the guidance YOUR ORGANIZATION wrote for this denial's
// reason code: a summary, its source, who reviewed it, which version is in force and the ordered steps. There is no platform
// playbook: when the organization has not written one the panel says so (and offers "Write one" to people who may author),
// it never fills the gap with advice. Guidance only: ticks are for the team's own tracking and gate nothing, and the banner
// says the text is neither legal advice nor a CMS or MAC requirement. The parent mounts this with `key={denialId}`.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import { ButtonRow, ErrorAlert, Facts, Hint, WarningAlert } from "./action-ui";
import {
  type DenialPlaybook,
  PLAYBOOK_CODE_KIND_LABEL,
  PLAYBOOK_STEP_STATUS_LABEL,
  type PlaybookStepStatus,
  loadDenialPlaybook,
  setPlaybookStep,
} from "./playbook-api";

export const PLAYBOOK_BANNER =
  "Guidance written by your organization. It is not legal advice and it is not a CMS or MAC requirement. Check the source.";
const STEP_STATUSES: readonly PlaybookStepStatus[] = ["open", "done", "not_applicable"];

export interface PlaybookPanelProps {
  readonly denialId: string;
  /** Bumped by the parent after one of its own actions, so the panel reads again. */
  readonly refreshToken?: number;
}

/** The authoring screen, pre-filled with the reason this denial carries. */
function writeOneHref(view: DenialPlaybook): string {
  const q = new URLSearchParams({ new: "1" });
  if (view.codeKind) q.set("kind", view.codeKind);
  if (view.code) q.set("code", view.code);
  if (view.macName) q.set("mac", view.macName);
  return `/remittance/playbooks?${q.toString()}`;
}

export function PlaybookPanel({
  denialId,
  refreshToken = 0,
}: PlaybookPanelProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const canAuthor = session?.permissions?.includes("playbook.author") ?? false;
  const [view, setView] = useState<DenialPlaybook | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const loadSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await loadDenialPlaybook(client, denialId);
    // An older response must never overwrite a newer one.
    if (!mounted.current || seq !== loadSeq.current) return;
    if (res.ok) {
      setView(res.value);
      setLoadError(null);
      setHidden(false);
    } else if (res.status === 403) {
      setHidden(true); // not permitted: the section simply is not offered
    } else {
      setLoadError(res.message);
    }
  }, [client, denialId]);

  // refreshToken is a trigger, not a value the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on refreshToken by design
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  async function tick(stepKey: string, status: PlaybookStepStatus): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyKey(stepKey);
    setActionError(null);
    try {
      const res = await setPlaybookStep(client, denialId, stepKey, status);
      if (!mounted.current) return;
      if (!res.ok) setActionError(res.message);
      await load();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusyKey(null);
    }
  }

  if (hidden) return null;
  const pb = view?.playbook ?? null;
  const reason =
    view?.code && view.codeKind
      ? `${PLAYBOOK_CODE_KIND_LABEL[view.codeKind] ?? view.codeKind} ${view.code}`
      : "this denial's reason";

  return (
    <section aria-label="Denial playbook" aria-busy={busyKey !== null}>
      <h3 className="wx-action-title">Playbook</h3>
      <ErrorAlert message={actionError} />
      {loadError ? (
        <>
          <ErrorAlert message={loadError} />
          <ButtonRow>
            <Button tone="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </ButtonRow>
        </>
      ) : null}
      {!view ? (
        loadError ? null : (
          <Hint>Loading playbook…</Hint>
        )
      ) : pb === null ? (
        <>
          <Hint>{`No playbook for ${reason} yet. Your organization has not written one.`}</Hint>
          {canAuthor ? (
            <Hint>
              <Link to={writeOneHref(view)}>Write one</Link>
            </Hint>
          ) : null}
        </>
      ) : (
        <>
          <WarningAlert>{PLAYBOOK_BANNER}</WarningAlert>
          <Facts
            items={[
              ["Playbook", pb.title],
              [
                "Applies to",
                `${PLAYBOOK_CODE_KIND_LABEL[pb.codeKind] ?? pb.codeKind} ${pb.code}${pb.macName ? ` · ${pb.macName}` : " · any MAC"}`,
              ],
              [
                "Version",
                <StatusPill
                  key="v"
                  label={`Version ${pb.versionNo}, published ${pb.publishedAt.slice(0, 10)}`}
                  tone="neutral"
                />,
              ],
              ["Source", pb.sourceNote],
              ["Written by", pb.authoredByMembershipId],
              ["Reviewed by", pb.reviewedByMembershipId],
            ]}
          />
          <p>{pb.summary}</p>
          <ol aria-label="Playbook steps">
            {pb.steps.map((s) => (
              <li key={s.key}>
                {s.text}{" "}
                <select
                  aria-label={`Status of step: ${s.text}`}
                  value={s.status}
                  disabled={busyKey !== null}
                  onChange={(e) => void tick(s.key, e.target.value as PlaybookStepStatus)}
                >
                  {STEP_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {PLAYBOOK_STEP_STATUS_LABEL[st]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ol>
          <Hint>
            Ticks are for your team's tracking only. They do not change this denial or block any
            action.
          </Hint>
        </>
      )}
    </section>
  );
}
