import { useMemo, useState } from 'react';
import type { ResearchSurveyScores } from '../features/chat/types';

const ITEMS: { key: keyof ResearchSurveyScores; label: string; low: string; high: string }[] = [
  { key: 'social_presence', label: '相手がそこにいる感じ', low: '弱い', high: '強い' },
  { key: 'trust', label: '安心して任せられる感じ', low: '低い', high: '高い' },
  { key: 'self_disclosure_comfort', label: '自分のことを話しやすい感じ', low: '話しにくい', high: '話しやすい' },
  { key: 'continued_use_intention', label: 'また使いたい感じ', low: '弱い', high: '強い' },
  { key: 'usability', label: '使いやすさ', low: '使いにくい', high: '使いやすい' },
  { key: 'eeriness', label: '不気味さ', low: 'ない', high: '強い' },
];

const DEFAULT_SCORES: ResearchSurveyScores = {
  social_presence: 4,
  trust: 4,
  self_disclosure_comfort: 4,
  continued_use_intention: 4,
  usability: 4,
  eeriness: 4,
};

interface Props {
  visible: boolean;
  onSubmit: (scores: ResearchSurveyScores) => Promise<void>;
}

export function ResearchSurvey({ visible, onSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const [scores, setScores] = useState<ResearchSurveyScores>(DEFAULT_SCORES);
  const [submitted, setSubmitted] = useState(false);
  const canShow = visible && !submitted;
  const summary = useMemo(
    () => ITEMS.map((item) => `${item.label}:${scores[item.key]}`).join(' / '),
    [scores],
  );

  if (!canShow) return null;

  const submit = async () => {
    await onSubmit(scores);
    setSubmitted(true);
    setOpen(false);
  };

  return (
    <aside className={`research-survey${open ? ' open' : ''}`} aria-label="セッション評価">
      {!open ? (
        <button type="button" className="research-survey-tab" onClick={() => setOpen(true)}>
          セッション評価
        </button>
      ) : (
        <div className="research-survey-card">
          <div className="research-survey-head">
            <strong>セッション評価</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="閉じる">
              ×
            </button>
          </div>
          <div className="research-survey-items">
            {ITEMS.map((item) => (
              <label key={item.key} className="research-survey-item">
                <span className="research-survey-label">{item.label}</span>
                <input
                  type="range"
                  min="1"
                  max="7"
                  value={scores[item.key]}
                  onChange={(event) =>
                    setScores((prev) => ({
                      ...prev,
                      [item.key]: Number(event.target.value),
                    }))
                  }
                  aria-label={item.label}
                />
                <span className="research-survey-scale">
                  <span>{item.low}</span>
                  <b>{scores[item.key]}</b>
                  <span>{item.high}</span>
                </span>
              </label>
            ))}
          </div>
          <button type="button" className="research-survey-submit" onClick={submit} title={summary}>
            記録
          </button>
        </div>
      )}
    </aside>
  );
}
