import { useMemo, useRef } from "react";

const mintKey = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export interface AttemptKey {
  /**
   * Runs one write with an Idempotency-Key. The key is kept only when `send` THROWS (no HTTP response arrived, so a
   * retry of the identical request may safely replay it). Any resolved answer, success or HTTP error, retires it: the
   * server caches every answer under the key for 24h and would replay a stale 4xx/5xx. `fingerprint` identifies the
   * request (route + params + body): a changed field mints a fresh key.
   */
  run<T>(fingerprint: string, send: (key: string) => Promise<T>): Promise<T>;
}

export function useAttemptKey(): AttemptKey {
  const held = useRef<{ fingerprint: string; key: string } | null>(null);
  return useMemo<AttemptKey>(
    () => ({
      async run(fingerprint, send) {
        if (held.current?.fingerprint !== fingerprint)
          held.current = { fingerprint, key: mintKey() };
        const result = await send(held.current.key);
        held.current = null;
        return result;
      },
    }),
    [],
  );
}
