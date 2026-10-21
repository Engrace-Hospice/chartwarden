import type Redis from "ioredis";
import type { StepUpChallenge, StepUpChallengeStore } from "./step-up-ports";

const PREFIX = "chartwarden:m2:step-up";
// LEGACY(wardenx->chartwarden): remove after 60 s (LOCKOUT_WINDOW_SEC) post release B. Challenges switch outright (an in-flight
// one simply expires); the lockout counter is incremented in BOTH prefixes and read as the max of the two, so an old pod's
// failures and a new pod's failures are both seen by either (never an extra attempt window across the deploy).
const LEGACY_PREFIX = "wardenx:m2:step-up";
const LOCKOUT_WINDOW_SEC = 60;

export function createValkeyStepUpChallengeStore(redis: Redis): StepUpChallengeStore {
  const challengeKey = (id: string) => `${PREFIX}:challenge:${id}`;
  const failureKeys = (sessionId: string) => ({
    legacyKey: `${LEGACY_PREFIX}:failures:${sessionId}`,
    newKey: `${PREFIX}:failures:${sessionId}`,
  });

  return {
    async put(challengeId, challenge, ttlSec) {
      await redis.set(challengeKey(challengeId), JSON.stringify(challenge), "EX", ttlSec);
    },

    async get(challengeId) {
      const value = await redis.get(challengeKey(challengeId));
      if (!value) return null;

      try {
        return JSON.parse(value) as StepUpChallenge;
      } catch {
        await redis.del(challengeKey(challengeId));
        return null;
      }
    },

    async del(challengeId) {
      await redis.del(challengeKey(challengeId));
    },

    async recordFailure(sessionId) {
      const { legacyKey, newKey } = failureKeys(sessionId);
      for (const key of [legacyKey, newKey]) {
        if ((await redis.incr(key)) === 1) await redis.expire(key, LOCKOUT_WINDOW_SEC);
      }
    },

    async recentFailureCount(sessionId) {
      const { legacyKey, newKey } = failureKeys(sessionId);
      const [legacy, current] = await Promise.all([redis.get(legacyKey), redis.get(newKey)]);
      return Math.max(Number(legacy ?? 0), Number(current ?? 0));
    },

    async clearFailures(sessionId) {
      const { legacyKey, newKey } = failureKeys(sessionId);
      await redis.del(legacyKey, newKey);
    },
  };
}
