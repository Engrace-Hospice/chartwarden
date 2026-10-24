import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  SelectField,
  StatusPill,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — PAYER APPEAL PATHS (milestone 12a-1): the commercial and Medicare Advantage payers'
// appeal levels exactly as YOUR organization's contract or the payer's denial notice states them. NOTHING is built in: no
// payer, level, window or form ships with ChartWarden, so until a path is written a payer reads "No appeal path recorded".
// A path is written as a draft with the source it came from, then a SECOND person checks it against that source and
// activates it (the author cannot); an active path is frozen, and a change is a new version. Cases keep the path revision
// they were opened under, so editing a path never moves a deadline already shown. A failed refresh keeps the list on
// screen with a Retry; an older response never replaces a newer one.
import { useCallback, useId, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import {
  ActionModal,
  BlockedReason,
  ButtonRow,
  ErrorAlert,
  FormButtons,
  Hint,
  PhiNotice,
  RetryAlert,
  WarningAlert,
} from "./action-ui";
import {
  ANCHOR_KINDS,
  DAY_BASES,
  LEVEL_KINDS,
  PAYER_PROGRAMS,
  type PayerPath,
  type PayerPathLevelInput,
  ROLLS,
  WHO_FILES,
  createPayerPath,
  loadPayerPaths,
  retirePayerPath,
  verifyPayerPath,
} from "./payer-appeal-api";
import { humanize } from "./remittance-status";
import { useGuardedLoad } from "./use-guarded-load";

export const NO_PATHS_PROMPT =
  "No appeal path recorded - add it from your contract or the payer's denial notice";

interface LevelDraft {
  levelKind: string;
  levelLabel: string;
  whoFiles: string;
  filingWindowDays: string;
  anchorKind: string;
  receiptPresumptionDays: string;
  dayBasis: string;
  roll: string;
  decisionDays: string;
  sourceNote: string;
}

const emptyLevel = (): LevelDraft => ({
  levelKind: "internal",
  levelLabel: "",
  whoFiles: "unknown",
  filingWindowDays: "",
  anchorKind: "",
  receiptPresumptionDays: "",
  dayBasis: "",
  roll: "",
  decisionDays: "",
  sourceNote: "",
});

const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

function toLevelInput(d: LevelDraft): PayerPathLevelInput {
  return {
    levelKind: d.levelKind as PayerPathLevelInput["levelKind"],
    levelLabel: d.levelLabel.trim(),
    whoFiles: d.whoFiles as PayerPathLevelInput["whoFiles"],
    filingWindowDays: num(d.filingWindowDays),
    anchorKind: (d.anchorKind || null) as PayerPathLevelInput["anchorKind"],
    receiptPresumptionDays: num(d.receiptPresumptionDays),
    dayBasis: (d.dayBasis || null) as PayerPathLevelInput["dayBasis"],
    roll: (d.roll || null) as PayerPathLevelInput["roll"],
    decisionDays: num(d.decisionDays),
    sourceNote: d.sourceNote.trim(),
  };
}

const opts = (values: readonly string[], blank?: string) => [
  ...(blank === undefined ? [] : [{ value: "", label: blank }]),
  ...values.map((v) => ({ value: v, label: humanize(v) })),
];

/** "Required." appears only once the field was left (blur) or a save was attempted, never on a fresh form. */
const requiredError = (value: string, shown: boolean): string | undefined =>
  shown && value.trim() === "" ? "Required." : undefined;

function LevelFields(props: {
  readonly index: number;
  readonly draft: LevelDraft;
  readonly attempted: boolean;
  readonly onChange: (next: LevelDraft) => void;
  readonly onRemove: (() => void) | null;
}): JSX.Element {
  const { draft: d, index } = props;
  const [touched, setTouched] = useState({ label: false, note: false });
  const set = (patch: Partial<LevelDraft>): void => props.onChange({ ...d, ...patch });
  const windowStated = [d.filingWindowDays, d.anchorKind, d.dayBasis].some((v) => v !== "");
  return (
    <fieldset className="wx-action-fieldset">
      <legend>Level {index + 1}</legend>
      <TextField
        label="Level (as the contract names it)"
        required
        value={d.levelLabel}
        onChange={(e) => set({ levelLabel: e.target.value })}
        onBlur={() => setTouched({ ...touched, label: true })}
        error={requiredError(d.levelLabel, touched.label || props.attempted)}
        maxLength={120}
      />
      <SelectField
        label="Kind"
        value={d.levelKind}
        onChange={(e) => set({ levelKind: e.target.value })}
        options={opts(LEVEL_KINDS)}
      />
      <SelectField
        label="Who files"
        value={d.whoFiles}
        onChange={(e) => set({ whoFiles: e.target.value })}
        options={opts(WHO_FILES)}
      />
      <Hint>
        The filing window is optional. Enter all of days, anchor and day basis from the contract, or
        leave all three empty and no deadline will be computed for this level.
      </Hint>
      <TextField
        label="Filing window (days)"
        type="number"
        value={d.filingWindowDays}
        onChange={(e) => set({ filingWindowDays: e.target.value })}
      />
      <SelectField
        label="Window runs from"
        value={d.anchorKind}
        onChange={(e) => set({ anchorKind: e.target.value })}
        options={opts(ANCHOR_KINDS, "Not stated")}
      />
      <SelectField
        label="Day basis"
        value={d.dayBasis}
        onChange={(e) =>
          set({
            dayBasis: e.target.value,
            roll: e.target.value === "business_us_federal" ? d.roll : "",
          })
        }
        options={opts(DAY_BASES, "Not stated")}
      />
      {d.dayBasis === "business_us_federal" ? (
        <SelectField
          label="When the last day is not a business day"
          required
          value={d.roll}
          onChange={(e) => set({ roll: e.target.value })}
          options={opts(ROLLS, "Choose...")}
        />
      ) : null}
      {windowStated ? (
        <TextField
          label="Receipt presumed after (days; leave empty if the contract states none)"
          type="number"
          value={d.receiptPresumptionDays}
          onChange={(e) => set({ receiptPresumptionDays: e.target.value })}
        />
      ) : null}
      <TextField
        label="Payer decision days (informational, optional)"
        type="number"
        value={d.decisionDays}
        onChange={(e) => set({ decisionDays: e.target.value })}
      />
      <TextField
        label="Where this level came from (page, section, notice)"
        required
        value={d.sourceNote}
        onChange={(e) => set({ sourceNote: e.target.value })}
        onBlur={() => setTouched({ ...touched, note: true })}
        error={requiredError(d.sourceNote, touched.note || props.attempted)}
        maxLength={500}
      />
      {props.onRemove ? (
        <Button size="sm" tone="tertiary" onClick={props.onRemove}>
          Remove level {index + 1}
        </Button>
      ) : null}
    </fieldset>
  );
}

function levelBlocker(d: LevelDraft): string | null {
  if (d.levelLabel.trim() === "") return "Name every level.";
  if (d.sourceNote.trim() === "") return "Say where every level came from.";
  const stated = [d.filingWindowDays, d.anchorKind, d.dayBasis].filter((v) => v !== "").length;
  if (stated > 0 && stated < 3) {
    return "A filing window needs its days, anchor and day basis together.";
  }
  if (d.dayBasis === "business_us_federal" && d.roll === "") return "Choose the roll direction.";
  return null;
}

function PathModal(props: {
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [payerId, setPayerId] = useState("");
  const [program, setProgram] = useState("commercial");
  const [contractLabel, setContractLabel] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);
  const [levels, setLevels] = useState<LevelDraft[]>([emptyLevel()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a save is tried while something is missing: every missing field then shows "Required.".
  const [attempted, setAttempted] = useState(false);

  const blockedReason =
    payerId === ""
      ? "Choose the payer."
      : effectiveFrom === ""
        ? "Enter the date this path takes effect."
        : sourceNote.trim() === ""
          ? "Say where this path came from (the contract or notice)."
          : (levels.map(levelBlocker).find((m) => m !== null) ?? null);

  async function save(): Promise<void> {
    if (blockedReason !== null) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await createPayerPath(client, {
      payerId,
      program: program as "commercial" | "medicare_advantage",
      ...(contractLabel.trim() ? { contractLabel: contractLabel.trim() } : {}),
      effectiveFrom,
      sourceNote: sourceNote.trim(),
      levels: levels.map(toLevelInput),
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    await props.onSaved();
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!busy) void save();
  }

  return (
    <ActionModal ariaLabel="Write a payer appeal path" onClose={props.onClose} width="44rem">
      <form aria-label="Write a payer appeal path" onSubmit={submit} noValidate>
        <MdmEntityLookupField kind="payer" label="Payer" value={payerId} onChange={setPayerId} />
        <SelectField
          label="Program"
          value={program}
          onChange={(e) => setProgram(e.target.value)}
          options={opts(PAYER_PROGRAMS)}
        />
        <TextField
          label="Contract (optional, to tell two contracts with one payer apart)"
          value={contractLabel}
          onChange={(e) => setContractLabel(e.target.value)}
          maxLength={120}
        />
        <TextField
          label="Takes effect on"
          type="date"
          required
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
        <TextField
          label="Where this path came from (contract, manual page, notice)"
          required
          value={sourceNote}
          onChange={(e) => setSourceNote(e.target.value)}
          onBlur={() => setNoteTouched(true)}
          error={requiredError(sourceNote, noteTouched || attempted)}
          maxLength={500}
        />
        {levels.map((d, i) => (
          <LevelFields
            // biome-ignore lint/suspicious/noArrayIndexKey: the drafts have no id and are only appended or popped
            key={i}
            index={i}
            draft={d}
            attempted={attempted}
            onChange={(next) => setLevels(levels.map((x, j) => (j === i ? next : x)))}
            onRemove={
              levels.length > 1 && i === levels.length - 1
                ? () => setLevels(levels.slice(0, -1))
                : null
            }
          />
        ))}
        <ButtonRow>
          <Button size="sm" tone="secondary" onClick={() => setLevels([...levels, emptyLevel()])}>
            Add a level
          </Button>
        </ButtonRow>
        <PhiNotice />
        <Hint>
          The path is saved as a draft. A second person checks it against the source and activates
          it.
        </Hint>
        <ErrorAlert message={error} />
        <FormButtons
          submitLabel="Save draft path"
          busy={busy}
          blocked={blockedReason !== null}
          blockedReason={blockedReason ?? undefined}
          onSubmit={() => void save()}
          onCancel={props.onClose}
        />
      </form>
    </ActionModal>
  );
}

function windowText(l: PayerPath["levels"][number]): string {
  if (l.filingWindowDays === null) return "no filing window recorded";
  const presumed =
    l.receiptPresumptionDays !== null
      ? `, receipt presumed after ${l.receiptPresumptionDays} days`
      : "";
  return `${l.filingWindowDays} days from ${humanize(l.anchorKind)}, ${humanize(l.dayBasis)}${l.roll ? ` (${humanize(l.roll)})` : ""}${presumed}`;
}

function PathRow(props: {
  readonly path: PayerPath;
  readonly canManage: boolean;
  readonly canVerify: boolean;
  readonly myMembershipId: string | undefined;
  /** Re-reads the list and resolves once it landed. */
  readonly onChanged: () => Promise<void>;
}): JSX.Element {
  const { path: p } = props;
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAuthor =
    props.myMembershipId !== undefined && props.myMembershipId === p.authoredByMembershipId;

  async function run(kind: "verify" | "retire"): Promise<void> {
    setBusy(true);
    setError(null);
    const res =
      kind === "verify" ? await verifyPayerPath(client, p) : await retirePayerPath(client, p);
    // Busy stays set until the list has been read again, so a second click cannot reuse the old version.
    if (res.ok || res.status === 409) await props.onChanged();
    setBusy(false);
    if (!res.ok) setError(res.message);
  }

  return (
    <section aria-label={`Path for ${p.payerName}`}>
      <h2 className="wx-action-title">
        {p.payerName} · {humanize(p.program)}
        {p.contractLabel ? ` · ${p.contractLabel}` : ""}{" "}
        <StatusPill
          label={p.status === "active" ? "Verified" : humanize(p.status)}
          tone={p.status === "active" ? "success" : p.status === "draft" ? "warning" : "neutral"}
        />
      </h2>
      <p className="wx-action-hint">
        Effective {p.effectiveFrom} · revision {p.revision} · source: {p.sourceNote}
        {p.verifiedOn ? ` · verified ${p.verifiedOn}` : " · not verified"}
      </p>
      <ol className="wx-action-hint wx-action-list">
        {p.levels.map((l) => (
          <li key={l.id}>
            {l.levelLabel} · {humanize(l.levelKind)} · files: {humanize(l.whoFiles)} ·{" "}
            {windowText(l)}
          </li>
        ))}
      </ol>
      {p.status === "draft" && isAuthor ? (
        <Hint>You wrote this path; a second person must verify it.</Hint>
      ) : null}
      <ButtonRow>
        {p.status === "draft" && props.canVerify && !isAuthor ? (
          <Button size="sm" disabled={busy} onClick={() => void run("verify")}>
            Verify and activate
          </Button>
        ) : null}
        {p.status !== "retired" && props.canManage ? (
          <Button size="sm" tone="tertiary" disabled={busy} onClick={() => void run("retire")}>
            Retire
          </Button>
        ) : null}
      </ButtonRow>
      <ErrorAlert message={error} />
    </section>
  );
}

export function PayerAppealPaths(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const has = (key: string): boolean => session?.permissions?.includes(key) ?? false;
  const fetcher = useCallback(() => loadPayerPaths(client), [client]);
  const { data, error, load } = useGuardedLoad(fetcher);
  const [adding, setAdding] = useState(false);
  const addId = useId();
  const paths = data?.items ?? null;
  const reload = useRef(load);
  reload.current = load;

  return (
    <>
      <PageHeader title="Payer Appeal Paths" breadcrumb="Revenue Cycle — Payer Appeal Paths">
        <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
          The appeal levels for each commercial or Medicare Advantage payer, as your contract or the
          payer's notice states them. Nothing is built in. This is not legal advice.
        </div>
      </PageHeader>
      <div style={{ padding: "0 1.5rem 1.5rem", display: "grid", gap: "1rem" }}>
        {error ? (
          <RetryAlert
            message={
              paths === null
                ? `Payer appeal paths unavailable: ${error}`
                : `Payer appeal paths could not be refreshed: ${error}`
            }
            onRetry={() => void load()}
          />
        ) : null}
        {has("payer_appeal_path.manage") ? (
          <ButtonRow>
            <Button size="sm" id={addId} onClick={() => setAdding(true)}>
              Write a path
            </Button>
          </ButtonRow>
        ) : null}
        {paths === null && !error ? <LoadingSpinner /> : null}
        {paths !== null && paths.length === 0 ? (
          <EmptyState title="No appeal paths" description={NO_PATHS_PROMPT} />
        ) : null}
        {paths?.some((p) => p.status === "draft") ? (
          <WarningAlert>
            A draft path is shown as awaiting verification: no deadline is computed from it until a
            second person verifies it.
          </WarningAlert>
        ) : null}
        {(paths ?? []).map((p) => (
          <PathRow
            key={p.id}
            path={p}
            canManage={has("payer_appeal_path.manage")}
            canVerify={has("payer_appeal_path.verify")}
            myMembershipId={session?.membershipId}
            onChanged={() => reload.current()}
          />
        ))}
      </div>
      {adding ? (
        <PathModal
          onClose={() => setAdding(false)}
          onSaved={async () => {
            await reload.current();
            setAdding(false);
          }}
        />
      ) : null}
    </>
  );
}
