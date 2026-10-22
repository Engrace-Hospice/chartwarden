import type Redis from "ioredis";
import type { StepUpChallenge, StepUpChallengeStore } from "./step-up-ports";

const PREFIX = "chartwarden:m2:step-up";
const LOCKOUT_WINDOW_SEC = 60;

export function createValkeyStepUpChallengeStore(redis: Redis): StepUpChallengeStore {
  const challengeKey = (id: string) => `${PREFIX}:challenge:${id}`;
  const failureKey = (sessionId: string) => `${PREFIX}:failures:${sessionId}`;

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
      const key = failureKey(sessionId);
      if ((await redis.incr(key)) === 1) await redis.expire(key, LOCKOUT_WINDOW_SEC);
    },

    async recentFailureCount(sessionId) {
      return Number((await redis.get(failureKey(sessionId))) ?? 0);
    },

    async clearFailures(sessionId) {
      await redis.del(failureKey(sessionId));
    },
  };
}
