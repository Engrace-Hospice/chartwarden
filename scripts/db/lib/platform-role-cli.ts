/**
 * WardenX — argument parsing + command runner for the platform-role operator CLI
 * (`scripts/db/platform-role.ts`). Split from the entry point so the live suite drives the exact code an
 * operator runs, against its own database, without spawning a process.
 */
import { randomUUID } from "node:crypto";
import type { PlatformGrantableRoleKey } from "@chartwarden/auth";
import type { Client } from "pg";
import {
  assertPlatformGrantableKey,
  grantPlatformRole,
  platformRoleLabel,
  resolveActiveMembership,
  revokePlatformRole,
  withPlatformRoleAudit,
} from "./platform-role";

export type PlatformRoleAction = "grant" | "revoke";

export interface PlatformRoleCommand {
  readonly action: PlatformRoleAction;
  readonly email: string;
  readonly org: string;
  readonly role: PlatformGrantableRoleKey;
  /** Change-ticket reference carried into the audit correlation id. */
  readonly ticket: string;
}

export const PLATFORM_ROLE_USAGE = `Usage:
  bun run db:platform-role <grant|revoke> --email <user email> --org <org slug or id> \\
    --role <platform role key> --ticket <change ticket ref>

Grants or revokes a PLATFORM-OWNED role (organization_id IS NULL) on the user's ACTIVE membership in
the org. Connects with DATABASE_ADMIN_URL (or DATABASE_URL). Idempotent.`;

/** Ticket refs land in `audit_event.correlation_id`; keep them short and free of separators/whitespace. */
const TICKET_RE = /^[A-Za-z0-9._#/-]{1,64}$/;

/** Parse `argv` (without the runtime/script prefix). Throws with a message naming the bad argument. */
export function parsePlatformRoleArgs(argv: readonly string[]): PlatformRoleCommand {
  const [action, ...rest] = argv;
  if (action !== "grant" && action !== "revoke") {
    throw new Error(`first argument must be 'grant' or 'revoke', got '${action ?? ""}'`);
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? "";
    const value = rest[i + 1];
    if (!["--email", "--org", "--role", "--ticket"].includes(flag)) {
      throw new Error(`unknown argument '${flag}'`);
    }
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    flags.set(flag, value.trim());
  }
  const required = (flag: string): string => {
    const value = flags.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  const ticket = required("--ticket");
  if (!TICKET_RE.test(ticket)) {
    throw new Error("--ticket must be 1-64 chars of letters, digits and . _ # / -");
  }
  return {
    action,
    email: required("--email"),
    org: required("--org"),
    role: assertPlatformGrantableKey(required("--role")),
    ticket,
  };
}

/** Run one parsed command, reporting what it did through `log`. */
export async function runPlatformRoleCommand(
  db: Client,
  command: PlatformRoleCommand,
  log: (line: string) => void,
): Promise<void> {
  const member = await resolveActiveMembership(db, command.email, command.org);
  const correlationId = `ops-cli:platform-role:${command.action}:${command.ticket}:${randomUUID()}`;
  const target = `${command.role} on ${command.email} @ ${member.organizationSlug} (membership ${member.membershipId})`;

  if (command.action === "grant") {
    const result = await withPlatformRoleAudit(
      db,
      { correlationId, organizationId: member.organizationId },
      () =>
        grantPlatformRole(db, {
          organizationId: member.organizationId,
          membershipId: member.membershipId,
          key: command.role,
          ...platformRoleLabel(command.role),
        }),
    );
    log(`${result.bound ? "granted" : "already granted"}: ${target}`);
    log(
      `  platform-owned role ${result.roleId} ${result.roleCreated ? "created" : "already existed"}`,
    );
    if (result.permissionsGranted > 0) {
      log(`  template permissions granted to the role: ${result.permissionsGranted}`);
    }
    if (result.permissionsMissing.length > 0) {
      log(
        `  WARNING template permissions absent from the permission mirror (run db:sync:permissions): ${result.permissionsMissing.join(", ")}`,
      );
    }
    if (result.legacyRowsRemoved > 0) {
      log(`  removed ${result.legacyRowsRemoved} legacy tenant-owned '${command.role}' row(s)`);
    }
  } else {
    const removed = await withPlatformRoleAudit(
      db,
      { correlationId, organizationId: member.organizationId },
      () => revokePlatformRole(db, { membershipId: member.membershipId, key: command.role }),
    );
    log(`${removed ? "revoked" : "not granted (nothing to revoke)"}: ${target}`);
  }
  log(`  audit correlation id: ${correlationId}`);
  log(
    "  takes effect on the next request (role keys are re-read per request; cached permission sets live <= 5 min)",
  );
}
