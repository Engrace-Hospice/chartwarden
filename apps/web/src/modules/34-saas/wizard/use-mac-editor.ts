// apps/web/src/modules/34-saas/wizard — the state and the write of step 8's credential form. The client secret is write-only: it lives
// only in `secret`, is cleared the moment the write is sent (before the reloads, which can take seconds) or the form closes, and is never
// stashed. A replacement is pinned to the version the member read (If-Match, an integer); a first create carries none.
import {
  type OpsFailure,
  bodyFingerprint,
  isAboutAnInput,
  useApiClient,
  useEditorFocus,
  useOpsWrite,
} from "@chartwarden/ui";
import { useRef, useState } from "react";
import {
  DRAFT_ACTIONS,
  type DraftScope,
  draftKeyFor,
  stashDraft,
  useRestoredDraft,
} from "./billing-drafts";
import { BILLING_ERROR_COPY, MAC_ENTITY_FORBIDDEN, isStalePin } from "./billing-errors";
import { useServerFieldErrors } from "./billing-field-errors";
import {
  BLANK_MAC_FORM,
  JURISDICTIONS,
  type MacErrors,
  type MacForm,
  validateMac,
} from "./mac-credential-form";
import type { Credential } from "./mac-credential-table";
import type { PanelStatusControl } from "./panel-status";
import { useGuarded } from "./use-guarded";

const LIST = "/api/v1/billing/mac-credentials";
/** The fields the credential form renders (a refusal naming only others shows as a notice). */
const FIELDS: ReadonlySet<string> = new Set([
  "providerEntityId",
  "macJurisdiction",
  "submitterId",
  "tradingPartnerId",
  "clientId",
  "clientSecret",
  "baaRecordRef",
]);

interface Draft {
  readonly form: MacForm;
  /** The version the member read when the editor opened (null: a first credential). Sent from here, never re-read. */
  readonly pinnedVersion: number | null;
}

/** A refusal for a provider entity the member's role does not cover is said plainly, not as the generic "no access". */
export const forScope = (failure: OpsFailure | null): OpsFailure | null =>
  failure !== null && failure.kind === "forbidden"
    ? { ...failure, message: MAC_ENTITY_FORBIDDEN }
    : failure;

export function useMacEditor(args: {
  canWrite: boolean;
  stepKey: string;
  scope: DraftScope;
  announce: PanelStatusControl["announce"];
  /** The credential was saved: read the list and the wizard again. Never rejects. */
  onSaved: () => Promise<void>;
  /** A refusal showed the list had moved: the same reload, run for a refusal. */
  onMoved: () => Promise<void>;
}) {
  const { canWrite, stepKey, scope, announce, onSaved, onMoved } = args;
  const client = useApiClient();
  const write = useOpsWrite(BILLING_ERROR_COPY);
  const { guard, notice } = useGuarded();
  // Set before the asynchronous body digest begins: two submits in one tick must not both reach useOpsWrite.run.
  const submitting = useRef(false);
  const serverErrors = useServerFieldErrors(write.failure);
  const draftKey = draftKeyFor(scope, DRAFT_ACTIONS.macCredential, stepKey);
  const restored = useRestoredDraft<Draft>(draftKey, scope.returning);
  const [editing, setEditing] = useState<{ pinnedVersion: number | null } | null>(
    restored ? { pinnedVersion: restored.pinnedVersion } : null,
  );
  const [form, setForm] = useState<MacForm>(restored?.form ?? BLANK_MAC_FORM);
  const [secret, setSecret] = useState("");
  const [localErrors, setLocalErrors] = useState<MacErrors>({});
  const headingRef = useEditorFocus(editing !== null && canWrite, "mac");

  function open(existing: Credential | null, onlyEntityId: string | null): void {
    write.clear();
    announce(null); // a portal check shown for the credential as it was is stale once it is edited
    setLocalErrors({});
    setSecret("");
    setForm(
      existing
        ? {
            providerEntityId: existing.providerEntityId,
            macJurisdiction:
              JURISDICTIONS.find((j) => j.value === existing.macJurisdiction)?.value ??
              BLANK_MAC_FORM.macJurisdiction,
            submitterId: existing.submitterId,
            tradingPartnerId: existing.tradingPartnerId,
            clientId: existing.clientId,
            baaRecordRef: existing.baaRecordRef ?? "",
          }
        : { ...BLANK_MAC_FORM, providerEntityId: onlyEntityId ?? "" },
    );
    setEditing({ pinnedVersion: existing?.version ?? null });
  }

  function close(): void {
    setEditing(null);
    setSecret("");
  }

  async function save(): Promise<void> {
    if (!editing) return;
    write.clear();
    const found = validateMac(form, secret);
    setLocalErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = {
      providerEntityId: form.providerEntityId,
      macJurisdiction: form.macJurisdiction,
      submitterId: form.submitterId.trim(),
      tradingPartnerId: form.tradingPartnerId.trim(),
      clientId: form.clientId.trim(),
      clientSecret: secret,
      ...(form.baaRecordRef.trim() ? { baaRecordRef: form.baaRecordRef.trim() } : {}),
    };
    const pinned = editing.pinnedVersion;
    // a digest, not the body: the client secret is in it and is never held outside its input
    const fingerprint = `save:${pinned ?? "new"}:${await bodyFingerprint(body)}`;
    const outcome = await write.run(
      fingerprint,
      (key) =>
        client.POST(LIST, {
          body,
          params: {
            header: {
              "Idempotency-Key": key,
              ...(pinned !== null ? { "If-Match": String(pinned) } : {}),
            },
          },
        }),
      async () => {
        // The secret has been sent: it leaves this screen before the reloads, which can take seconds (or never end).
        close();
        announce({ tone: "success", text: "The MAC credential is saved." }, true);
        await onSaved();
      },
    );
    if (!outcome.ok && isStalePin(outcome.failure)) {
      // Changed since it was read (409 STALE_VERSION), or no pin was sent (428): the form's pin is stale, so it closes, the list and the
      // wizard are read again, and the member opens the form on what it says now and enters the secret again.
      close();
      await onMoved();
    } else if (!outcome.ok && outcome.failure.kind === "forbidden") {
      close(); // the role does not cover this provider entity: nothing the form can fix
    }
  }

  const failure = forScope(write.failure);
  async function saveOnce(): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await guard(save);
    } finally {
      submitting.current = false;
    }
  }
  return {
    editing,
    creating: editing !== null && editing.pinnedVersion === null,
    open,
    close: () => {
      close();
      write.clear();
    },
    form,
    change: (next: MacForm, field: keyof MacForm): void => {
      setForm(next);
      setLocalErrors((e) => ({ ...e, [field]: undefined }));
      serverErrors.touch(field);
    },
    secret,
    setSecret: (value: string) => {
      setSecret(value);
      setLocalErrors((e) => ({ ...e, clientSecret: undefined }));
      serverErrors.touch("clientSecret");
    },
    errors: { ...serverErrors.errors, ...localErrors } as MacErrors,
    save: saveOnce,
    busy: write.busy,
    headingRef,
    failure,
    failureBesideInput: failure !== null && isAboutAnInput(failure, (f) => FIELDS.has(f)),
    reverify: () =>
      stashDraft(draftKey, { form, pinnedVersion: editing?.pinnedVersion ?? null } satisfies Draft),
    notice,
  };
}
