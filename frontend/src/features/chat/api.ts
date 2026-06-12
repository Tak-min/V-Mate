import type { ChatMessage, CompanionState, DiaryEntry, Emotion } from './types';

export interface ChatEvents {
  onEmotion: (emotion: Emotion) => void;
  onToken: (text: string) => void;
  onDone: (state: CompanionState) => void;
  onError: (message: string) => void;
}

export async function streamChat(message: string, events: ChatEvents): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!response.ok || !response.body) {
    events.onError(`サーバーに接続できませんでした (${response.status})`);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      switch (data.type) {
        case 'emotion':
          events.onEmotion(data.emotion as Emotion);
          break;
        case 'token':
          events.onToken(data.text as string);
          break;
        case 'done':
          events.onDone(data as CompanionState);
          break;
        case 'error':
          events.onError(data.message as string);
          break;
      }
    }
  }
}

export const fetchState = (): Promise<CompanionState> =>
  fetch('/api/state').then((r) => r.json());

export const fetchHistory = (): Promise<ChatMessage[]> =>
  fetch('/api/history').then((r) => r.json());

export const setProfile = (userName: string): Promise<CompanionState> =>
  fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: userName }),
  }).then((r) => r.json());

export const requestNudge = (
  reason: 'idle' | 'greeting',
): Promise<{ text: string; emotion: Emotion }> =>
  fetch('/api/nudge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }).then((r) => r.json());

export const fetchDiary = (): Promise<{
  entries: DiaryEntry[];
  can_generate_today: boolean;
}> => fetch('/api/diary').then((r) => r.json());

export const generateDiary = (): Promise<{
  ok: boolean;
  entry?: DiaryEntry;
  reason?: string;
}> => fetch('/api/diary/generate', { method: 'POST' }).then((r) => r.json());
