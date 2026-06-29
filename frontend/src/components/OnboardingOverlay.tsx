import { useCallback, useEffect, useState } from 'react';
import {
  advanceOnboardingStep,
  completeOnboarding,
  getOnboardingStep,
} from '../features/chat/onboarding';

/** UI 上のステップ番号(0=Welcome, 1=Name, 2=Hint) */
type UiStep = 0 | 1 | 2;

interface OnboardingOverlayProps {
  onComplete: (name?: string) => void;
}

export function OnboardingOverlay({ onComplete }: OnboardingOverlayProps) {
  // Restore step from localStorage on mount instead of always starting at 0.
  const [step, setStep] = useState<UiStep>(() => {
    const persisted = getOnboardingStep();
    return (persisted >= 1 && persisted <= 3 ? (persisted - 1) as UiStep : 0);
  });
  const [name, setName] = useState('');
  const [visible, setVisible] = useState(false);

  /* --- マウント時にオンボーディング段階を確認 --- */
  useEffect(() => {
    const current = getOnboardingStep();
    if (current >= 4) {
      setVisible(false);
      return;
    }
    // Only advance to step 1 if not already past it (prevents overwriting saved progress).
    if (current === 0) advanceOnboardingStep(1);
    setVisible(true);
  }, []);

  /* --- ハンドラ --- */
  const handleNextFromWelcome = useCallback(() => {
    advanceOnboardingStep(2);
    setStep(1);
  }, []);

  const handleNextFromName = useCallback(() => {
    advanceOnboardingStep(3);
    setStep(2);
  }, []);

  const handleSkip = useCallback(() => {
    completeOnboarding();
    onComplete();
  }, [onComplete]);

  const handleComplete = useCallback(() => {
    completeOnboarding();
    onComplete(name || undefined);
  }, [name, onComplete]);

  /* --- 既に完了済みなら描画しない --- */
  if (!visible) return null;

  return (
    <div className="onboarding-backdrop">
      <div
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-label="オンボーディング"
      >
        {/* ステップドット */}
        <div className="onboarding-dots" aria-hidden="true">
          <span className={`onboarding-dot${step === 0 ? ' active' : ''}`} />
          <span className={`onboarding-dot${step === 1 ? ' active' : ''}`} />
          <span className={`onboarding-dot${step === 2 ? ' active' : ''}`} />
        </div>

        {/* Step 0: Welcome */}
        {step === 0 && (
          <>
            <p className="onboarding-title">はじめまして！</p>
            <p className="onboarding-subtitle">ぼくはシロ、あなたのAIコンパニオンだよ。</p>
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-primary"
                onClick={handleNextFromWelcome}
              >
                つぎへ
              </button>
            </div>
          </>
        )}

        {/* Step 1: Name */}
        {step === 1 && (
          <>
            <p className="onboarding-title">おなまえは？</p>
            <input
              className="onboarding-input"
              type="text"
              placeholder="なまえをいれてね"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-primary"
                onClick={handleNextFromName}
              >
                つぎへ
              </button>
            </div>
            <button type="button" className="onboarding-skip" onClick={handleSkip}>
              スキップ
            </button>
          </>
        )}

        {/* Step 2: Hint */}
        {step === 2 && (
          <>
            <p className="onboarding-title">話しかけてみて！</p>
            <div className="onboarding-hints">
              <div className="onboarding-hint-item">
                💬 テキストで話しかける
              </div>
              <div className="onboarding-hint-item">
                🎤 マイクで話しかける
              </div>
            </div>
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-primary"
                onClick={handleComplete}
              >
                はじめる！
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
