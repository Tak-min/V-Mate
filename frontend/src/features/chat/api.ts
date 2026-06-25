import type { ChatMessage, CompanionState, DiaryEntry, Emotion } from './types';

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
  events: ChatEvents,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiFetch('/api/chat', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ message }),
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
  opts: { firstVisit?: boolean } = {},
): Promise<{ text: string; emotion: Emotion; days_away?: number | null }> => {
  const fallback = { text: '', emotion: 'neutral' as Emotion, days_away: null };
  // first_visit は greeting のときだけ意味を持つ(サーバは idle 要求では無視する)。
  return apiFetch('/api/nudge', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason, first_visit: opts.firstVisit === true }),
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
