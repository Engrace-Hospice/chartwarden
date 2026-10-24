// M36 WP 6.7 (ADR-0099, PROPOSED) - the storage ports of family messaging. The services hold every rule; the Drizzle stores are only reads and writes inside
// ONE tenant transaction, so the unit matrix runs against a fake and the live suite proves the SQL. Every liveness judgement (revoked, expired, stage, and
// the whole eligibility of D2/D10/D12) is made by the DATABASE clock in the same statement as the read it protects: nothing is cached.
import type {
  FamilyEligibilityReason,
  FamilyMode,
  FamilySessionStage,
  FamilySettingsDto,
} from "@chartwarden/types";

export interface FamilyStaffActor {
  readonly organizationId: string;
  readonly userId: string;
}

/** What the invite screen needs to know about one caregiver of a patient, in one statement (the reason is the D2/D10/D12 expression). */
export interface FamilyCaregiverRow {
  readonly patientCaregiverId: string;
  readonly patientId: string;
  readonly caregiverName: string;
  readonly relationship: string;
  readonly isLegalRepresentative: boolean;
  readonly language: string | null;
  readonly reason: FamilyEligibilityReason;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

export interface FamilyContactRow {
  readonly contactId: string;
  readonly patientId: string;
  readonly patientCaregiverId: string;
  readonly patientName: string;
  readonly caregiverName: string;
  readonly relationship: string;
  readonly reason: FamilyEligibilityReason;
  readonly mode: FamilyMode;
  readonly language: string | null;
  readonly closed: boolean;
  readonly blocked: boolean;
  readonly blockedBy: string | null;
  readonly channelId: string | null;
  readonly lastContactMessageAt: Date | null;
  readonly lastStaffReplyAt: Date | null;
  readonly staffSeenThrough: Date | null;
  /** The live (unrevoked) invitation's state, or null when there is none. */
  readonly invitation: {
    readonly expiresAt: Date;
    readonly redeemed: boolean;
    readonly codeAttempts: number;
    readonly activeSession: boolean;
    readonly verifyingSession: boolean;
  } | null;
  readonly sentLastHour: number;
  /** The oldest contact message newer than the last staff reply, or null when everything is answered. */
  readonly unansweredSince: Date | null;
  /** An earlier invitation of this contact was revoked (distinguishes `revoked` from `none` when no invitation is live). */
  readonly hadRevokedInvitation: boolean;
  /** The database's `now()` when the row was read: every judgement uses this, never the app clock. */
  readonly dbNow: Date;
}

export interface FamilyStaffMessageRow {
  readonly id: string;
  readonly authorKind: string;
  readonly authorName: string | null;
  readonly bodyCipher: Buffer;
  readonly bodyKind: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly redacted: boolean;
}

export interface NewFamilyInvitation {
  readonly contactId: string;
  readonly inviteTokenHash: string;
  readonly codeHash: string;
  readonly expiresInDays: number;
}

export interface FamilyStaffTx {
  /** The raw transaction handle the outbox and the message writer use. */
  readonly raw: unknown;
  /** Serialise invitation creation per tenant so two concurrent creates cannot both pass the daily caps. */
  lockTenant(): Promise<void>;
  getSettings(): Promise<FamilySettingsDto>;
  putSettings(userId: string, settings: FamilySettingsDto): Promise<FamilySettingsDto>;
  /** Every caregiver of the patient with the eligibility reason. */
  caregivers(patientId: string): Promise<FamilyCaregiverRow[]>;
  caregiver(patientCaregiverId: string): Promise<FamilyCaregiverRow | null>;
  /** Existing contact for the person, or a new one (the thread link). Returns the contact id. */
  ensureContact(userId: string, caregiver: FamilyCaregiverRow): Promise<string>;
  counts(creatorUserId: string): Promise<{ readonly orgDay: number; readonly creatorDay: number }>;
  /** Revokes the live invitation of a contact, if any. Returns whether one was revoked. */
  revokeLive(
    contactId: string,
    userId: string,
    reason: "staff" | "superseded" | "blocked",
  ): Promise<boolean>;
  insertInvitation(
    userId: string,
    input: NewFamilyInvitation,
  ): Promise<{ readonly expiresAt: Date }>;
  getContact(contactId: string): Promise<FamilyContactRow | null>;
  listContacts(): Promise<FamilyContactRow[]>;
  setClosed(contactId: string, userId: string, closed: boolean): Promise<boolean>;
  setBlocked(contactId: string, userId: string, blocked: boolean): Promise<boolean>;
  /** Messages of the contact's channel, oldest first, at most `limit`, newest page last. */
  messages(channelId: string, limit: number): Promise<FamilyStaffMessageRow[]>;
  /** The staff has the thread in a worked queue: everything up to the database's now is "received". */
  markSeen(contactId: string, through: Date): Promise<void>;
  /** Records the staff reply instant (forward only). */
  markReplied(contactId: string): Promise<void>;
}

export interface FamilyStaffStore {
  run<T>(actor: FamilyStaffActor, fn: (tx: FamilyStaffTx) => Promise<T>): Promise<T>;
}

/** What one request's bearer resolves to, in ONE statement; absent means "no live, eligible session" and nothing more. */
export interface FamilyLiveSession {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly invitationId: string;
  readonly contactId: string;
  readonly patientId: string;
  readonly stage: FamilySessionStage;
  readonly sessionExpiresAt: Date;
  /** The mode the person is eligible in RIGHT NOW (D15). */
  readonly mode: FamilyMode;
  /** The mode stored on the contact row (the switch is recorded the first time it differs). */
  readonly storedMode: FamilyMode;
  readonly closed: boolean;
  readonly channelId: string | null;
  readonly language: string | null;
  readonly staffSeenThrough: Date | null;
}

export interface FamilyContactRawMessage {
  readonly id: string;
  readonly authorKind: string;
  readonly bodyCipher: Buffer;
  readonly bodyKind: string;
  readonly createdAtText: string;
}

export interface FamilySendBudget {
  readonly lastHour: number;
  readonly lastDay: number;
  /** Contact messages since the last staff reply (D8 cap). */
  readonly sinceStaffReply: number;
}

export interface FamilyContactTx {
  readonly raw: unknown;
  /** Single use: redeems the link by hash if it is unredeemed, unrevoked and unexpired NOW. */
  redeemInvite(
    tokenHash: string,
  ): Promise<{ readonly invitationId: string; readonly expiresAt: Date } | null>;
  insertSession(invitationId: string, tokenHash: string): Promise<{ readonly sessionId: string }>;
  /** ONE statement: liveness of session + invitation + the whole eligibility; a hit touches last_seen_at. */
  resolveSession(tokenHash: string): Promise<FamilyLiveSession | null>;
  /** Counts the attempt FIRST (atomically, capped at 5) and returns the stored code hash; null when locked or gone. */
  takeCodeAttempt(invitationId: string): Promise<string | null>;
  activate(sessionId: string, newTokenHash: string): Promise<void>;
  getSettings(): Promise<FamilySettingsDto>;
  /** Records standard -> bereavement the first time the person is eligible only in that mode. */
  switchToBereavement(contactId: string): Promise<void>;
  visibleMessages(
    live: FamilyLiveSession,
    after: { readonly createdAtText: string; readonly id: string } | null,
    limit: number,
  ): Promise<FamilyContactRawMessage[]>;
  sendBudget(live: FamilyLiveSession): Promise<FamilySendBudget>;
  /** Creates the `family` channel at the first send and names it on the contact (row-locked, so two first sends make one channel). */
  ensureChannel(live: FamilyLiveSession): Promise<string>;
  /** Moves the contact's activity instant forward. */
  touchContactMessage(contactId: string): Promise<void>;
  /** The access-trail row; the database guard refuses it unless the session is active and the invitation live NOW. */
  recordAccess(
    live: FamilyLiveSession,
    action: "read" | "send",
    messageCount: number,
    messageId: string | null,
  ): Promise<void>;
}

export interface FamilyContactStore {
  run<T>(organizationId: string, fn: (tx: FamilyContactTx) => Promise<T>): Promise<T>;
}
