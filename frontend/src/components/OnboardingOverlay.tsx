import { useCallback, useEffect, useState } from 'react';
import { setAge, trackEvent, type AgeBand } from '../features/chat/api';
import {
  advanceOnboardingStep,
  completeOnboarding,
  isOnboardingComplete,
} from '../features/chat/onboarding';

/** UI 上のステップ番号(0=Welcome, 1=Age, 2=Name, 3=Hint) */
type UiStep = 0 | 1 | 2 | 3;

interface OnboardingOverlayProps {
  ageBand: AgeBand | null;
  onAgeVerified: (band: AgeBand) => void;
  onComplete: (name?: string) => void;
}

export function OnboardingOverlay({ ageBand, onAgeVerified, onComplete }: OnboardingOverlayProps) {
  const resumeAtAge = isOnboardingComplete() && ageBand === null;
  const [step, setStep] = useState<UiStep>(resumeAtAge ? 1 : 0);
  const [name, setName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [ageBusy, setAgeBusy] = useState(false);
  const [ageError, setAgeError] = useState('');
  const [blocked, setBlocked] = useState(ageBand === 'under13');

  // 個人情報を送らず、開始回数だけを日次集計する。
  useEffect(() => {
    if (!resumeAtAge) trackEvent('onboarding_started');
  }, [resumeAtAge]);

  const handleNextFromWelcome = useCallback(() => {
    if (ageBand === null) {
      advanceOnboardingStep(2);
      setStep(1);
    } else {
      advanceOnboardingStep(3);
      setStep(2);
    }
  }, [ageBand]);

  const handleAge = useCallback(async () => {
    if (!birthDate || ageBusy) return;
    setAgeBusy(true);
    setAgeError('');
    try {
      const result = await setAge(birthDate);
      if (!result.age_band) throw new Error('年齢確認の応答が不正です');
      onAgeVerified(result.age_band);
      trackEvent('onboarding_age_verified');
      if (result.age_band === 'under13') {
        setBlocked(true);
        return;
      }
      if (resumeAtAge) {
        completeOnboarding();
        onComplete();
      } else {
        advanceOnboardingStep(3);
        setStep(2);
      }
    } catch (error) {
      setAgeError(error instanceof Error ? error.message : '確認できませんでした。もう一度試してください。');
    } finally {
      setAgeBusy(false);
    }
  }, [ageBusy, birthDate, onAgeVerified, onComplete, resumeAtAge]);

  const handleNextFromName = useCallback(() => {
    advanceOnboardingStep(3);
    setStep(3);
  }, []);

  const handleComplete = useCallback(() => {
    completeOnboarding();
    trackEvent('onboarding_completed');
    onComplete(name || undefined);
  }, [name, onComplete]);

  if (blocked) {
    return (
      <div className="onboarding-backdrop">
        <div className="onboarding-card" role="alert">
          <p className="onboarding-title">ごめんね</p>
          <p className="onboarding-subtitle">
            このアプリは13歳未満の方はご利用いただけません。<br />
            大きくなったら、また会えるのを楽しみにしてるね。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-backdrop">
      <div className="onboarding-card" role="dialog" aria-modal="true" aria-label="オンボーディング">
        <div className="onboarding-dots" aria-hidden="true">
          {[0, 1, 2, 3].map((value) => (
            <span key={value} className={`onboarding-dot${step === value ? ' active' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <>
            <p className="onboarding-title">はじめまして！</p>
            <p className="onboarding-subtitle">ぼくはシロ。話すほどあなたのことを覚えて、毎日をいっしょに振り返る相棒だよ。</p>
            <div className="onboarding-actions">
              <button type="button" className="onboarding-primary" onClick={handleNextFromWelcome}>つぎへ</button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p className="onboarding-title">うまれた日をおしえてね</p>
            <p className="onboarding-subtitle">安心して使ってもらうための確認だよ。</p>
            <input
              className="onboarding-input"
              type="date"
              value={birthDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(event) => setBirthDate(event.target.value)}
              required
              autoFocus
            />
            {ageError && <p className="onboarding-error" role="alert">{ageError}</p>}
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-primary"
                onClick={() => void handleAge()}
                disabled={!birthDate || ageBusy}
              >
                {ageBusy ? '確認中…' : '確認する'}
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="onboarding-title">おなまえは？</p>
            <input
              className="onboarding-input"
              type="text"
              placeholder="なまえをいれてね"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <div className="onboarding-actions">
              <button type="button" className="onboarding-primary" onClick={handleNextFromName}>つぎへ</button>
            </div>
            <button type="button" className="onboarding-skip" onClick={handleNextFromName}>スキップ</button>
          </>
        )}

        {step === 3 && (
          <>
            <p className="onboarding-title">話しかけてみて！</p>
            <div className="onboarding-hints">
              <div className="onboarding-hint-item">💬 テキストで話しかける</div>
              <div className="onboarding-hint-item">🎤 マイクで話しかける</div>
              <div className="onboarding-hint-item">🧠 好きなことを覚えてくれる</div>
              <div className="onboarding-hint-item">📓 今日のことが日記になる</div>
            </div>
            <div className="onboarding-actions">
              <button type="button" className="onboarding-primary" onClick={handleComplete}>最初のひとことを話す</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
