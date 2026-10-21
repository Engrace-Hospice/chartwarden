import { Button, Modal, SelectField, TextAreaField, t, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/07-care-plan — the §2 version-lifecycle ceremonies (#91).
//
// A care plan is not a document you edit forever; it is a chain of VERSIONS, each finalized and then
// signed by an interdisciplinary quorum. 42 CFR 418.56(d) requires the IDG to review and update the
// plan at least every 15 days, and 418.56(b) makes the signed plan the predicate for the care itself.
// The module could show that chain and could not advance it: no way to open a revision, close a draft
// for signature, sign one, or send one back.
//
// WHAT THE SERVER OWNS:
//   • WHO may sign as what. `SIGNER_MATCH` matches the requested `signerRole` against the caller's own
//     grants; this modal offers the caller's roles narrowed to the signer vocabulary, which is an
//     intersection rather than a derivation — the same rule `discipline-derivation.test.ts` pins.
//   • WHETHER the quorum is met, and therefore whether the version becomes active. The rail shows the
//     slots as the server published them; it does not compute the verdict.
//   • The §7.7 version check — every ceremony here quotes the version it read.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSession } from "../../shell/session";
import {
  type SignerRole,
  type VersionKind,
  type WriteResult,
  createVersion,
  finalizeVersion,
  returnToDraft,
  signVersion,
} from "./care-plan-api";

/** The §2 version kinds. `idg_review` is the 15-day CoP cadence; `interim_revision` is a change between. */
const VERSION_KINDS: readonly VersionKind[] = [
  "initial",
  "idg_review",
  "interim_revision",
  "discharge",
];

/** The §2 signer vocabulary, as M3 role keys — the same strings a caller's session carries. */
const SIGNER_ROLES: readonly SignerRole[] = [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
];

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const LABEL: Record<string, string> = {
  rn_case_manager: "RN case manager",
  msw: "Social worker",
  idg_review: "IDG review (15-day)",
  interim_revision: "Interim revision",
};
const label = (k: string): string => LABEL[k] ?? humanize(k);

export type VersionAction = "revise" | "finalize" | "sign" | "return-to-draft";

const TITLE: Record<VersionAction, string> = {
  revise: "Open a new version",
  finalize: "Close draft for signature",
  sign: "Sign care plan",
  "return-to-draft": "Return to draft",
};

export interface CarePlanVersionModalProps {
  readonly open: boolean;
  readonly action: VersionAction;
  readonly planId: string;
  /** The version being acted on, with the `version` token the server checks. Null for `revise`. */
  readonly version?: {
    readonly id: string;
    readonly sequence: number;
    readonly version: number;
  } | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function CarePlanVersionModal({
  open,
  action,
  planId,
  version = null,
  onClose,
  onDone,
}: CarePlanVersionModalProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<VersionKind>("idg_review");
  const [signerRole, setSignerRole] = useState("");
  const [understanding, setUnderstanding] = useState("");

  // The caller's OWN roles narrowed to the signer vocabulary. NOT a check that they may sign — the
  // server's `SIGNER_MATCH` owns that — but which slot this signature is being offered against.
  const signerRoles = useMemo(() => {
    const held = new Set(session?.roles ?? []);
    return SIGNER_ROLES.filter((r) => held.has(r));
  }, [session]);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setKind("idg_review");
    setSignerRole(signerRoles.length === 1 ? (signerRoles[0] as string) : "");
    setUnderstanding("");
  }, [open, signerRoles]);

  if (!open) return null;

  const blocked = action === "sign" && signerRole === "";

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let res: WriteResult<unknown>;
    switch (action) {
      case "revise":
        res = await createVersion(client, planId, { kind });
        break;
      case "finalize":
        res = await finalizeVersion(client, planId, version?.id ?? "", {
          ifVersion: version?.version ?? 0,
        });
        break;
      case "sign":
        res = await signVersion(client, planId, version?.id ?? "", {
          ifVersion: version?.version ?? 0,
          signerRole: signerRole as SignerRole,
          ...(understanding.trim() !== ""
            ? { patientUnderstandingText: understanding.trim() }
            : {}),
        });
        break;
      case "return-to-draft":
        res = await returnToDraft(client, planId, version?.id ?? "", version?.version ?? 0);
        break;
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={TITLE[action]}
      width="30rem"
      accent={action === "return-to-draft" ? t.alert : t.primary}
    >
      <div style={body}>
        <h2 style={heading}>{TITLE[action]}</h2>

        {action === "revise" ? (
          <>
            <SelectField
              label="Reason for the new version"
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as VersionKind)}
              options={VERSION_KINDS.map((k) => ({ value: k, label: label(k) }))}
            />
            <p style={meta}>
              The IDG must review and update the plan at least every 15 days (42 CFR 418.56(d)). A
              new version starts as a draft; the active plan stays in force until this one is
              signed.
            </p>
          </>
        ) : null}

        {action === "finalize" ? (
          <p style={meta}>
            Closing v{version?.sequence} for signature stops further editing and opens the signature
            slots. The plan does not become active until the required quorum has signed.
          </p>
        ) : null}

        {action === "sign" ? (
          <>
            {signerRoles.length === 0 ? (
              // Not a permission verdict — the server still owns that. This says the SIGNATURE cannot
              // be attributed, because none of the caller's roles is a care-plan signer role at all.
              <p style={meta}>
                None of your roles is a care-plan signer role, so this signature cannot be
                attributed. Ask an administrator to review your role grants.
              </p>
            ) : (
              <SelectField
                label="Signing as"
                value={signerRole}
                disabled={busy}
                onChange={(e) => setSignerRole(e.target.value)}
                options={[
                  ...(signerRoles.length > 1 ? [{ value: "", label: "Select a role…" }] : []),
                  ...signerRoles.map((r) => ({ value: r, label: label(r) })),
                ]}
              />
            )}
            <TextAreaField
              label="Patient / family understanding (optional)"
              value={understanding}
              disabled={busy}
              rows={3}
              onChange={(e) => setUnderstanding(e.target.value)}
            />
            <p style={meta}>
              Patient and family participation in the plan is a CoP requirement (§418.56(a)); what
              is recorded here is what was discussed, in the words used.
            </p>
          </>
        ) : null}

        {action === "return-to-draft" ? (
          <p style={meta}>
            Reopening v{version?.sequence} discards the signatures already collected on it —
            everyone who signed will need to sign again after the change.
          </p>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={action === "return-to-draft" ? "danger" : "primary"}
            onClick={submit}
            disabled={busy || blocked}
          >
            {busy ? "Working…" : action === "sign" ? "Sign" : "Confirm"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
};
const heading: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
