import {
  Button,
  EmptyState,
  Glyph,
  InlineAlert,
  KpiCard,
  LoadingSpinner,
  StatusPill,
  TextField,
  interactiveRowProps,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — HELD TRANSMISSIONS (GAP-125; F-201 worklist, F-187/F-188 attested recovery, F-202
// two-person control). The lab orders whose outbound HL7 message dead-ended — retries exhausted with delivery
// unconfirmed, rejected by the lab interface, or a blocked recovery. A message may already be at the lab, so nothing
// here is retried automatically: an operator calls the lab, then ATTESTS what the lab holds.
//
//   • "Lab did not receive it" (`not_received_by_lab`) FILES a request a different person must co-sign before the order
//     is re-sent once (F-202); "Lab already has it" (`received_by_lab`) marks it transmitted and sends nothing.
//   • Both need the lab contact's name and the lab's own reference — fields shaped so they cannot carry a patient
//     identifier — and a fresh step-up; a stale session is sent through `/step-up` with the typed evidence kept.
//
// Layout follows the redesign's list + right drawer (the Hospice Rates / Admissions pattern): KPI tiles, the flat
// `wx-list-table`, and an `aside.wx-admission-drawer` for the selected order. Visibility of the recovery controls follows
// the session's grants as a UX cue only; the server is the only enforcement point (ADR-0030).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  findStepUpDraftResourceId,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import {
  type ActionResult,
  type Attestation,
  type EvidenceErrors,
  type HeldItem,
  type HeldOrderDetail,
  RECOVER_STEP_UP_ACTION,
  type RecoverOutcome,
  STAGE_PILL,
  cancelRecovery,
  cosignRecovery,
  getHeldOrder,
  heldAge,
  heldReasonLabel,
  listHeldTransmissions,
  outcomeMessage,
  recoverTransmission,
  validateEvidence,
} from "./held-transmissions-api";

const shortId = (id: string): string => `${id.slice(0, 8)}…${id.slice(-4)}`;

function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function HeldTransmissions(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const [items, setItems] = useState<HeldItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    findStepUpDraftResourceId(session, RECOVER_STEP_UP_ACTION),
  );
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-reads the first page after a recovery.
  useEffect(() => {
    let active = true;
    setError(null);
    void (async () => {
      const res = await listHeldTransmissions(client, null);
      if (!active) return;
      if (!res.ok) {
        setError(
          res.status === 403
            ? "You lack orders.transmission.view_held, so the held-transmission queue cannot be shown."
            : "The held-transmission queue could not be loaded.",
        );
        setItems([]);
        return;
      }
      setItems([...res.page.items]);
      setNextCursor(res.page.nextCursor);
    })();
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const res = await listHeldTransmissions(client, nextCursor);
    setLoadingMore(false);
    if (!res.ok) {
      setError("The next page of held transmissions could not be loaded.");
      return;
    }
    setItems((prev) => [...(prev ?? []), ...res.page.items]);
    setNextCursor(res.page.nextCursor);
  }, [client, nextCursor]);

  const all = items ?? [];
  const counts = useMemo(
    () => ({
      critical: all.filter((i) => i.stage === "critical").length,
      aging: all.filter((i) => i.stage === "warn").length,
      oldest: all.reduce((max, i) => Math.max(max, i.ageSeconds), 0),
    }),
    [all],
  );
  const selected = all.find((i) => i.orderId === selectedId) ?? null;

  return (
    <div className={`wx-rates wx-held-tx${selectedId ? " has-drawer" : ""}`}>
      <div className="wx-rates-main">
        <header className="wx-page-head">
          <div>
            <h1>Held Transmissions</h1>
            <p>
              Lab orders whose HL7 message dead-ended. The lab may already hold them, so none is
              retried automatically: call the lab, then record what it actually has.
            </p>
          </div>
          <Button tone="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            <Glyph name="rotate-ccw" size={15} /> Refresh
          </Button>
        </header>

        <div className="wx-stat-grid" aria-label="Held transmission summary">
          <KpiCard
            icon="send"
            label="Held"
            value={items ? `${all.length}${nextCursor ? "+" : ""}` : "—"}
            detail="Loaded, oldest first"
          />
          <KpiCard
            icon="alert"
            label="Critical"
            value={items ? String(counts.critical) : "—"}
            detail="Held past the critical threshold"
            accentColor={counts.critical > 0 ? t.error : undefined}
          />
          <KpiCard
            icon="clock"
            label="Aging"
            value={items ? String(counts.aging) : "—"}
            detail="Past the warning threshold"
            accentColor={counts.aging > 0 ? t.warning : undefined}
          />
          <KpiCard
            icon="calendar-check"
            label="Oldest"
            value={items && all.length > 0 ? heldAge(counts.oldest) : "—"}
            detail="Since the order was marked failed"
          />
        </div>

        {items === null ? (
          <LoadingSpinner />
        ) : error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="Held transmissions unavailable" description={error} />
            <Button tone="secondary" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          </div>
        ) : all.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title="No held transmissions"
              description="Every signed lab order has reached the lab or is still on its way."
            />
          </div>
        ) : (
          <>
            <HeldTable items={all} selectedId={selectedId} onSelect={setSelectedId} />
            {nextCursor ? (
              <Button tone="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
          </>
        )}
      </div>

      {selectedId ? (
        <HeldOrderDrawer
          key={selectedId}
          orderId={selectedId}
          item={selected}
          onClose={() => setSelectedId(null)}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
    </div>
  );
}

function HeldTable({
  items,
  selectedId,
  onSelect,
}: {
  items: HeldItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Held lab-order transmissions</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Patient</th>
            <th scope="col">Reason</th>
            <th scope="col">Held for</th>
            <th scope="col">Stage</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const isSelected = i.orderId === selectedId;
            return (
              <tr
                key={i.orderId}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(() => onSelect(i.orderId), isSelected)}
              >
                <td>
                  <span className="wx-row-title">Lab order</span>
                  <span className="wx-row-sub wx-data-md">{shortId(i.orderId)}</span>
                </td>
                <td className="wx-data-md">{shortId(i.patientId)}</td>
                <td>{heldReasonLabel(i.reason)}</td>
                <td className="wx-nums">{heldAge(i.ageSeconds)}</td>
                <td>
                  <StatusPill {...STAGE_PILL[i.stage]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface EvidenceDraft {
  readonly attestation: Attestation | null;
  readonly contactName: string;
  readonly labReference: string;
}

type Notice = { tone: "error" | "success" | "info"; text: string } | null;

function HeldOrderDrawer({
  orderId,
  item,
  onClose,
  onChanged,
}: {
  orderId: string;
  item: HeldItem | null;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  const draftKey = stepUpDraftKey(session, RECOVER_STEP_UP_ACTION, orderId);
  const granted = session?.permissions ?? [];
  const canRecover = granted.includes("orders.transmission.recover");
  const canCosign = canRecover || granted.includes("orders.transmission.cosign_escalated");

  const [detail, setDetail] = useState<HeldOrderDetail | null | undefined>(undefined);
  const [draft, setDraft] = useState<EvidenceDraft>(
    () =>
      peekStepUpDraft<EvidenceDraft>(draftKey) ?? {
        attestation: null,
        contactName: "",
        labReference: "",
      },
  );
  const [errors, setErrors] = useState<EvidenceErrors>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [detailKey, setDetailKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: detailKey re-reads the order after an action.
  useEffect(() => {
    let active = true;
    void getHeldOrder(client, orderId).then((d) => {
      if (active) setDetail(d);
    });
    return () => {
      active = false;
    };
  }, [client, orderId, detailKey]);

  function settle<T>(
    res: ActionResult<T>,
    onOk: (value: T) => Notice,
    stash?: EvidenceDraft,
  ): void {
    setBusy(false);
    if (!res.ok) {
      if (res.stepUp) {
        if (stash) stashStepUpDraft(draftKey, stash);
        navigate(res.stepUp);
        return;
      }
      setNotice({ tone: "error", text: res.message });
      return;
    }
    clearStepUpDraft(draftKey);
    setNotice(onOk(res.value));
    setDetailKey((k) => k + 1);
    onChanged();
  }

  async function attest(): Promise<void> {
    if (!draft.attestation) {
      setNotice({ tone: "error", text: "Say what the lab told you: received or not received." });
      return;
    }
    const found = validateEvidence(draft.contactName, draft.labReference);
    setErrors(found);
    if (found.contactName || found.labReference) return;
    setBusy(true);
    setNotice(null);
    const res = await recoverTransmission(
      client,
      orderId,
      {
        attestation: draft.attestation,
        contactName: draft.contactName.trim(),
        labReference: draft.labReference.trim(),
      },
      returnTo,
    );
    settle(res, (v: RecoverOutcome) => outcomeMessage(v), draft);
  }

  async function cosign(requestId: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    settle(
      await cosignRecovery(client, orderId, requestId, returnTo),
      (v) => outcomeMessage(v),
      draft,
    );
  }

  async function cancel(requestId: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    settle(await cancelRecovery(client, orderId, requestId, returnTo), () => ({
      tone: "success",
      text: "Recovery request cancelled. The order stays held.",
    }));
  }

  const pending =
    detail?.pendingRecovery?.status === "pending_cosign" ? detail.pendingRecovery : null;
  const selfFiled =
    pending !== null &&
    pending.requestedByMembershipId !== null &&
    pending.requestedByMembershipId === session?.membershipId;

  return (
    <aside className="wx-admission-drawer" aria-label={`Held lab order ${shortId(orderId)}`}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="send" size={20} />
        </span>
        <div className="wx-rates-drawer-title">
          <h2>Held lab order</h2>
          <div className="wx-row-sub">
            {item ? heldReasonLabel(item.reason) : "Transmission held"}
          </div>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Transmission</h3>
            {item ? <StatusPill {...STAGE_PILL[item.stage]} /> : null}
          </div>
          <dl className="wx-kv">
            <dt>Order</dt>
            <dd>
              <Link to={`/orders/${orderId}`} className="wx-data-md">
                {shortId(orderId)}
              </Link>
            </dd>
            <dt>Patient</dt>
            <dd className="wx-data-md">{shortId(item?.patientId ?? detail?.patientId ?? "")}</dd>
            {item ? (
              <>
                <dt>Failed</dt>
                <dd className="wx-nums">{dateTime(item.failedAt)}</dd>
                <dt>Held for</dt>
                <dd className="wx-nums">{heldAge(item.ageSeconds)}</dd>
                <dt>Feed</dt>
                <dd className="wx-data-md">
                  {item.feedId ? shortId(item.feedId) : "No outbound row"}
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        {detail === undefined ? (
          <LoadingSpinner />
        ) : detail === null ? (
          <InlineAlert tone="error">The order could not be loaded.</InlineAlert>
        ) : pending ? (
          <section className="wx-drawer-card">
            <h3>Awaiting a second person</h3>
            <p className="wx-row-sub">
              A “lab did not receive it” attestation was filed. A different person must co-sign
              before the order is re-sent once.
            </p>
            <dl className="wx-kv">
              <dt>Filed</dt>
              <dd className="wx-nums">{dateTime(pending.requestedAt)}</dd>
              <dt>Expires</dt>
              <dd className="wx-nums">{dateTime(pending.expiresAt)}</dd>
              <dt>Lab contact</dt>
              <dd>{pending.labContactName ?? "Hidden"}</dd>
              <dt>Lab reference</dt>
              <dd className="wx-data-md">{pending.labReference ?? "Hidden"}</dd>
            </dl>
            {selfFiled ? (
              <InlineAlert tone="info">
                You filed this request, so a colleague has to co-sign it.
              </InlineAlert>
            ) : null}
            <div className="wx-drawer-actions">
              {canCosign && !selfFiled ? (
                <Button loading={busy} disabled={busy} onClick={() => void cosign(pending.id)}>
                  Co-sign re-dispatch
                </Button>
              ) : null}
              {canRecover ? (
                <Button tone="secondary" disabled={busy} onClick={() => void cancel(pending.id)}>
                  Cancel request
                </Button>
              ) : null}
            </div>
          </section>
        ) : canRecover ? (
          <AttestationForm
            draft={draft}
            errors={errors}
            busy={busy}
            onChange={setDraft}
            onSubmit={() => void attest()}
          />
        ) : (
          <InlineAlert tone="info">
            Recovering a held transmission needs orders.transmission.recover. Ask a supervisor.
          </InlineAlert>
        )}

        {notice ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}

        {detail && detail.transmissionAttestations.length > 0 ? (
          <section className="wx-drawer-card">
            <h3>Prior attestations</h3>
            <dl className="wx-kv">
              {detail.transmissionAttestations.map((a) => (
                <div key={a.id}>
                  <dt>{dateTime(a.createdAt)}</dt>
                  <dd>
                    {a.attestation === "received_by_lab" ? "Lab had it" : "Lab did not have it"} ·{" "}
                    {a.outcome === "redispatched" ? "re-sent" : "marked transmitted"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function AttestationForm({
  draft,
  errors,
  busy,
  onChange,
  onSubmit,
}: {
  draft: EvidenceDraft;
  errors: EvidenceErrors;
  busy: boolean;
  onChange: (next: EvidenceDraft) => void;
  onSubmit: () => void;
}): JSX.Element {
  const pick = (attestation: Attestation) => onChange({ ...draft, attestation });
  return (
    <section className="wx-drawer-card">
      <h3>Attested recovery</h3>
      <p className="wx-row-sub">
        Call the lab first. A wrong answer either orders the test twice or hides an order the lab
        never got.
      </p>
      <fieldset className="wx-segmented" aria-label="What the lab told you">
        <Button
          size="sm"
          tone={draft.attestation === "not_received_by_lab" ? "primary" : "secondary"}
          aria-pressed={draft.attestation === "not_received_by_lab"}
          onClick={() => pick("not_received_by_lab")}
        >
          Lab did not receive it
        </Button>
        <Button
          size="sm"
          tone={draft.attestation === "received_by_lab" ? "primary" : "secondary"}
          aria-pressed={draft.attestation === "received_by_lab"}
          onClick={() => pick("received_by_lab")}
        >
          Lab already has it
        </Button>
      </fieldset>
      <p className="wx-source-line">
        {draft.attestation === "received_by_lab"
          ? "Marks the order transmitted. Nothing is sent."
          : draft.attestation === "not_received_by_lab"
            ? "Files a request a different person must co-sign; then the order is re-sent once."
            : "Choose what the lab confirmed."}
      </p>
      <TextField
        label="Lab contact name"
        value={draft.contactName}
        error={errors.contactName}
        hint="The person at the lab you spoke to. Never a patient name."
        onChange={(e) => onChange({ ...draft, contactName: e.target.value })}
      />
      <TextField
        label="Lab reference"
        value={draft.labReference}
        error={errors.labReference}
        hint="The lab's own ticket or confirmation number. Never an MRN or accession."
        onChange={(e) => onChange({ ...draft, labReference: e.target.value })}
      />
      <p className="wx-source-line">
        <Glyph name="lock" size={12} /> Requires a fresh step-up. Recorded with who and when.
      </p>
      <Button loading={busy} disabled={busy} onClick={onSubmit}>
        Record attestation
      </Button>
    </section>
  );
}
