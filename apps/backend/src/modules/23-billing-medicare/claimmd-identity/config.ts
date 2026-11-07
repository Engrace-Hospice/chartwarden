export const CLAIMMD_IDENTITY_RESOLUTION_ENABLED_ENV = "CLAIMMD_IDENTITY_RESOLUTION_ENABLED";
/** Missing, malformed, or any value other than the explicit string `true` disables the worker. */
export function claimMdIdentityResolutionEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[CLAIMMD_IDENTITY_RESOLUTION_ENABLED_ENV]?.trim().toLowerCase() === "true";
}

export const CLAIMMD_INBOX_KEYRING_ENV = "CLAIMMD_RESPONSE_INBOX_KEYRING";
export interface ClaimMdInboxKeyRingConfig {
  readonly activeId: string;
  readonly byId: ReadonlyMap<string, Buffer>;
}

/** Secret-manager supplied JSON: {"activeId":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}. */
export function claimMdInboxKeyRingFromEnv(env: Readonly<Record<string, string | undefined>>): ClaimMdInboxKeyRingConfig | null {
  const raw = env[CLAIMMD_INBOX_KEYRING_ENV]?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { activeId?: unknown; keys?: unknown };
    if (typeof parsed.activeId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(parsed.activeId) ||
      parsed.keys === null || typeof parsed.keys !== "object" || Array.isArray(parsed.keys)) return null;
    const byId = new Map<string, Buffer>();
    for (const [id, encoded] of Object.entries(parsed.keys)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
      const key = Buffer.from(encoded, "base64url");
      if (key.length !== 32 || key.toString("base64url") !== encoded) return null;
      byId.set(id, key);
    }
    if (!byId.has(parsed.activeId)) return null;
    return { activeId: parsed.activeId, byId };
  } catch { return null; }
}
