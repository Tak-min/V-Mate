import pytest

from app import memory


@pytest.fixture
def db(tmp_path, monkeypatch):
    """各テストを使い捨ての一時 SQLite に隔離する。"""
    monkeypatch.setattr(memory, "DB_PATH", tmp_path / "test.db")
    memory.init_db()
    return memory.DB_PATH
