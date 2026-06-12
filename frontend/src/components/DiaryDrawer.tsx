import { useEffect, useState } from 'react';
import { fetchDiary, generateDiary } from '../features/chat/api';
import type { DiaryEntry } from '../features/chat/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DiaryDrawer({ open, onClose }: Props) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [canGenerate, setCanGenerate] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    fetchDiary()
      .then(({ entries, can_generate_today }) => {
        setEntries(entries);
        setCanGenerate(can_generate_today);
        setNotice('');
      })
      .catch(() => setNotice('日記を読み込めませんでした'));
  }, [open]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await generateDiary();
      if (result.ok && result.entry) {
        setEntries((prev) => [
          result.entry!,
          ...prev.filter((e) => e.entry_date !== result.entry!.entry_date),
        ]);
        setCanGenerate(false);
      } else {
        setNotice(result.reason ?? '今日はまだ書けないみたい');
      }
    } catch {
      setNotice('日記の生成に失敗しました');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <aside className={`diary-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
      <header className="diary-header">
        <h2>シロの日記</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </header>
      <p className="diary-caption">
        シロがあなたと過ごした日のことを書き留めています。
      </p>
      {canGenerate && (
        <button
          type="button"
          className="diary-generate"
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? '書いてる…' : '今日の日記を書いてもらう'}
        </button>
      )}
      {notice && <p className="diary-notice">{notice}</p>}
      <div className="diary-entries">
        {entries.length === 0 && !notice && (
          <p className="diary-notice">まだ日記はありません。たくさん話すと書いてくれます。</p>
        )}
        {entries.map((entry) => (
          <article key={entry.entry_date} className="diary-entry">
            <time>{entry.entry_date}</time>
            <p>{entry.content}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}
