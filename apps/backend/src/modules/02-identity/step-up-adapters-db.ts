import { type DbClient, schema } from "@wardenx/db";
import { and, eq } from "drizzle-orm";
import type {
  MfaEnrollmentReader,
  SessionResolver,
  SessionStepUpWriter,
} from "./step-up-ports";

export function createDbStepUpSessionResolver(db: DbClient): SessionResolver {
  return {
    async resolve(request) {
      const userId = request.context.userId;
      const organizationId = request.context.organizationId;
      const sessionId = request.context.attributes?.sessionId;
      const membershipId = request.context.attributes?.membershipId;

      if (
        !userId ||
        !organizationId ||
        typeof sessionId !== "string" ||
        typeof membershipId !== "string"
      ) {
        return null;
      }

      const [session] = await db
        .select({
          lastStepUpAt: schema.sessions.lastStepUpAt,
          lastStepUpFactor: schema.sessions.lastStepUpFactor,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.userId, userId),
          ),
        )
        .limit(1);

      if (!session) return null;

      return {
        sessionId,
        userId,
        organizationId,
        membershipId,
        lastStepUpAt: session.lastStepUpAt,
        lastStepUpFactor: session.lastStepUpFactor,
      };
    },
  };
}

export function createDbMfaEnrollmentReader(db: DbClient): MfaEnrollmentReader {
  return {
    async hasFactor({ userId, factor }) {
      if (factor === "webauthn") {
        const [row] = await db
          .select({ id: schema.passkey.id })
          .from(schema.passkey)
          .where(eq(schema.passkey.userId, userId))
          .limit(1);

        return Boolean(row);
      }

      const [row] = await db
        .select({ id: schema.twoFactor.id })
        .from(schema.twoFactor)
        .where(
          and(
            eq(schema.twoFactor.userId, userId),
            eq(schema.twoFactor.method, "totp"),
            eq(schema.twoFactor.verified, true),
          ),
        )
        .limit(1);

      return Boolean(row);
    },
  };
}

export function createDbSessionStepUpWriter(db: DbClient): SessionStepUpWriter {
  return {
    async recordStepUp({ sessionId, factor, at }) {
      await db
        .update(schema.sessions)
        .set({
          lastStepUpAt: at,
          lastStepUpFactor: factor,
        })
        .where(eq(schema.sessions.id, sessionId));
    },

    async terminate({ sessionId }) {
      await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    },
  };
}