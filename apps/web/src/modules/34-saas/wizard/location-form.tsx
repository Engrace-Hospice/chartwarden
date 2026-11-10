// apps/web/src/modules/34-saas/wizard — the form that creates a service location under one of the organization's provider entities,
// shared by the wizard's step 6 and the Agency setup screen. POST /api/v1/locations (`org.manage`). One Idempotency-Key per attempt, so a
// double submit or a retry after no answer never creates the location twice.
import {
  Button,
  InlineAlert,
  SelectField,
  TextField,
  stashStepUpMemoryDraft,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { FailureNotice } from "./failure-notice";
import { useOpsWrite } from "./use-ops-write";

export interface EntityOption {
  readonly id: string;
  readonly legalName: string;
}

const STATE_SHAPE = /^[A-Z]{2}$/;
const ZIP_SHAPE = /^\d{5}(-\d{4})?$/;
const EMPTY_LOCATION = {
  providerEntityId: "",
  name: "",
  addressLine1: "",
  city: "",
  state: "",
  postalCode: "",
  timezone: "",
};

/** What a Re-verify keeps of the form. */
const DRAFT_KEY = "wizard:location:new";

export function LocationForm({
  entities,
  onCreated,
}: {
  entities: readonly EntityOption[];
  /** Called once the location is saved (the host reloads its list). */
  onCreated: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const restored = useStepUpMemoryDraft<typeof EMPTY_LOCATION>(DRAFT_KEY);
  const [form, setForm] = useState({ ...EMPTY_LOCATION, ...restored });
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const noEntities = entities.length === 0;
  const providerEntityId = form.providerEntityId || entities[0]?.id || "";

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (noEntities) return;
    const name = form.name.trim();
    const addressLine1 = form.addressLine1.trim();
    const city = form.city.trim();
    const timezone = form.timezone.trim();
    const state = form.state.trim().toUpperCase();
    const postalCode = form.postalCode.trim();
    if (!name || !addressLine1 || !city || !timezone)
      return setError("Enter the location name, address, city and time zone.");
    if (!STATE_SHAPE.test(state)) return setError("The state is a 2-letter code, e.g. CA.");
    if (!ZIP_SHAPE.test(postalCode)) return setError("The ZIP code is 5 digits (or ZIP+4).");
    setError(null);
    const body = { providerEntityId, name, addressLine1, city, state, postalCode, timezone };
    const outcome = await write.run(
      JSON.stringify(body),
      (key) => client.POST("/api/v1/locations", { body, headers: { "Idempotency-Key": key } }),
      onCreated,
    );
    if (outcome.ok)
      setForm((f) => ({ ...EMPTY_LOCATION, providerEntityId: f.providerEntityId, timezone }));
  }

  return (
    <form className="wx-form-stack" onSubmit={(e) => void submit(e)}>
      <SelectField
        label="Provider entity"
        value={providerEntityId}
        disabled={noEntities}
        onChange={(e) => set("providerEntityId")(e.target.value)}
        options={entities.map((p) => ({ value: p.id, label: p.legalName }))}
      />
      <TextField
        label="Location name"
        value={form.name}
        onChange={(e) => set("name")(e.target.value)}
        error={write.failure?.fieldErrors.name}
      />
      <TextField
        label="Address line 1"
        value={form.addressLine1}
        onChange={(e) => set("addressLine1")(e.target.value)}
        error={write.failure?.fieldErrors.addressLine1}
      />
      <TextField
        label="City"
        value={form.city}
        onChange={(e) => set("city")(e.target.value)}
        error={write.failure?.fieldErrors.city}
      />
      <TextField
        label="State"
        hint="2-letter code."
        value={form.state}
        onChange={(e) => set("state")(e.target.value)}
        error={write.failure?.fieldErrors.state}
      />
      <TextField
        label="ZIP code"
        value={form.postalCode}
        onChange={(e) => set("postalCode")(e.target.value)}
        error={write.failure?.fieldErrors.postalCode}
      />
      <TextField
        label="Time zone"
        hint="IANA zone, e.g. America/Los_Angeles."
        value={form.timezone}
        onChange={(e) => set("timezone")(e.target.value)}
        error={write.failure?.fieldErrors.timezone}
      />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {!error && write.failure ? (
        <FailureNotice
          failure={write.failure}
          onReverify={() => stashStepUpMemoryDraft(DRAFT_KEY, form)}
        />
      ) : null}
      <Button type="submit" disabled={write.busy || noEntities}>
        {write.busy ? "Adding…" : "Add location"}
      </Button>
    </form>
  );
}
