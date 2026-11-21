// apps/web/src/modules/08-encounters/workspace — the scheduling staff list, read once instead of on every mount of the visit context header.
// The header needs one clinician's name; no route resolves a single id, so the whole list is read, and the composer and the record both open
// a header for each encounter. A held list belongs to one client AND one signed-in user (the route's scope may differ per user, and a shared
// workstation signs people in and out on the same client), and expires. A failed read is held only briefly (FAILED_READ_TTL_MS): a role
// without staff-read permission would otherwise send a refused request (a 403 and a denied-access audit entry) on every open, yet an
// outage must not hide the names for long.
import type { ApiClient } from "@chartwarden/ui";

/** Membership id to display name; a member without a name is absent. */
type StaffDirectory = ReadonlyMap<string, string>;

/** How long a read list is reused: names change rarely, but a rename should not outlive a long session. */
const DIRECTORY_TTL_MS = 5 * 60_000;
/** How long a read that failed is remembered before the next mount asks again. */
const FAILED_READ_TTL_MS = 30_000;

interface StaffMember {
  membershipId?: unknown;
  displayName?: unknown;
}

type LooseGet = (path: string, init?: unknown) => Promise<{ data?: unknown } | undefined>;

interface Held {
  readonly read: Promise<StaffDirectory | null>;
  /** When the read was started, or, for a read that failed, when it failed. */
  readonly readAt: number;
  readonly failed: boolean;
}

const heldByClient = new WeakMap<object, Map<string, Held>>();

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The list, or null when it could not be read (a refusal, an outage, an answer that is not a list). */
async function readDirectory(client: ApiClient): Promise<StaffDirectory | null> {
  try {
    const staff = await (client as unknown as { GET: LooseGet }).GET(
      "/api/v1/scheduling/staff",
      {},
    );
    if (!Array.isArray(staff?.data)) return null;
    // A row can be null in an answer that is otherwise a list: it is skipped, never the whole directory.
    const entries = (staff.data as Array<StaffMember | null>).flatMap((member) => {
      const membershipId = member?.membershipId;
      const displayName = member?.displayName;
      return isText(membershipId) && isText(displayName)
        ? [[membershipId, displayName] as const]
        : [];
    });
    return new Map(entries);
  } catch {
    return null;
  }
}

/** The staff names for `scope` (the signed-in user), from the list this client already read when it is still fresh; empty when unreadable. */
export async function staffDirectory(client: ApiClient, scope: string): Promise<StaffDirectory> {
  const forClient = heldByClient.get(client) ?? new Map<string, Held>();
  heldByClient.set(client, forClient);
  const held = forClient.get(scope);
  const holdFor = held?.failed ? FAILED_READ_TTL_MS : DIRECTORY_TTL_MS;
  if (held && Date.now() - held.readAt < holdFor) return (await held.read) ?? new Map();

  const read = readDirectory(client);
  forClient.set(scope, { read, readAt: Date.now(), failed: false });
  const directory = await read;
  // A failure is held for a short while, counted from when it failed (unless a newer read has already replaced this one).
  if (directory === null && forClient.get(scope)?.read === read) {
    forClient.set(scope, { read, readAt: Date.now(), failed: true });
  }
  return directory ?? new Map();
}
