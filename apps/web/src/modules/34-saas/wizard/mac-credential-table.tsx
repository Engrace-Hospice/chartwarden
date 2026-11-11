// apps/web/src/modules/34-saas/wizard — the MAC credentials on file, as a flat table: what is stored (never the secret: only that one is
// on file), when it was last tested, and, for a member who may write, Replace and Test.
import { Button, type operations } from "@chartwarden/ui";
import type { JSX } from "react";
import { JURISDICTIONS } from "./mac-credential-form";

export type Credential =
  operations["getApiV1BillingMaccredentials"]["responses"][200]["content"]["application/json"]["items"][number];

const JURISDICTION_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  JURISDICTIONS.map((j) => [j.value, j.label]),
);

export function MacCredentialTable({
  items,
  nameOf,
  canWrite,
  locked,
  onReplace,
  onTest,
}: {
  items: readonly Credential[];
  nameOf: (providerEntityId: string) => string;
  canWrite: boolean;
  /** An editor is open or a write is running: Replace and the check wait, so none bumps the version an open editor is pinned to. */
  locked: boolean;
  onReplace: (credential: Credential) => void;
  onTest: (providerEntityId: string) => void;
}): JSX.Element {
  return (
    <table className="wx-list-table wx-list-table-static">
      <caption className="wx-sr-only">MAC credentials on file</caption>
      <thead>
        <tr>
          <th scope="col">Provider entity</th>
          <th scope="col">Jurisdiction</th>
          <th scope="col">Submitter id</th>
          <th scope="col">Client id</th>
          <th scope="col">Secret</th>
          <th scope="col">Last portal check</th>
          <th scope="col">
            <span className="wx-sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.credentialId}>
            <td>{nameOf(c.providerEntityId)}</td>
            <td>{JURISDICTION_LABEL[c.macJurisdiction] ?? c.macJurisdiction}</td>
            <td className="wx-data-md">{c.submitterId}</td>
            <td className="wx-data-md">{c.clientId}</td>
            <td>{c.hasSecret ? "Secret on file" : "None"}</td>
            <td className="wx-nums">
              {c.lastSandboxTestAt ? new Date(c.lastSandboxTestAt).toLocaleString() : "Not yet"}
            </td>
            <td>
              {canWrite ? (
                <>
                  <Button
                    size="sm"
                    tone="tertiary"
                    aria-label={`Replace credential for ${nameOf(c.providerEntityId)}`}
                    data-editor-return="mac"
                    disabled={locked}
                    onClick={() => onReplace(c)}
                  >
                    Replace
                  </Button>
                  <Button
                    size="sm"
                    tone="tertiary"
                    aria-label={`Check the MAC portal for ${nameOf(c.providerEntityId)}`}
                    disabled={locked}
                    onClick={() => onTest(c.providerEntityId)}
                  >
                    Check portal
                  </Button>
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
