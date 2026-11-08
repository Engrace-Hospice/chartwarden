export const CLAIMMD_ACK_DISPATCH_ENABLED_ENV = "CLAIMMD_ACK_DISPATCH_ENABLED";
export const CLAIMMD_ACK_SHADOW_ENABLED_ENV = "CLAIMMD_ACK_SHADOW_ENABLED";

/** Explicit flags are independent of the resolver. Conflicting modes fail closed. */
export function claimMdAckMode(
  env: Readonly<Record<string, string | undefined>>,
): "off" | "shadow" | "apply" {
  const apply = env[CLAIMMD_ACK_DISPATCH_ENABLED_ENV] === "true";
  const shadow = env[CLAIMMD_ACK_SHADOW_ENABLED_ENV] === "true";
  if (apply && shadow) throw new Error("CLAIMMD_ACK_MODE_CONFLICT");
  return apply ? "apply" : shadow ? "shadow" : "off";
}
