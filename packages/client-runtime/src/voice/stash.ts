/**
 * Holds completed voice transcripts whose target composer went away before the transcription
 * finished (thread/workspace switch, navigation). The completion handler stashes the text under
 * the composer identity it was recorded against; when a composer with that identity is active
 * again it takes the entry and inserts it, so a finished transcript is never silently dropped.
 */
export type VoiceTranscriptStashEntry = {
  readonly text: string;
  readonly stashedAt: number;
};

export type VoiceTranscriptStash = {
  put(identity: string, text: string): void;
  /** Removes and returns the entry for this identity, if any. */
  take(identity: string): VoiceTranscriptStashEntry | null;
  peek(identity: string): VoiceTranscriptStashEntry | null;
  clear(): void;
};

export function createVoiceTranscriptStash(options?: {
  readonly now?: () => number;
  /** Entries older than this are dropped on access; defaults to 30 minutes. */
  readonly ttlMs?: number;
}): VoiceTranscriptStash {
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? 30 * 60_000;
  const entries = new Map<string, VoiceTranscriptStashEntry>();

  const fresh = (identity: string): VoiceTranscriptStashEntry | null => {
    const entry = entries.get(identity);
    if (!entry) return null;
    if (now() - entry.stashedAt > ttlMs) {
      entries.delete(identity);
      return null;
    }
    return entry;
  };

  return {
    put: (identity, text) => {
      if (!text.trim()) return;
      entries.set(identity, { text, stashedAt: now() });
    },
    take: (identity) => {
      const entry = fresh(identity);
      if (entry) entries.delete(identity);
      return entry;
    },
    peek: fresh,
    clear: () => entries.clear(),
  };
}
