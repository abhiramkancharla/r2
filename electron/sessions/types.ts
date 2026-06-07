export type SessionEventKind =
  | 'submit'         // generic explicit submission
  | 'ai_message'     // sent to ChatGPT/Claude/Gemini/etc
  | 'assistant_reply'// AI reply captured from screen (via AX tree walk)
  | 'search_query'   // submitted in google/youtube/duckduckgo
  | 'message_sent'   // chat apps (Slack, Discord, Messages)
  | 'note_saved'     // notes/editors
  | 'navigate';      // URL change in a browser context

export type SessionEvent = {
  kind: SessionEventKind;
  ts: number;       // ms since epoch
  text?: string;    // for submission-style events
  url?: string;     // for navigate
};

export type Session = {
  id: string;
  startTs: number;
  endTs: number | null;
  durationMs: number | null;
  app: string;
  title: string;
  url: string | null;
  bundleId: string | null;
  category: string;
  events: SessionEvent[];
};

export type DayLog = {
  date: string;          // YYYY-MM-DD (local)
  generatedAt: number;   // ms since epoch — bumped on every write
  sessions: Session[];   // oldest first, last entry may be open (endTs === null)
};
