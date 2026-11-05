// apps/admin/src/modules/34-saas-platform — the tenant subdomain field (ADR-0049 D3): a suggestion from the legal name
// until the operator edits it, a debounced availability probe (`GET /platform/tenant-slugs/:slug/availability`) and the
// inline verdict. The label rules run locally, so a malformed or reserved slug never costs a request. Kept apart from the
// drawer so the onboarding wizard can reuse it: `useSuggestedSlug` + `useSlugAvailability` + `<SlugField>` are the whole API.
import {
  type TenantSlugRejection,
  suggestTenantSlug,
  validateTenantSlug,
} from "@chartwarden/types";
import { TextField, useApiClient, useDebouncedValue } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

export const SLUG_CHECK_DEBOUNCE_MS = 300;
const SLUG_MAX_LENGTH = 63;

export const SLUG_MESSAGES: Record<TenantSlugRejection, string> = {
  format:
    "Use 3–63 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
  punycode: "A slug cannot start with “xn--”.",
  reserved: "That name is reserved. Choose another.",
};
const TAKEN_MESSAGE =
  "That subdomain is already taken, or was used by another organization. Choose another.";
const UNKNOWN_NOTE =
  "Could not check availability. You can still submit; the server confirms it then.";

export type SlugStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; url?: string }
  | { kind: "taken" }
  | { kind: "invalid"; reason: TenantSlugRejection }
  | { kind: "unknown" };

const IDLE: SlugStatus = { kind: "idle" };
const CHECKING: SlugStatus = { kind: "checking" };
const UNKNOWN: SlugStatus = { kind: "unknown" };

/** A taken or malformed slug cannot be provisioned; everything else (including an outage) leaves the server to decide. */
export function isSlugBlocking(status: SlugStatus): boolean {
  return status.kind === "taken" || status.kind === "invalid";
}

/** The slug as typed, or, until the operator has typed one, the suggestion for the legal name (`null` = never typed). */
export function useSuggestedSlug(
  legalName: string,
  restored: string | null,
): { slug: string; setSlug: (typed: string) => void } {
  const [typed, setTyped] = useState<string | null>(restored);
  return { slug: typed ?? suggestTenantSlug(legalName), setSlug: setTyped };
}

interface AvailabilityBody {
  valid?: boolean;
  available?: boolean;
  reason?: string;
  url?: string;
}

function statusFromAnswer(data: AvailabilityBody | undefined): SlugStatus {
  if (!data || typeof data.available !== "boolean") return UNKNOWN;
  if (data.valid === false) {
    const reason = data.reason;
    return {
      kind: "invalid",
      reason: reason === "reserved" || reason === "punycode" ? reason : "format",
    };
  }
  if (!data.available) return { kind: "taken" };
  return data.url ? { kind: "available", url: data.url } : { kind: "available" };
}

/** What the server says about `slug`, once it has been still for the debounce window; never a verdict for a value that is gone. */
export function useSlugAvailability(slug: string): SlugStatus {
  const client = useApiClient();
  const candidate = slug.trim();
  const settled = useDebouncedValue(candidate, SLUG_CHECK_DEBOUNCE_MS);
  const [answer, setAnswer] = useState<{ slug: string; status: SlugStatus } | null>(null);

  useEffect(() => {
    if (settled === "" || !validateTenantSlug(settled).ok) return undefined;
    let cancelled = false;
    const record = (status: SlugStatus): void => {
      if (!cancelled) setAnswer({ slug: settled, status });
    };
    client
      .GET("/api/v1/platform/tenant-slugs/{slug}/availability", {
        params: { path: { slug: settled } },
      })
      .then(({ data, error }) => record(error ? UNKNOWN : statusFromAnswer(data)))
      .catch(() => record(UNKNOWN));
    return () => {
      cancelled = true;
    };
  }, [client, settled]);

  if (candidate === "") return IDLE;
  if (candidate !== settled) return CHECKING;
  const local = validateTenantSlug(candidate);
  if (!local.ok) return { kind: "invalid", reason: local.reason };
  return answer?.slug === candidate ? answer.status : CHECKING;
}

function errorFor(status: SlugStatus): string | undefined {
  if (status.kind === "invalid") return SLUG_MESSAGES[status.reason];
  return status.kind === "taken" ? TAKEN_MESSAGE : undefined;
}

function noteFor(status: SlugStatus): string | undefined {
  if (status.kind === "checking") return "Checking availability…";
  if (status.kind === "unknown") return UNKNOWN_NOTE;
  if (status.kind !== "available") return undefined;
  return status.url ? `Available: ${status.url}` : "Available.";
}

export function SlugField({
  id,
  label,
  hint,
  value,
  onChange,
  status,
  error,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (next: string) => void;
  status: SlugStatus;
  /** A message from the caller (submit-time validation, a refusal from the server); it wins over the live verdict. */
  error?: string | undefined;
}): JSX.Element {
  const shownError = error ?? errorFor(status);
  const note = shownError ? undefined : noteFor(status);
  return (
    <>
      <TextField
        id={id}
        label={label}
        hint={hint}
        error={shownError}
        value={value}
        maxLength={SLUG_MAX_LENGTH}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {note ? (
        <output className="wx-row-sub" data-slug-status={status.kind}>
          {note}
        </output>
      ) : null}
    </>
  );
}
