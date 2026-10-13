import { useApiClient } from "@wardenx/ui";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { readError } from "./screens/portal-format";

export interface PortalCareSummary {
  patient: { layLabel: string; pronouns?: string; preferredName?: string };
  upcomingVisitsCount: number;
  recentVisitsCount: number;
  activeMedicationsCount: number;
  unreadMessagesCount: number;
  pendingDocumentSharesCount: number;
}

interface PatientContextValue {
  patientId: string | null;
  summary: PortalCareSummary | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

const PatientContext = createContext<PatientContextValue | null>(null);

export function PortalPatientContext({
  patientId,
  children,
}: { patientId: string | null; children: ReactNode }): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<{
    patientId: string | null;
    summary: PortalCareSummary | null;
    loading: boolean;
    error: string | null;
  }>({ patientId, summary: null, loading: patientId !== null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void attempt;
    let active = true;
    // Clear synchronously for the new key before any response can reveal the previous patient.
    setState({ patientId, summary: null, loading: patientId !== null, error: null });
    if (!patientId) return () => undefined;
    void (async () => {
      const response = await client.GET("/api/v1/portal/care-summary", {});
      if (!active) return;
      if (response.error) {
        setState({
          patientId,
          summary: null,
          loading: false,
          error: readError(response.response?.status),
        });
      } else {
        setState({
          patientId,
          summary: (response.data as PortalCareSummary) ?? null,
          loading: false,
          error: null,
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, attempt]);

  const value = useMemo<PatientContextValue>(
    () => ({
      patientId,
      summary: state.patientId === patientId ? state.summary : null,
      loading: state.patientId !== patientId || state.loading,
      error: state.patientId === patientId ? state.error : null,
      retry: () => setAttempt((value) => value + 1),
    }),
    [patientId, state],
  );
  return <PatientContext.Provider value={value}>{children}</PatientContext.Provider>;
}

export function usePortalPatient(): PatientContextValue {
  const value = useContext(PatientContext);
  if (!value) throw new Error("usePortalPatient must be used inside PortalPatientContext");
  return value;
}
