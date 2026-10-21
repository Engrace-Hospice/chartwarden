// M36 WP 3.3 - the organization's effective SBAR policy (platform floor already applied by the server), and the flag.
import { SBAR_SECTION_KEYS, type SbarSectionKey } from "@chartwarden/types";
import { useApiClient, useFeatureFlag } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import { SBAR_FLAG_KEY } from "./sbar-utils";

export interface SbarPolicyView {
  readonly minChars: Readonly<Record<SbarSectionKey, number>>;
  readonly maxChars: number;
  readonly requirePatientChannel: boolean;
  readonly hints: Readonly<Partial<Record<SbarSectionKey, string>>>;
  readonly customized: boolean;
}
/** Flag read that defaults to OFF with no provider mounted (fail closed). */
export function useSbarFlag(): boolean {
  try {
    return useFeatureFlag(SBAR_FLAG_KEY);
  } catch {
    return false;
  }
}

export function parseSbarPolicy(data: unknown): SbarPolicyView | null {
  const candidate = data as Partial<SbarPolicyView> | null;
  const minChars = candidate?.minChars;
  if (!minChars || typeof minChars !== "object") return null;
  for (const key of SBAR_SECTION_KEYS) if (typeof minChars[key] !== "number") return null;
  // Fail closed on a present-but-unusable cap: the generated type is a promise, not a guarantee.
  const rawMax = candidate?.maxChars as unknown;
  if (rawMax !== undefined && !(typeof rawMax === "number" && Number.isFinite(rawMax))) return null;
  // Hints reach React children: keep only known sections with string values.
  const hints: Partial<Record<SbarSectionKey, string>> = {};
  const rawHints = (candidate?.hints ?? {}) as Record<string, unknown>;
  for (const key of SBAR_SECTION_KEYS) {
    const hint = typeof rawHints === "object" ? rawHints[key] : undefined;
    if (typeof hint === "string") hints[key] = hint;
  }
  return {
    minChars,
    maxChars: rawMax === undefined ? 2000 : (rawMax as number),
    requirePatientChannel: candidate?.requirePatientChannel === true,
    hints,
    customized: candidate?.customized === true,
  };
}

export type SbarPolicyState =
  | { readonly status: "idle" | "loading" | "unavailable" }
  | { readonly status: "forbidden" }
  /** A network error or 5xx: retried with backoff, and again when the template menu opens. */
  | { readonly status: "transient" }
  | { readonly status: "ready"; readonly policy: SbarPolicyView };

/** Backoff before each retry of a transient failure; its length is the retry cap. */
export const POLICY_RETRY_DELAYS_MS = [1000, 3000, 8000] as const;

/**
 * Loads the policy while `active`. 404 (flag off), 403 and an unreadable answer mean "do not offer SBAR" and are never
 * retried; a network error or 5xx is "transient" (also not offered meanwhile) and retried up to the cap.
 */
export function useSbarPolicy(active: boolean): SbarPolicyState & { reload: () => void } {
  const client = useApiClient();
  const [state, setState] = useState<SbarPolicyState>({ status: "idle" });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (retry: number): void => {
      setState({ status: "transient" });
      const delay = POLICY_RETRY_DELAYS_MS[retry];
      if (delay !== undefined) timer = setTimeout(() => attempt(retry + 1), delay);
    };
    const attempt = (retry: number): void => {
      client
        .GET("/api/v1/messaging/sbar/policy")
        .then(({ data, response }) => {
          if (cancelled) return;
          if (response && response.status >= 500) return fail(retry);
          const policy = parseSbarPolicy(data);
          if (policy) setState({ status: "ready", policy });
          else setState({ status: response?.status === 403 ? "forbidden" : "unavailable" });
        })
        .catch(() => {
          if (!cancelled) fail(retry);
        });
    };
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, client, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}
