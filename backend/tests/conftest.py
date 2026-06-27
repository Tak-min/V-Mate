import os

import pytest

# auth.py の _get_jwt_secret() は「32バイト未満で RuntimeError」化した(C1)。
# テスト実行前に固定値を注入しないと、test_auth.py が create_token/decode_token 呼び出しで
# 即座に落下する。pytest は conftest を collection の一番最初に読むため、ここで setenv すれば
# 以後に `from app import auth` しても使用時に安全な値が取れる。
os.environ.setdefault(
    "JWT_SECRET",
    "test-jwt-secret-fixed-32bytes-or-more-for-unit-tests-only-not-for-prod",
)

from app import memory


@pytest.fixture
def db(tmp_path, monkeypatch):
    """各テストを使い捨ての一時 SQLite に隔離する。"""
    monkeypatch.setattr(memory, "DB_PATH", tmp_path / "test.db")
    memory.init_db()
    return memory.DB_PATH