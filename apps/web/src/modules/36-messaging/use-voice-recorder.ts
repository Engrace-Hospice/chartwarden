// M36 WP 6.3 (ADR-0094 decision 1) - the recorder behind the composer's voice-note button. It records with MediaRecorder, stops itself at
// the 5 minute cap, and hands the finished file to the ordinary attachment pipeline (the caller does that). It never sends audio
// anywhere and never recognises speech. An interrupted recording (tab hidden, microphone lost, recorder error) is discarded, never
// kept as a success. The microphone is requested only when the user starts a recording.
import { MAX_VOICE_NOTE_BYTES, MAX_VOICE_NOTE_SECONDS } from "@chartwarden/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { baseMimeType } from "./attachment-utils";
import {
  VOICE_NOTICE,
  classifyMicrophoneError,
  pickRecorderMimeType,
  voiceNoteFileName,
} from "./voice-note-utils";

export type RecorderPhase = "idle" | "starting" | "recording" | "paused" | "review";

export interface VoiceReview {
  readonly file: File;
  readonly url: string;
}

export interface VoiceRecorder {
  readonly phase: RecorderPhase;
  readonly elapsedSeconds: number;
  /** A sentence about what just happened (denied, interrupted, hit the limit); null when there is nothing to say. */
  readonly notice: string | null;
  readonly review: VoiceReview | null;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Throws away the recording (or the one in progress) and returns to idle. */
  discard(): void;
  /** Hands the reviewed file over and returns to idle; null when there is none. */
  take(): File | null;
}

const TICK_MS = 250;

/** Both are needed; Safari before 14.1 and some embedded webviews have neither. */
export function canRecordVoice(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function useVoiceRecorder(): VoiceRecorder {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<VoiceReview | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Elapsed recording time excludes paused time: banked milliseconds plus the running segment.
  const bankedMsRef = useRef(0);
  const segmentStartRef = useRef(0);
  // Recorders being thrown away: their (asynchronous) `stop` event must produce nothing, even if a new recording has started since.
  const discardedRef = useRef(new WeakSet<MediaRecorder>());
  // Bumped whenever a start in flight must be cancelled (Discard, abandon, unmount) so a late getUserMedia answer releases the microphone.
  const generationRef = useRef(0);
  const limitHitRef = useRef(false);
  const reviewUrlRef = useRef<string | null>(null);
  const startingRef = useRef(false);

  const elapsedMs = useCallback(
    () =>
      bankedMsRef.current +
      (recorderRef.current?.state === "recording" ? Date.now() - segmentStartRef.current : 0),
    [],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const releaseMicrophone = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const revokeReview = useCallback(() => {
    if (reviewUrlRef.current) URL.revokeObjectURL(reviewUrlRef.current);
    reviewUrlRef.current = null;
  }, []);

  /** Tear down an in-progress recording without keeping anything; `message` explains why (or null for a silent discard). */
  const abandon = useCallback(
    (message: string | null) => {
      generationRef.current += 1;
      clearTimer();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) discardedRef.current.add(recorder);
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Already stopped by the browser: the microphone is released below either way.
        }
      }
      releaseMicrophone();
      chunksRef.current = [];
      bankedMsRef.current = 0;
      setElapsedSeconds(0);
      setPhase("idle");
      setNotice(message);
    },
    [clearTimer, releaseMicrophone],
  );

  const finish = useCallback(
    (mimeType: string) => {
      clearTimer();
      releaseMicrophone();
      recorderRef.current = null;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      bankedMsRef.current = 0;
      const hitLimit = limitHitRef.current;
      limitHitRef.current = false;
      setElapsedSeconds(0);
      const blob = new Blob(chunks, { type: baseMimeType(mimeType) });
      if (blob.size === 0) {
        setPhase("idle");
        setNotice(VOICE_NOTICE.empty);
        return;
      }
      if (blob.size > MAX_VOICE_NOTE_BYTES) {
        setPhase("idle");
        setNotice(VOICE_NOTICE.tooLarge);
        return;
      }
      const file = new File([blob], voiceNoteFileName(new Date(), baseMimeType(mimeType)), {
        type: baseMimeType(mimeType),
      });
      revokeReview();
      const url = URL.createObjectURL(file);
      reviewUrlRef.current = url;
      setReview({ file, url });
      setNotice(hitLimit ? VOICE_NOTICE.limit : null);
      setPhase("review");
    },
    [clearTimer, releaseMicrophone, revokeReview],
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || recorderRef.current) return;
    startingRef.current = true;
    setNotice(null);
    setPhase("starting");
    const generation = generationRef.current;
    try {
      if (!canRecordVoice()) {
        setPhase("idle");
        setNotice(VOICE_NOTICE.unsupported);
        return;
      }
      const mimeType = pickRecorderMimeType(MediaRecorder);
      if (!mimeType) {
        setPhase("idle");
        setNotice(VOICE_NOTICE.unsupported);
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        setPhase("idle");
        setNotice(VOICE_NOTICE[classifyMicrophoneError(error)]);
        return;
      }
      if (generation !== generationRef.current) {
        // Discarded or unmounted while the permission prompt was open: release the microphone, record nothing.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      limitHitRef.current = false;
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (discardedRef.current.has(recorder)) return;
        finish(mimeType);
      };
      recorder.onerror = () => abandon(VOICE_NOTICE.interrupted);
      // The microphone going away mid-recording (unplugged, permission revoked) ends the tracks.
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (recorderRef.current === recorder) abandon(VOICE_NOTICE.interrupted);
        });
      }
      bankedMsRef.current = 0;
      segmentStartRef.current = Date.now();
      recorder.start();
      setElapsedSeconds(0);
      setPhase("recording");
      timerRef.current = setInterval(() => {
        const seconds = Math.floor(elapsedMs() / 1000);
        if (seconds >= MAX_VOICE_NOTE_SECONDS) {
          limitHitRef.current = true;
          stop();
          return;
        }
        setElapsedSeconds(seconds);
      }, TICK_MS);
    } finally {
      startingRef.current = false;
    }
  }, [abandon, elapsedMs, finish, stop]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "recording") return;
    bankedMsRef.current += Date.now() - segmentStartRef.current;
    recorder.pause();
    setPhase("paused");
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "paused") return;
    segmentStartRef.current = Date.now();
    recorder.resume();
    setPhase("recording");
  }, []);

  const discard = useCallback(() => {
    generationRef.current += 1;
    if (recorderRef.current) abandon(null);
    revokeReview();
    setReview(null);
    setNotice(null);
    setPhase("idle");
  }, [abandon, revokeReview]);

  const take = useCallback((): File | null => {
    const file = review?.file ?? null;
    revokeReview();
    setReview(null);
    setNotice(null);
    setPhase("idle");
    return file;
  }, [review, revokeReview]);

  // A hidden page can lose the microphone without telling us (iOS Safari), so a recording in progress is discarded, never trusted.
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") abandon(VOICE_NOTICE.hidden);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [phase, abandon]);

  // Unmount: release the microphone and the object URL; nothing is kept.
  useEffect(
    () => () => {
      generationRef.current += 1;
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = recorderRef.current;
      if (recorder) discardedRef.current.add(recorder);
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Already stopped.
        }
      }
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      if (reviewUrlRef.current) URL.revokeObjectURL(reviewUrlRef.current);
    },
    [],
  );

  return { phase, elapsedSeconds, notice, review, start, pause, resume, stop, discard, take };
}
