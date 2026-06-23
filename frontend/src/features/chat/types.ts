export type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'relaxed' | 'shy';
export type PresentationCondition = 'text' | 'stylized' | 'realistic';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  emotion?: Emotion;
  cue?: string;
}

export interface CompanionState {
  user_name: string | null;
  affinity: number;
  stage: string;
  next_stage_at: number | null;
  provider: string;
  recent_facts?: string[];
}

export interface ResearchSession {
  condition: PresentationCondition;
  conditions: PresentationCondition[];
  metrics_version: string;
}

export interface ResearchSurveyScores {
  social_presence: number;
  trust: number;
  self_disclosure_comfort: number;
  continued_use_intention: number;
  usability: number;
  eeriness: number;
}

export interface DiaryEntry {
  entry_date: string;
  content: string;
}
