import { FormEvent, useEffect, useState } from 'react';
import { fetchMe, login, logout as apiLogout, signup } from '../features/chat/api';

/**
 * 認証バー(右上)。未ログインなら登録/ログイン、ログイン済みならメール+ログアウト。
 * アプリは匿名Cookieでも動くため、認証は任意(ログインで端末を越えて記憶が継続)。
 */
export function AuthBar() {
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchMe()
      .then((me) => setEmail(me.authenticated ? me.email : null))
      .catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const fn = mode === 'login' ? login : signup;
    const res = await fn(form.email, form.password);
    setBusy(false);
    if (res.ok) {
      window.location.reload(); // 新しい身元で記憶・履歴を再取得
    } else {
      setError(res.error ?? 'うまくいきませんでした');
    }
  };

  const logout = async () => {
    await apiLogout();
    window.location.reload();
  };

  if (email) {
    return (
      <div className="auth-bar">
        <div className="auth-pill">
          <span className="auth-email">{email}</span>
          <button type="button" className="auth-logout" onClick={logout}>
            ログアウト
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-bar">
      {!open ? (
        <button type="button" className="auth-pill" onClick={() => setOpen(true)}>
          ログイン / 登録
        </button>
      ) : (
        <form onSubmit={submit} className="auth-card">
          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab${mode === 'login' ? ' active' : ''}`}
              onClick={() => setMode('login')}
            >
              ログイン
            </button>
            <button
              type="button"
              className={`auth-tab${mode === 'signup' ? ' active' : ''}`}
              onClick={() => setMode('signup')}
            >
              新規登録
            </button>
          </div>
          <input
            type="email"
            placeholder="メールアドレス"
            value={form.email}
            autoComplete="email"
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <input
            type="password"
            placeholder="パスワード(6文字以上)"
            value={form.password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={6}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
          {error && <p className="auth-error">{error}</p>}
          <div className="auth-actions">
            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? '…' : mode === 'login' ? 'ログイン' : '登録する'}
            </button>
            <button type="button" className="auth-cancel" onClick={() => setOpen(false)}>
              閉じる
            </button>
          </div>
          {mode === 'signup' && (
            <p className="auth-hint">いまの会話と記憶はそのままアカウントに引き継がれます。</p>
          )}
        </form>
      )}
    </div>
  );
}
