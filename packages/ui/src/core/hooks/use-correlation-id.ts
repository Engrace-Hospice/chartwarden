// @chartwarden/ui — use-correlation-id (spec §5.1). Reads the per-session correlation id from
// context so components (error boundary, support badge) can quote it. The app seeds the id
// (it owns the value sent on requests / returned in the M1 error envelope, spec §4.3/§4.5).
import { createContext, useContext } from "react";

const CorrelationIdContext = createContext<string | null>(null);

export const CorrelationIdProvider = CorrelationIdContext.Provider;

/** Returns the active correlation id, or `null` when none has been seeded. */
export function useCorrelationId(): string | null {
  return useContext(CorrelationIdContext);
}
