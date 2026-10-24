// M36 WP 6.7 (ADR-0099, PROPOSED) - family messaging, STAFF side: the tenant settings, the caregiver picker, the invitation (create / reissue), the lane, one
// thread, the reply, close and block. Rules live here; the store is reads and writes. Who may act on WHICH patient is the care-team predicate
// (`canAccessPatient`: the CURRENT care-team roster and the Part 2 gate, never the break-glass grant, ADR-0099 D6/D9); the permission only says the role
// exists. A non-member gets the same 404 as an unknown id.
import {
  ChartWardenError,
  ConflictError,
  type CreateFamilyInvitationRequest,
  type CreatedFamilyInvitationDto,
  DegradedError,
  FAMILY_ACCESS_UNAVAILABLE_CODE,
  FAMILY_INVITES_PER_CREATOR_DAY,
  FAMILY_INVITES_PER_ORG_DAY,
  FAMILY_INVITE_DEFAULT_DAYS,
  FAMILY_INVITE_MAX_DAYS,
  FAMILY_LIMIT_CODE,
  FAMILY_MESSAGING_FLAG_KEY,
  FAMILY_NOT_ELIGIBLE_CODE,
  FAMILY_SEND_PER_HOUR,
  FAMILY_SETTINGS_MISSING_CODE,
  FAMILY_SETTING_TEXT_MAX,
  FAMILY_THREAD_CLOSED_CODE,
  type FamilyContactSummaryDto,
  type FamilyEligibleCaregiverDto,
  type FamilyLinkState,
  type FamilySettingsDto,
  type FamilyStaffMessageDto,
  type FamilyStaffThreadDto,
  NotFoundError,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";
import { type MessageBodyCipher, insertEncryptedMessage } from "../messaging-write-core";
import { decodeStoredBody } from "../rich-body-codec";
import { type FamilyFlagReader, UUID_RE, invalid, validateMessageText } from "./family-common";
import { publishFamilyEvent } from "./family-events";
import {
  hashPartnerToken,
  hashVerificationCode,
  newPartnerToken,
  newVerificationCode,
} from "../external-share/external-share-secrets";
import type {
  FamilyContactRow,
  FamilyStaffActor,
  FamilyStaffStore,
  FamilyStaffTx,
} from "./family-store-types";
import type { Tx } from "../messaging-write-core";

/** Messages a staff member reads at once (the newest N, oldest first). */
export const FAMILY_STAFF_THREAD_LIMIT = 200;

export interface FamilyStaffServiceDeps {
  /** false => creating an invitation answers FAMILY_ACCESS_UNAVAILABLE (503): a link nobody can use is never made. Default true. */
  readonly accessAvailable?: boolean | undefined;
  /** The per-deployment code pepper (D3). Absent => nothing can be issued. */
  readonly pepper?: string | undefined;
  readonly store: FamilyStaffStore;
  /** Required for every staff write: it announces itself on the outbox in the same transaction. */
  readonly outbox?: HintOutboxPort | undefined;
  /** The M1 flag reader for `messaging.family_messaging`. Absent => the feature is off everywhere. */
  readonly flags?: FamilyFlagReader | undefined;
  /** The M36 body cipher (seal for a reply, open for the thread). Absent => reading and replying are refused 503. */
  readonly cipher?: Pick<MessageBodyCipher, "open" | "seal"> | undefined;
  /** The one message writer (default: `insertEncryptedMessage`); a seam so the unit matrix runs without a database. */
  readonly insertMessage?: typeof insertEncryptedMessage | undefined;
  /**
   * The care-team predicate (D6/D9): the actor is on the patient's CURRENT roster (or, for a bereaved patient, is the assigned counsellor) AND the
   * Part 2 gate admits them. No break-glass. Absent => nobody may act (fail closed, the uniform 404).
   */
  readonly canAccessPatient?:
    | ((orgId: string, userId: string, patientId: string) => Promise<boolean>)
    | undefined;
}

export interface FamilyStaffService {
  isEnabled(orgId: string): Promise<boolean>;
  getSettings(actor: FamilyStaffActor): Promise<FamilySettingsDto>;
  putSettings(actor: FamilyStaffActor, body: FamilySettingsDto): Promise<FamilySettingsDto>;
  caregivers(actor: FamilyStaffActor, patientId: string): Promise<FamilyEligibleCaregiverDto[]>;
  createInvitation(
    actor: FamilyStaffActor,
    body: CreateFamilyInvitationRequest,
  ): Promise<CreatedFamilyInvitationDto>;
  list(actor: FamilyStaffActor): Promise<FamilyContactSummaryDto[]>;
  thread(actor: FamilyStaffActor, contactId: string): Promise<FamilyStaffThreadDto>;
  reply(actor: FamilyStaffActor, contactId: string, rawBody: unknown): Promise<FamilyStaffMessageDto>;
  revoke(actor: FamilyStaffActor, contactId: string): Promise<FamilyContactSummaryDto>;
  setClosed(actor: FamilyStaffActor, contactId: string, closed: boolean): Promise<FamilyContactSummaryDto>;
  setBlocked(actor: FamilyStaffActor, contactId: string, blocked: boolean): Promise<FamilyContactSummaryDto>;
}

const contactNotFound = (): NotFoundError => new NotFoundError("family contact");

function linkStateOf(row: FamilyContactRow): FamilyLinkState {
  const inv = row.invitation;
  if (!inv) return row.hadRevokedInvitation ? "revoked" : "none";
  if (inv.expiresAt.getTime() <= row.dbNow.getTime()) return "expired";
  if (inv.activeSession) return "active";
  if (inv.codeAttempts >= 5 && !inv.activeSession) return "locked";
  if (inv.verifyingSession) return "verifying";
  return inv.redeemed ? "expired" : "not_opened";
}

export function toSummary(row: FamilyContactRow): FamilyContactSummaryDto {
  return {
    contactId: row.contactId,
    patientId: row.patientId,
    patientCaregiverId: row.patientCaregiverId,
    patientName: row.patientName,
    displayName: row.caregiverName,
    relationship: row.relationship,
    consentState: row.reason,
    linkState: linkStateOf(row),
    mode: row.mode,
    language: row.language,
    closed: row.closed,
    blocked: row.blocked,
    channelId: row.channelId,
    lastContactActivityAt: row.lastContactMessageAt ? row.lastContactMessageAt.toISOString() : null,
    unansweredSince: row.unansweredSince ? row.unansweredSince.toISOString() : null,
    highVolume: row.sentLastHour >= FAMILY_SEND_PER_HOUR,
  };
}

function validateCreate(body: CreateFamilyInvitationRequest): {
  readonly patientId: string;
  readonly patientCaregiverId: string;
  readonly expiresInDays: number;
} {
  if ((body as { codeByVoiceConfirmed?: unknown }).codeByVoiceConfirmed !== true) {
    invalid(
      "codeByVoiceConfirmed",
      "confirm that you will give the code by voice, never in the same message as the link",
    );
  }
  if (!UUID_RE.test(body.patientId ?? "")) invalid("patientId", "a patient id");
  if (!UUID_RE.test(body.patientCaregiverId ?? "")) invalid("patientCaregiverId", "a caregiver id");
  const expiresInDays = body.expiresInDays ?? FAMILY_INVITE_DEFAULT_DAYS;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > FAMILY_INVITE_MAX_DAYS) {
    invalid("expiresInDays", `a whole number of days from 1 to ${FAMILY_INVITE_MAX_DAYS}`);
  }
  return { patientId: body.patientId, patientCaregiverId: body.patientCaregiverId, expiresInDays };
}

function cleanSetting(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") invalid(field, "text");
  const text = (raw as string).trim();
  if (text.length === 0) return null;
  if (text.length > FAMILY_SETTING_TEXT_MAX) invalid(field, `at most ${FAMILY_SETTING_TEXT_MAX} characters`);
  return text;
}

/** The unblock guard raises a check_violation; the message reaches us through the driver's wrapper. */
function isSecondPersonRefusal(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    if (cursor instanceof Error && cursor.message.includes("message_family_contact_unblock")) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export function createFamilyStaffService(deps: FamilyStaffServiceDeps): FamilyStaffService {
  const isEnabled = async (orgId: string): Promise<boolean> =>
    deps.flags ? (await deps.flags.forOrg(orgId))[FAMILY_MESSAGING_FLAG_KEY] === true : false;

  const mayAct = async (actor: FamilyStaffActor, patientId: string): Promise<boolean> =>
    deps.canAccessPatient ? deps.canAccessPatient(actor.organizationId, actor.userId, patientId) : false;

  const requireOutbox = (what: string): HintOutboxPort => {
    if (!deps.outbox) throw new DegradedError("messaging", `the outbox is not configured; ${what}`);
    return deps.outbox;
  };

  /** A contact the actor may act on, or the uniform 404. */
  async function accessibleContact(
    actor: FamilyStaffActor,
    tx: FamilyStaffTx,
    contactId: string,
  ): Promise<FamilyContactRow> {
    if (!UUID_RE.test(contactId)) throw contactNotFound();
    const row = await tx.getContact(contactId);
    if (!row || !(await mayAct(actor, row.patientId))) throw contactNotFound();
    return row;
  }

  /**
   * The answer to revoke / block / unblock. These need only the manage permission (they REMOVE access, ADR-0099 D9), so the caller may not be on the
   * patient's team: then the answer carries the link state and nothing about the person (no names, no patient or caregiver id).
   */
  const summaryAfter = async (
    actor: FamilyStaffActor,
    tx: FamilyStaffTx,
    contactId: string,
  ): Promise<FamilyContactSummaryDto> => {
    const row = await tx.getContact(contactId);
    if (!row) throw contactNotFound();
    const summary = toSummary(row);
    if (await mayAct(actor, row.patientId)) return summary;
    return {
      ...summary,
      patientId: summary.contactId,
      patientCaregiverId: summary.contactId,
      patientName: "",
      displayName: "",
      relationship: "",
      language: null,
      channelId: null,
    };
  };

  return {
    isEnabled,

    getSettings: (actor) => deps.store.run(actor, (tx) => tx.getSettings()),

    async putSettings(actor, body) {
      const settings: FamilySettingsDto = {
        agencyName: cleanSetting(body.agencyName, "agencyName"),
        agencyPhone: cleanSetting(body.agencyPhone, "agencyPhone"),
        bereavementPhone: cleanSetting(body.bereavementPhone, "bereavementPhone"),
      };
      return deps.store.run(actor, (tx) => tx.putSettings(actor.userId, settings));
    },

    async caregivers(actor, patientId) {
      if (!UUID_RE.test(patientId) || !(await mayAct(actor, patientId))) throw new NotFoundError("patient");
      const rows = await deps.store.run(actor, (tx) => tx.caregivers(patientId));
      return rows.map((r) => ({
        patientCaregiverId: r.patientCaregiverId,
        displayName: r.caregiverName,
        relationship: r.relationship,
        isLegalRepresentative: r.isLegalRepresentative,
        eligible: r.reason === "ok",
        reason: r.reason,
        language: r.language,
      }));
    },

    async createInvitation(actor, body) {
      if (!(await isEnabled(actor.organizationId))) throw new NotFoundError("patient");
      if (deps.accessAvailable === false || !deps.pepper) {
        throw new ChartWardenError(
          FAMILY_ACCESS_UNAVAILABLE_CODE,
          "family messaging needs trusted proxy configuration and a code pepper",
          503,
        );
      }
      const input = validateCreate(body);
      const outbox = requireOutbox("nothing was issued");
      // The care-team predicate first (no break-glass): a holder of the permission who is not on this patient's team gets the 404 of an unknown patient.
      if (!(await mayAct(actor, input.patientId))) throw new NotFoundError("patient");
      const inviteToken = newPartnerToken();
      const verificationCode = newVerificationCode();
      const pepper = deps.pepper;
      const { contactId, expiresAt, agencyPhone } = await deps.store.run(actor, async (tx) => {
        await tx.lockTenant();
        const settings = await tx.getSettings();
        // D14: the 24-hour number must exist, or the not-an-emergency notice would have nothing to show.
        if (!settings.agencyPhone) {
          throw new ChartWardenError(
            FAMILY_SETTINGS_MISSING_CODE,
            "set the agency's 24-hour number before inviting a family contact",
            409,
          );
        }
        const caregiver = await tx.caregiver(input.patientCaregiverId);
        if (!caregiver || caregiver.patientId !== input.patientId) throw new NotFoundError("patient");
        // D2: no consent, no link. A reason code, not a bypass.
        if (caregiver.reason !== "ok") {
          throw new ChartWardenError(
            FAMILY_NOT_ELIGIBLE_CODE,
            "this person cannot be invited right now",
            409,
            [{ field: "patientCaregiverId", code: caregiver.reason, message: caregiver.reason }],
          );
        }
        const counts = await tx.counts(actor.userId);
        if (counts.orgDay >= FAMILY_INVITES_PER_ORG_DAY || counts.creatorDay >= FAMILY_INVITES_PER_CREATOR_DAY) {
          throw new ChartWardenError(FAMILY_LIMIT_CODE, "too many family invitations today; wait or revoke one", 429);
        }
        const id = await tx.ensureContact(actor.userId, caregiver);
        // A reissue is a NEW invitation that supersedes the old one: its sessions die with it, and the counter starts again with the new row.
        await tx.revokeLive(id, actor.userId, "superseded");
        const inserted = await tx.insertInvitation(actor.userId, {
          contactId: id,
          inviteTokenHash: hashPartnerToken(inviteToken),
          codeHash: hashVerificationCode(verificationCode, pepper),
          expiresInDays: input.expiresInDays,
        });
        await publishFamilyEvent(outbox, tx.raw, {
          kind: "created",
          orgId: actor.organizationId,
          contactId: id,
          actorUserId: actor.userId,
          expiresAt: inserted.expiresAt,
          at: new Date(),
        });
        return { contactId: id, expiresAt: inserted.expiresAt, agencyPhone: settings.agencyPhone };
      });
      return {
        contactId,
        organizationId: actor.organizationId,
        inviteToken,
        verificationCode,
        expiresAt: expiresAt.toISOString(),
        agencyPhone,
      };
    },

    async list(actor) {
      const rows = await deps.store.run(actor, (tx) => tx.listContacts());
      const allowed = new Map<string, boolean>();
      const out: FamilyContactSummaryDto[] = [];
      for (const row of rows) {
        let ok = allowed.get(row.patientId);
        if (ok === undefined) {
          ok = await mayAct(actor, row.patientId);
          allowed.set(row.patientId, ok);
        }
        if (ok) out.push(toSummary(row));
      }
      return out;
    },

    async thread(actor, contactId) {
      const cipher = deps.cipher;
      if (!cipher) throw new DegradedError("messaging", "message decryption is not configured");
      return deps.store.run(actor, async (tx) => {
        const row = await accessibleContact(actor, tx, contactId);
        const rawMessages = row.channelId ? await tx.messages(row.channelId, FAMILY_STAFF_THREAD_LIMIT) : [];
        const messages: FamilyStaffMessageDto[] = [];
        for (const m of rawMessages) {
          let body = "";
          if (!m.redacted) {
            const plaintext = await cipher.open(actor.organizationId, m.bodyCipher);
            const decoded = decodeStoredBody(m.bodyKind as Parameters<typeof decodeStoredBody>[0], plaintext);
            if (decoded.unreadable) continue; // never show a guess
            body = decoded.body;
          }
          messages.push({
            messageId: m.id,
            from: m.authorKind === "family_contact" ? "contact" : "staff",
            authorName: m.authorKind === "family_contact" ? null : m.authorName,
            body,
            createdAt: m.createdAt.toISOString(),
          });
        }
        // The thread is now in a worked queue: that, and only that, is what "received by the care team" means to the contact (D4).
        if (row.channelId) await tx.markSeen(contactId);
        return { contact: toSummary(row), messages };
      });
    },

    async reply(actor, contactId, rawBody) {
      if (!(await isEnabled(actor.organizationId))) throw contactNotFound();
      const cipher = deps.cipher;
      if (!cipher) throw new DegradedError("messaging", "message encryption is not configured");
      return deps.store.run(actor, async (tx) => {
        const row = await accessibleContact(actor, tx, contactId);
        const body = validateMessageText(rawBody);
        // D10: a reply is refused unless the contact is covered RIGHT NOW (the restricted-patient check of a care-team reply, the same expression the
        // contact's own requests use). A Part 2 patient, a withdrawn consent or a block means nothing is posted.
        if (row.reason !== "ok") {
          throw new ChartWardenError(FAMILY_NOT_ELIGIBLE_CODE, "this contact cannot be replied to right now", 409, [
            { field: "contactId", code: row.reason, message: row.reason },
          ]);
        }
        if (row.closed) {
          throw new ChartWardenError(FAMILY_THREAD_CLOSED_CODE, "this conversation is closed; reopen it to reply", 409);
        }
        if (!row.channelId) throw new ConflictError("the contact has not written yet; there is nothing to reply to");
        const write = deps.insertMessage ?? insertEncryptedMessage;
        const sent = await write(tx.raw as Tx, cipher as MessageBodyCipher, {
          orgId: actor.organizationId,
          channelId: row.channelId,
          authorUserId: actor.userId,
          body,
          familyThread: "staff",
        });
        await tx.markReplied(contactId);
        return {
          messageId: sent.messageId,
          from: "staff" as const,
          authorName: null,
          body,
          createdAt: sent.createdAt,
        };
      });
    },

    async revoke(actor, contactId) {
      const outbox = requireOutbox("nothing was revoked");
      return deps.store.run(actor, async (tx) => {
        // Revoke needs the permission and a step-up (route) and never the flag; it removes access, so it asks only that the contact exists in the tenant.
        if (!UUID_RE.test(contactId) || !(await tx.getContact(contactId))) throw contactNotFound();
        if (!(await tx.revokeLive(contactId, actor.userId, "staff"))) {
          throw new ConflictError("this contact has no live link");
        }
        await publishFamilyEvent(outbox, tx.raw, {
          kind: "revoked",
          orgId: actor.organizationId,
          contactId,
          actorUserId: actor.userId,
          reason: "staff",
          at: new Date(),
        });
        return summaryAfter(actor, tx, contactId);
      });
    },

    async setClosed(actor, contactId, closed) {
      return deps.store.run(actor, async (tx) => {
        await accessibleContact(actor, tx, contactId);
        if (!(await tx.setClosed(contactId, actor.userId, closed))) {
          throw new ConflictError(closed ? "this conversation is already closed" : "this conversation is not closed");
        }
        return summaryAfter(actor, tx, contactId);
      });
    },

    async setBlocked(actor, contactId, blocked) {
      const outbox = requireOutbox("nothing was changed");
      try {
        return await deps.store.run(actor, async (tx) => {
          if (!UUID_RE.test(contactId) || !(await tx.getContact(contactId))) throw contactNotFound();
          if (!(await tx.setBlocked(contactId, actor.userId, blocked))) {
            throw new ConflictError(blocked ? "this contact is already blocked" : "this contact is not blocked");
          }
          if (blocked) {
            // D8: a block revokes the link on the same transaction; reissue needs the block lifted by a second person first.
            if (await tx.revokeLive(contactId, actor.userId, "blocked")) {
              await publishFamilyEvent(outbox, tx.raw, {
                kind: "revoked",
                orgId: actor.organizationId,
                contactId,
                actorUserId: actor.userId,
                reason: "blocked",
                at: new Date(),
              });
            }
          }
          return summaryAfter(actor, tx, contactId);
        });
      } catch (error) {
        if (!blocked && isSecondPersonRefusal(error)) {
          throw new ConflictError("a block is lifted by a second person, not the one who set it");
        }
        throw error;
      }
    },
  };
}
