import { FormEvent, useEffect, useState } from 'react';
import { clearToken, fetchMe, login, signup } from '../features/chat/api';

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

  const logout = () => {
    clearToken();
    window.location.reload();
  };

  if (email) {
    return (
      <div style={barStyle}>
        <span style={{ opacity: 0.8, fontSize: 12 }}>{email}</span>
        <button type="button" style={linkBtn} onClick={logout}>
          ログアウト
        </button>
      </div>
    );
  }

  return (
    <div style={barStyle}>
      {!open ? (
        <button type="button" style={pillBtn} onClick={() => setOpen(true)}>
          ログイン / 登録
        </button>
      ) : (
        <form onSubmit={submit} style={cardStyle}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              type="button"
              style={tab(mode === 'login')}
              onClick={() => setMode('login')}
            >
              ログイン
            </button>
            <button
              type="button"
              style={tab(mode === 'signup')}
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
            style={inputStyle}
            required
          />
          <input
            type="password"
            placeholder="パスワード(6文字以上)"
            value={form.password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={6}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            style={inputStyle}
            required
          />
          {error && <p style={{ color: '#ff8a8a', fontSize: 12, margin: '4px 0' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" style={pillBtn} disabled={busy}>
              {busy ? '…' : mode === 'login' ? 'ログイン' : '登録する'}
            </button>
            <button type="button" style={linkBtn} onClick={() => setOpen(false)}>
              閉じる
            </button>
          </div>
          {mode === 'signup' && (
            <p style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
              いまの会話と記憶はそのままアカウントに引き継がれます。
            </p>
          )}
        </form>
      )}
    </div>
  );
}

const barStyle: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  right: 12,
  zIndex: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: '#fff',
};

const pillBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.16)',
  border: '1px solid rgba(255,255,255,0.28)',
  color: '#fff',
  borderRadius: 999,
  padding: '6px 14px',
  fontSize: 13,
  cursor: 'pointer',
  backdropFilter: 'blur(8px)',
};

const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  opacity: 0.75,
  fontSize: 12,
  cursor: 'pointer',
  textDecoration: 'underline',
};

const cardStyle: React.CSSProperties = {
  background: 'rgba(20,18,28,0.82)',
  border: '1px solid rgba(255,255,255,0.16)',
  borderRadius: 14,
  padding: 14,
  width: 240,
  backdropFilter: 'blur(12px)',
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 8,
  color: '#fff',
  padding: '8px 10px',
  fontSize: 13,
  marginBottom: 8,
};

const tab = (active: boolean): React.CSSProperties => ({
  flex: 1,
  background: active ? 'rgba(255,255,255,0.2)' : 'transparent',
  border: '1px solid rgba(255,255,255,0.2)',
  color: '#fff',
  borderRadius: 8,
  padding: '5px 0',
  fontSize: 12,
  cursor: 'pointer',
});
