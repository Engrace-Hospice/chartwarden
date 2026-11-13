// apps/admin/src/modules/34-saas-platform/onboarding — one read: loading, the refusal as an `OpsFailure`, and a reload. The hook now lives
// in @chartwarden/ui (the tenant wizard shares it); this binds the operator-voice wizard copy so every admin caller keeps its two-argument form.
import { type Loaded, type OpsErrorCopy, useLoad as useLoadWithCopy } from "@chartwarden/ui";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

export type { Loaded };

interface FetchResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}

const COPY: OpsErrorCopy = WIZARD_ERROR_COPY;

export function useLoad<T>(key: string, load: () => Promise<FetchResult<T>>): Loaded<T> {
  return useLoadWithCopy(key, load, COPY);
}
