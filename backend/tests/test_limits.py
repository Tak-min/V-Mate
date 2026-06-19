"""レート制限カウンタと、TTS ゲート / チャット上限の HTTP 挙動のテスト。"""

from fastapi.testclient import TestClient

from app import memory


def test_bump_usage_per_scope_and_day(db):
    assert memory.bump_usage("s", "2026-06-16") == 1
    assert memory.bump_usage("s", "2026-06-16") == 2
    assert memory.bump_usage("s", "2026-06-17") == 1  # 別日は別カウント
    assert memory.bump_usage("other", "2026-06-16") == 1  # 別scopeは別カウント


def test_tts_gated_off_by_default(db, monkeypatch):
    from app import main
    # 本番既定は ENABLE_TTS=false だが、ローカル .env は開発用に true にしているため
    # ゲート挙動そのものをテストするには明示的に false へ固定する必要がある
    # (固定しないと AIVIS_API_KEY が有効な環境で実際に音声合成APIを叩いてしまう)。
    monkeypatch.setattr(main, "ENABLE_TTS", False)
    c = TestClient(main.app)
    r = c.get("/api/tts", params={"text": "こんにちは"})
    assert r.status_code == 204  # 公開既定オフ=無音


def test_chat_rate_limit_returns_429(db, monkeypatch):
    from app import main
    # 上限0 → 最初の1回で 429。LLM(Groq)を一切叩かずに制限が先に効くことを確認。
    monkeypatch.setattr(main, "RATE_PER_USER_PER_DAY", 0)
    c = TestClient(main.app)
    r = c.post("/api/chat", json={"message": "やあ"})
    assert r.status_code == 429
