"""認証(signup/login/JWT)と、HTTPレイヤ(Cookie匿名→アカウント昇格・分離)のテスト。"""

import pytest
from fastapi.testclient import TestClient

from app import auth, memory


# --- auth ユニット ---

def test_signup_then_login_same_user(db):
    t1 = auth.signup("a@example.com", "secret123")
    uid = auth.decode_token(t1)
    assert uid
    t2 = auth.login("a@example.com", "secret123")
    assert auth.decode_token(t2) == uid


def test_duplicate_email_case_insensitive(db):
    auth.signup("a@example.com", "secret123")
    with pytest.raises(ValueError):
        auth.signup("A@Example.com", "other123")


def test_wrong_password_rejected(db):
    auth.signup("a@example.com", "secret123")
    with pytest.raises(ValueError):
        auth.login("a@example.com", "WRONG")


def test_invalid_email_rejected(db):
    with pytest.raises(ValueError):
        auth.signup("notanemail", "secret123")


def test_garbage_token_returns_none(db):
    assert auth.decode_token("garbage.token.xyz") is None


def test_anon_data_migrated_on_signup(db):
    memory.add_message("anon1", "user", "こんにちは")
    memory.add_affinity("anon1", 5)
    token = auth.signup("a@example.com", "secret123", anon_uid="anon1")
    uid = auth.decode_token(token)
    assert len(memory.recent_messages(uid, 100)) == 1  # 引き継がれた
    assert memory.get_affinity(uid) == 5
    assert memory.recent_messages("anon1", 100) == []  # 元は空に


# --- HTTP 統合(Cookie匿名 / JWT) ---

def _client() -> TestClient:
    from app.main import app
    return TestClient(app)


def test_anonymous_gets_cookie_and_isolated_state(db):
    c1 = _client()
    c2 = _client()
    c1.post("/api/profile", json={"user_name": "あいうえ"})
    # c1 は名前あり、c2(別Cookie)は未設定で分離している
    assert c1.get("/api/state").json()["user_name"] == "あいうえ"
    assert c2.get("/api/state").json()["user_name"] is None


def test_signup_login_me_flow(db):
    c = _client()
    r = c.post("/api/auth/signup", json={"email": "u@example.com", "password": "secret123"})
    assert r.status_code == 200
    token = r.json()["token"]
    me = c.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["authenticated"] is True
    assert me["email"] == "u@example.com"
    # 間違いログインは 401
    assert c.post("/api/auth/login", json={"email": "u@example.com", "password": "wrongpass"}).status_code == 401
