export type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'relaxed' | 'shy';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  emotion?: Emotion;
}

export interface CompanionState {
  user_name: string | null;
  affinity: number;
  stage: string;
  next_stage_at: number | null;
  provider: string;
}

export interface DiaryEntry {
  entry_date: string;
  content: string;
}
