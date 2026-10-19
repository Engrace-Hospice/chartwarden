// M36 WP 5.5 (ADR-0083, PROPOSED) - reads and revokes sessions ("devices"): the caller's own (GET/DELETE /devices) or, for a security officer, one
// person's in this organization (the governance routes). The list is the server's answer; a revoke removes the row only AFTER the server says it
// is revoked (a failed revoke leaves it listed with a retry). After a 401/403 no further request is made. Nothing here stores or logs an id.
import type { DeviceDto, DeviceListDto, DeviceRevokeDto } from "@wardenx/types";
import { isStepUpRequired } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { notFoundAnnouncement, revokeFailedText, revokedAnnouncement } from "./devices-wording";
import { useOptionalApiClient } from "./use-handoffs-enabled";

export type DevicesView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "denied"; readonly code: 401 | 403 }
  | { readonly status: "ready"; readonly devices: readonly DeviceDto[] };

export type RowState = "revoking" | "failed";

/** What a revoke attempt came to; `step_up` carries the server's error body so the screen can send the person to the step-up page. */
export type RevokeResult =
  | { readonly kind: "revoked"; readonly current: boolean }
  | { readonly kind: "step_up"; readonly error: unknown }
  | { readonly kind: "failed" };

export interface DevicesScope {
  /** Absent = the caller's own sessions; present = that person's sessions (the security officer's variant). */
  readonly userId?: string | undefined;
}

export interface UseDevices {
  readonly view: DevicesView;
  readonly rowState: Readonly<Record<string, RowState>>;
  /** A polite status line ("Pixel 7 revoked"), empty until something happened. */
  readonly announcement: string;
  readonly revoke: (device: DeviceDto) => Promise<RevokeResult>;
  readonly retry: () => void;
}

export function useDevices(scope: DevicesScope): UseDevices {
  const client = useOptionalApiClient();
  const [view, setView] = useState<DevicesView>({ status: "loading" });
  const [rowState, setRowState] = useState<Readonly<Record<string, RowState>>>({});
  const [announcement, setAnnouncement] = useState("");
  const generation = useRef(0);
  const { userId } = scope;

  const read = useCallback(async (): Promise<void> => {
    if (!client) {
      setView({ status: "error" });
      return;
    }
    const gen = generation.current;
    try {
      const { data, response } = userId
        ? await client.GET("/api/v1/messaging/governance/sessions", {
            params: { query: { user_id: userId } },
          })
        : await client.GET("/api/v1/devices");
      if (gen !== generation.current) return; // superseded by a newer read or an unmount
      if (data) {
        setView({ status: "ready", devices: (data as DeviceListDto).devices });
        return;
      }
      const code = response?.status ?? 0;
      setView(code === 401 || code === 403 ? { status: "denied", code } : { status: "error" });
    } catch {
      if (gen === generation.current) setView({ status: "error" });
    }
  }, [client, userId]);

  useEffect(() => {
    generation.current += 1;
    setView({ status: "loading" });
    setRowState({});
    setAnnouncement("");
    void read();
    return () => {
      generation.current += 1;
    };
  }, [read]);

  const revoke = useCallback(
    async (device: DeviceDto): Promise<RevokeResult> => {
      if (!client) return { kind: "failed" };
      const gen = generation.current;
      setRowState((prev) => ({ ...prev, [device.id]: "revoking" }));
      const clearRow = (): void =>
        setRowState((prev) => {
          const { [device.id]: _gone, ...rest } = prev;
          return rest;
        });
      const fail = (status?: number, error?: unknown): RevokeResult => {
        if (gen !== generation.current) return { kind: "failed" };
        // A step-up refusal is not a failure of the row: the screen sends the person to verify, so no "could not revoke" alert.
        if (error !== undefined && isStepUpRequired(error)) {
          clearRow();
          return { kind: "step_up", error };
        }
        // 401/403 is terminal (the session ended or the permission was removed): say so instead of offering endless retries.
        if (status === 401 || status === 403) {
          setView({ status: "denied", code: status });
          return { kind: "failed" };
        }
        setRowState((prev) => ({ ...prev, [device.id]: "failed" }));
        setAnnouncement(revokeFailedText(device.label));
        return { kind: "failed" };
      };
      try {
        const { data, error, response } = userId
          ? await client.DELETE("/api/v1/messaging/governance/sessions/{id}", {
              params: { path: { id: device.id } },
            })
          : await client.DELETE("/api/v1/devices/{id}", { params: { path: { id: device.id } } });
        // A 404 is one answer for "already gone", "not yours" and "not in your organization": never announce a revoke. Re-read the list
        // so it shows what is true, and say the session was not found.
        if (!data && response?.status === 404) {
          if (gen === generation.current) {
            clearRow();
            setAnnouncement(notFoundAnnouncement(device.label));
            void read();
          }
          return { kind: "failed" };
        }
        if (!data) return fail(response?.status, error);
        const current = (data as DeviceRevokeDto | undefined)?.current ?? false;
        if (gen === generation.current) {
          setView((prev) =>
            prev.status === "ready"
              ? { status: "ready", devices: prev.devices.filter((d) => d.id !== device.id) }
              : prev,
          );
          setRowState((prev) => {
            const { [device.id]: _gone, ...rest } = prev;
            return rest;
          });
          setAnnouncement(revokedAnnouncement(device.label));
        }
        return { kind: "revoked", current };
      } catch {
        return fail();
      }
    },
    [client, userId, read],
  );

  const retry = useCallback(() => {
    setView((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void read();
  }, [read]);

  return { view, rowState, announcement, revoke, retry };
}
