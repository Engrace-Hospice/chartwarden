import { TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the per-MAC TPE exit thresholds (hospice ADR/TPE/QIC PRD, milestone 5), modelled
// on the ADR window rules. NO threshold is built in: the figures commonly quoted for each MAC are unverified, so this
// organization records the number from its MAC's TPE letter, with the source and the day it was verified. Until it
// does, the tracker says "No threshold confirmed" instead of assuming one.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { ActionModal, ErrorAlert, FormButtons, Hint } from "./action-ui";
import { type TpeRulesPage, loadTpeRules, saveTpeRule } from "./tpe-api";

export function TpeRulesModal({
  onClose,
  onSaved,
}: {
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [rules, setRules] = useState<TpeRulesPage["items"]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [macName, setMacName] = useState("");
  const [pct, setPct] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [verifiedOn, setVerifiedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const res = await loadTpeRules(client);
    if (res.ok) {
      setRules(res.value.items);
      setLoadError(null);
      setLoaded(true);
    } else {
      setLoadError(res.message);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rate = pct.trim() === "" ? Number.NaN : Number(pct);
  const blocked = macName.trim() === "" || !(rate >= 0 && rate <= 100);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    // Saving over today's rule for the same MAC is an update: send the version we read so a concurrent edit is a
    // 409 instead of a silent overwrite. A new MAC or day is a create and needs none.
    const today = new Date().toISOString().slice(0, 10);
    const existing = rules.find(
      (x) =>
        x.macName.trim().toLowerCase() === macName.trim().toLowerCase() &&
        x.effectiveFrom === today,
    );
    const res = await saveTpeRule(
      client,
      {
        macName: macName.trim(),
        exitErrorRatePct: rate,
        ...(sourceNote.trim() ? { sourceNote: sourceNote.trim() } : {}),
        ...(verifiedOn ? { verifiedOn } : {}),
      },
      existing?.version,
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      // The rule moved under us: show the message, and refresh the list so the next save carries the new version.
      if (res.code === "VERSION_CONFLICT") await reload();
      return;
    }
    setMacName("");
    setPct("");
    setSourceNote("");
    setVerifiedOn("");
    await reload();
    onSaved();
  }

  return (
    <ActionModal ariaLabel="TPE exit thresholds" onClose={onClose} width="42rem">
      <ErrorAlert message={loadError} />
      {!loaded && !loadError ? (
        <Hint>Loading thresholds…</Hint>
      ) : rules.length === 0 && !loadError ? (
        <Hint>
          No thresholds yet. Programs show "No threshold confirmed" until you enter one from your
          MAC's TPE letter.
        </Hint>
      ) : loadError ? null : (
        <table className="wx-table">
          <thead>
            <tr>
              <th>MAC</th>
              <th>Exit rate</th>
              <th>Effective</th>
              <th>Verified</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.macName}</td>
                <td>{r.exitErrorRatePct}%</td>
                <td>{r.effectiveFrom}</td>
                <td>{r.verifiedOn ?? "Unverified"}</td>
                <td>{r.sourceNote ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="wx-action-title">Add or update a threshold</h3>
      <TextField
        label="MAC"
        value={macName}
        onChange={(e) => setMacName(e.target.value)}
        maxLength={120}
      />
      <TextField
        label="Exit error rate (%)"
        type="number"
        value={pct}
        onChange={(e) => setPct(e.target.value)}
      />
      <TextField
        label="Source (MAC letter, web page)"
        value={sourceNote}
        onChange={(e) => setSourceNote(e.target.value)}
        maxLength={500}
      />
      <TextField
        label="Verified on (leave blank if unconfirmed)"
        type="date"
        value={verifiedOn}
        onChange={(e) => setVerifiedOn(e.target.value)}
      />
      <Hint>
        Whether your MAC counts the rate by claims or by dollars, and whether a rate equal to the
        threshold passes, is unconfirmed. The rate and result in each results letter stay the
        official values.
      </Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Save threshold"
        busy={busy}
        blocked={blocked}
        onSubmit={() => void save()}
        onCancel={onClose}
      />
    </ActionModal>
  );
}
