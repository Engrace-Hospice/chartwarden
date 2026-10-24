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
// they were opened under, so editing a path never moves a deadline already shown.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { MdmEntityLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { ActionModal, ButtonRow, ErrorAlert, FormButtons, Hint, PhiNotice, WarningAlert } from "./action-ui";
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

function LevelFields(props: {
  readonly index: number;
  readonly draft: LevelDraft;
  readonly onChange: (next: LevelDraft) => void;
  readonly onRemove: (() => void) | null;
}): JSX.Element {
  const { draft: d, index } = props;
  const set = (patch: Partial<LevelDraft>): void => props.onChange({ ...d, ...patch });
  const windowStated = [d.filingWindowDays, d.anchorKind, d.dayBasis].some((v) => v !== "");
  return (
    <fieldset className="wx-action-fieldset">
      <legend>Level {index + 1}</legend>
      <TextField
        label="Level (as the contract names it)"
        value={d.levelLabel}
        onChange={(e) => set({ levelLabel: e.target.value })}
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
        onChange={(e) => set({ dayBasis: e.target.value, roll: e.target.value === "business_us_federal" ? d.roll : "" })}
        options={opts(DAY_BASES, "Not stated")}
      />
      {d.dayBasis === "business_us_federal" ? (
        <SelectField
          label="When the last day is not a business day"
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
        value={d.sourceNote}
        onChange={(e) => set({ sourceNote: e.target.value })}
        maxLength={500}
        error={d.sourceNote.trim() === "" ? "Required." : undefined}
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
  if (stated > 0 && stated < 3) return "A filing window needs its days, anchor and day basis together.";
  if (d.dayBasis === "business_us_federal" && d.roll === "") return "Choose the roll direction.";
  return null;
}

function PathModal(props: { readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const client = useApiClient();
  const [payerId, setPayerId] = useState("");
  const [program, setProgram] = useState("commercial");
  const [contractLabel, setContractLabel] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [levels, setLevels] = useState<LevelDraft[]>([emptyLevel()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blockedReason =
    payerId === ""
      ? "Choose the payer."
      : effectiveFrom === ""
        ? "Enter the date this path takes effect."
        : sourceNote.trim() === ""
          ? "Say where this path came from (the contract or notice)."
          : (levels.map(levelBlocker).find((m) => m !== null) ?? null);

  async function save(): Promise<void> {
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
    setBusy(false);
    if (!res.ok) setError(res.message);
    else props.onSaved();
  }

  return (
    <ActionModal ariaLabel="Write a payer appeal path" onClose={props.onClose} width="44rem">
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
        value={effectiveFrom}
        onChange={(e) => setEffectiveFrom(e.target.value)}
      />
      <TextField
        label="Where this path came from (contract, manual page, notice)"
        value={sourceNote}
        onChange={(e) => setSourceNote(e.target.value)}
        maxLength={500}
        error={sourceNote.trim() === "" ? "Required." : undefined}
      />
      {levels.map((d, i) => (
        <LevelFields
          // biome-ignore lint/suspicious/noArrayIndexKey: the drafts have no id and are only appended or popped
          key={i}
          index={i}
          draft={d}
          onChange={(next) => setLevels(levels.map((x, j) => (j === i ? next : x)))}
          onRemove={levels.length > 1 && i === levels.length - 1 ? () => setLevels(levels.slice(0, -1)) : null}
        />
      ))}
      <ButtonRow>
        <Button size="sm" tone="secondary" onClick={() => setLevels([...levels, emptyLevel()])}>
          Add a level
        </Button>
      </ButtonRow>
      <PhiNotice />
      <Hint>
        The path is saved as a draft. A second person checks it against the source and activates it.
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
    </ActionModal>
  );
}

function windowText(l: PayerPath["levels"][number]): string {
  if (l.filingWindowDays === null) return "no filing window recorded";
  return `${l.filingWindowDays} days from ${humanize(l.anchorKind)}, ${humanize(l.dayBasis)}${l.roll ? ` (${humanize(l.roll)})` : ""}${l.receiptPresumptionDays !== null ? `, receipt presumed after ${l.receiptPresumptionDays} days` : ""}`;
}

function PathRow(props: {
  readonly path: PayerPath;
  readonly canManage: boolean;
  readonly canVerify: boolean;
  readonly myMembershipId: string | undefined;
  readonly onChanged: () => void;
}): JSX.Element {
  const { path: p } = props;
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAuthor = props.myMembershipId !== undefined && props.myMembershipId === p.authoredByMembershipId;

  async function run(kind: "verify" | "retire"): Promise<void> {
    setBusy(true);
    setError(null);
    const res = kind === "verify" ? await verifyPayerPath(client, p) : await retirePayerPath(client, p);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      if (res.status === 409) props.onChanged();
    } else props.onChanged();
  }

  return (
    <section aria-label={`Path for ${p.payerName}`}>
      <h3 className="wx-action-title">
        {p.payerName} · {humanize(p.program)}
        {p.contractLabel ? ` · ${p.contractLabel}` : ""}{" "}
        <StatusPill
          label={p.status === "active" ? "Verified" : humanize(p.status)}
          tone={p.status === "active" ? "success" : p.status === "draft" ? "warning" : "neutral"}
        />
      </h3>
      <p className="wx-action-hint">
        Effective {p.effectiveFrom} · revision {p.revision} · source: {p.sourceNote}
        {p.verifiedOn ? ` · verified ${p.verifiedOn}` : " · not verified"}
      </p>
      <ol className="wx-action-hint wx-action-list">
        {p.levels.map((l) => (
          <li key={l.id}>
            {l.levelLabel} · {humanize(l.levelKind)} · files: {humanize(l.whoFiles)} · {windowText(l)}
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
  const [paths, setPaths] = useState<readonly PayerPath[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await loadPayerPaths(client);
    if (res.ok) {
      setPaths(res.value.items);
      setError(null);
    } else setError(res.message);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title="Payer Appeal Paths" breadcrumb="Revenue Cycle — Payer Appeal Paths">
        <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
          The appeal levels for each commercial or Medicare Advantage payer, as your contract or the
          payer's notice states them. Nothing is built in. This is not legal advice.
        </div>
      </PageHeader>
      <div style={{ padding: "0 1.5rem 1.5rem", display: "grid", gap: "1rem" }}>
        <ErrorAlert message={error} />
        {has("payer_appeal_path.manage") ? (
          <ButtonRow>
            <Button size="sm" onClick={() => setAdding(true)}>
              Write a path
            </Button>
          </ButtonRow>
        ) : null}
        {paths === null && !error ? <LoadingSpinner /> : null}
        {paths !== null && paths.length === 0 ? (
          <EmptyState
            title="No appeal paths"
            description={NO_PATHS_PROMPT}
            action={
              has("payer_appeal_path.manage") ? (
                <Button size="sm" onClick={() => setAdding(true)}>
                  Write a path
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {paths?.some((p) => p.status === "draft") ? (
          <WarningAlert>
            A draft path is used for new cases but every deadline it yields is marked "Window not
            verified" until a second person verifies it.
          </WarningAlert>
        ) : null}
        {(paths ?? []).map((p) => (
          <PathRow
            key={p.id}
            path={p}
            canManage={has("payer_appeal_path.manage")}
            canVerify={has("payer_appeal_path.verify")}
            myMembershipId={session?.membershipId}
            onChanged={() => void load()}
          />
        ))}
      </div>
      {adding ? (
        <PathModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
