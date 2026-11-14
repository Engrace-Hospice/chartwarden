// apps/web/src/modules/34-saas/wizard — step 8's facts, per provider entity. The portal check is the server's `portal_health_probe`: it
// shows that the MAC portal for the credential's jurisdiction ANSWERS. It does not validate the client secret, so no fact here (and no
// sentence anywhere on the panel) says the credential has "passed" anything.
import type { Fact } from "@chartwarden/ui";
import type { Credential } from "./mac-credential-table";

export const PORTAL_CHECK_CAVEAT = "This does not check your credential.";

const when = (iso: string): string => new Date(iso).toLocaleString();

export function macFactsOf(
  items: readonly Credential[],
  nameOf: (providerEntityId: string) => string,
): Fact[] {
  return [
    {
      key: "one",
      label: "A MAC credential is on file",
      state: items.length > 0 ? "ok" : "pending",
    },
    ...items.map(
      (c): Fact => ({
        key: `portal-${c.credentialId}`,
        label: `The MAC portal for ${nameOf(c.providerEntityId)}'s jurisdiction answered a check`,
        state: c.lastSandboxTestAt !== null ? "ok" : "pending",
        detail:
          c.lastSandboxTestAt !== null
            ? `Last checked ${when(c.lastSandboxTestAt)}. ${PORTAL_CHECK_CAVEAT}`
            : "Use Check portal on its row. The check does not need the secret.",
      }),
    ),
  ];
}

/** What a finished portal check says, naming the provider entity it was about. */
export function portalCheckText(entityName: string, answered: boolean, detail: string): string {
  return answered
    ? `${entityName}: The MAC portal for your jurisdiction answered. ${PORTAL_CHECK_CAVEAT}`
    : `${entityName}: The MAC portal for your jurisdiction did not answer. ${detail}`;
}
