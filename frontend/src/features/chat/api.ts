import type {
  ChatMessage,
  CompanionState,
  DiaryEntry,
  Emotion,
  PresentationCondition,
  ResearchSession,
  ResearchSurveyScores,
} from './types';

// --- 認証トークン(localStorage)---
const TOKEN_KEY = 'aikata_token';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

/** Cookie(匿名ID)も送るため credentials: 'include'。JWT があれば付与。 */
function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'include',
    headers: authHeaders(init.headers as Record<string, string> | undefined),
  });
}

const jsonHeaders = { 'Content-Type': 'application/json' };

// --- 認証 ---
export interface AuthResult {
  ok: boolean;
  error?: string;
}

export async function signup(email: string, password: string): Promise<AuthResult> {
  const r = await apiFetch('/api/auth/signup', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data.detail ?? `登録に失敗しました (${r.status})` };
  setToken(data.token);
  return { ok: true };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const r = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data.detail ?? `ログインに失敗しました (${r.status})` };
  setToken(data.token);
  return { ok: true };
}

export const fetchMe = (): Promise<{ authenticated: boolean; email: string | null }> =>
  apiFetch('/api/auth/me').then((r) => r.json());

// --- チャット ---
export async function streamChat(
  message: string,
  condition: PresentationCondition,
  events: ChatEvents,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiFetch('/api/chat', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ message, condition }),
    signal,
  });
  if (response.status === 429) {
    const data = await response.json().catch(() => ({}));
    events.onError(data.detail ?? '本日の上限に達しました。');
    return;
  }
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

export interface ChatEvents {
  onEmotion: (emotion: Emotion) => void;
  onToken: (text: string) => void;
  onDone: (state: CompanionState) => void;
  onError: (message: string) => void;
}

export function requestedConditionFromUrl(): PresentationCondition | null {
  const value = new URLSearchParams(window.location.search).get('condition');
  return value === 'text' || value === 'stylized' || value === 'realistic' ? value : null;
}

export async function startResearchSession(
  requestedCondition: PresentationCondition | null,
): Promise<ResearchSession> {
  const r = await apiFetch('/api/research/session', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ condition: requestedCondition, source: 'web' }),
  });
  return r.json();
}

export async function logResearchEvent(
  condition: PresentationCondition,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await apiFetch('/api/research/event', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ condition, event_type: eventType, payload }),
  }).catch(() => {});
}

export async function submitResearchSurvey(
  condition: PresentationCondition,
  scores: ResearchSurveyScores,
  context: Record<string, unknown>,
): Promise<void> {
  await logResearchEvent(condition, 'survey_response', { scores, context });
}

export const fetchState = (): Promise<CompanionState> =>
  apiFetch('/api/state').then((r) => r.json());

export const fetchHistory = (): Promise<ChatMessage[]> =>
  apiFetch('/api/history').then(async (r) => {
    if (!r.ok) return [];
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  });

export const setProfile = (userName: string): Promise<CompanionState> =>
  apiFetch('/api/profile', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ user_name: userName }),
  }).then((r) => r.json());

export const requestNudge = (
  reason: 'idle' | 'greeting',
): Promise<{ text: string; emotion: Emotion }> => {
  const fallback = { text: '', emotion: 'neutral' as Emotion };
  return apiFetch('/api/nudge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  }).then(async (r) => {
    if (!r.ok) return fallback;
    const data = await r.json().catch(() => fallback);
    return typeof data.text === 'string' ? data : fallback;
  });
};

export const fetchDiary = (): Promise<{
  entries: DiaryEntry[];
  can_generate_today: boolean;
}> => apiFetch('/api/diary').then((r) => r.json());

export const generateDiary = (): Promise<{
  ok: boolean;
  entry?: DiaryEntry;
  reason?: string;
}> => apiFetch('/api/diary/generate', { method: 'POST' }).then((r) => r.json());
