// apps/backend/src/modules/36-messaging/attachments/voice-notes-flag.ts - WP 6.3 (ADR-0094): the tenant flag `messaging.voice_notes`,
// read through the platform's FeatureFlagReaderPort (tenant row wins; absent = off) and cached a few seconds per org like its siblings,
// so a kill switch lands within that window. No reader (a no-db boot) reads as off.
import { VOICE_NOTES_FLAG_KEY } from "@chartwarden/types";
import { cacheFlagRead } from "../presence/binding";

export interface VoiceNotesFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

export function buildVoiceNotesEnabled(
  flags: VoiceNotesFlagReader | undefined,
): (organizationId: string) => Promise<boolean> {
  return cacheFlagRead(async (organizationId) =>
    flags ? (await flags.forOrg(organizationId))[VOICE_NOTES_FLAG_KEY] === true : false,
  );
}
