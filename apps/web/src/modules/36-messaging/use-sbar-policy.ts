// M36 WP 3.3 - the organization's effective SBAR policy (platform floor already applied by the server), and the flag.
import { SBAR_SECTION_KEYS, type SbarSectionKey } from "@wardenx/types";
import { type ApiClient, useApiClient, useFeatureFlag } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { SBAR_FLAG_KEY } from "./sbar-utils";

export interface SbarPolicyView {
  readonly minChars: Readonly<Record<SbarSectionKey, number>>;
  readonly maxChars: number;
  readonly requirePatientChannel: boolean;
  readonly hints: Readonly<Partial<Record<SbarSectionKey, string>>>;
  readonly customized: boolean;
}
export interface SbarPolicyInput {
  readonly minChars?: Readonly<Partial<Record<SbarSectionKey, number>>>;
  readonly requirePatientChannel?: boolean;
  readonly hints?: Readonly<Partial<Record<SbarSectionKey, string>>>;
}
interface PolicyResult {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}
/**
 * The three SBAR policy routes are not in the generated schema yet (regenerated with the backend slice), so the typed
 * client cannot name them. This narrow shape is the only place that knows; delete it and call `client` directly once
 * `client:check` has the paths.
 */
export interface SbarPolicyClient {
  GET(path: "/api/v1/messaging/sbar/policy"): Promise<PolicyResult>;
  PUT(
    path: "/api/v1/messaging/template-admin/sbar-policy",
    init: { body: SbarPolicyInput },
  ): Promise<PolicyResult>;
  DELETE(path: "/api/v1/messaging/template-admin/sbar-policy"): Promise<PolicyResult>;
}
export const sbarPolicyClient = (client: ApiClient): SbarPolicyClient =>
  client as unknown as SbarPolicyClient;

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
  // Fail closed on a present-but-unusable cap: this is the only runtime check behind the SbarPolicyClient cast.
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
  | { readonly status: "ready"; readonly policy: SbarPolicyView };

/** Loads the policy while `active`. 404 (flag off), 403, an error or an unreadable answer all mean "do not offer SBAR". */
export function useSbarPolicy(active: boolean): SbarPolicyState & { reload: () => void } {
  const client = useApiClient();
  const [state, setState] = useState<SbarPolicyState>({ status: "idle" });
  const [tick, setTick] = useState(0);
  const sequence = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (!active) return;
    const mine = ++sequence.current;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    sbarPolicyClient(client)
      .GET("/api/v1/messaging/sbar/policy")
      .then(({ data, response }) => {
        if (mine !== sequence.current) return;
        const policy = parseSbarPolicy(data);
        if (policy) setState({ status: "ready", policy });
        else setState({ status: response?.status === 403 ? "forbidden" : "unavailable" });
      })
      .catch(() => {
        if (mine === sequence.current) setState({ status: "unavailable" });
      });
    return () => {
      sequence.current += 1;
    };
  }, [active, client, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}
