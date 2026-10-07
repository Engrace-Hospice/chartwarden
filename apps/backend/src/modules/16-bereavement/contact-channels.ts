// apps/backend/src/modules/16-bereavement/contact-channels.ts — GAP-129: open a bereaved contact's stored channels.
//
// The write path seals email / phone / mailing address into the `*_cipher` columns (`./bereavement-crypto`). This is the
// matching read for the consumers that actually reach a survivor — the outreach renderer / reminder workers — so a stored
// phone number round-trips instead of being a write-only blob. Deliberately NOT an HTTP route: no staff screen shows a
// survivor's raw contact details (the contact view projects ids and enums only), and a decrypt path with no consumer
// would be a PHI read surface with no audit behind it. A blob that cannot be opened (rotated-out DEK, tampered row) reads
// as an ABSENT channel, never as a guessed or partial one.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { BereavementCipher, BereavementCipherColumn } from "./bereavement-crypto";

export interface BereavedContactChannels {
  readonly email: string | null;
  readonly phone: string | null;
  readonly mailingAddress: string | null;
}

async function open(
  cipher: BereavementCipher,
  organizationId: string,
  column: BereavementCipherColumn,
  blob: string | null,
): Promise<string | null> {
  if (blob === null) return null;
  try {
    return await cipher.decrypt(organizationId, column, blob);
  } catch {
    return null;
  }
}

/** The contact's decrypted channels, or null when the contact does not exist in the org. */
export async function openBereavedContactChannels(
  db: DbClient,
  cipher: BereavementCipher,
  organizationId: string,
  contactId: string,
): Promise<BereavedContactChannels | null> {
  const CONTACT = schema.bereavedContact;
  // Read the sealed blobs inside the tenant tx, decrypt OUTSIDE it (the key provider takes its own connection).
  const row = await withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
    const [found] = await (tx as DbClient)
      .select({
        email: CONTACT.emailCipher,
        phone: CONTACT.phoneCipher,
        mailingAddress: CONTACT.mailingAddressCipher,
      })
      .from(CONTACT)
      .where(and(eq(CONTACT.id, contactId), eq(CONTACT.organizationId, organizationId)))
      .limit(1);
    return found ?? null;
  });
  if (row === null) return null;
  return {
    email: await open(cipher, organizationId, "bereaved_contact.email", row.email),
    phone: await open(cipher, organizationId, "bereaved_contact.phone", row.phone),
    mailingAddress: await open(
      cipher,
      organizationId,
      "bereaved_contact.mailing_address",
      row.mailingAddress,
    ),
  };
}
