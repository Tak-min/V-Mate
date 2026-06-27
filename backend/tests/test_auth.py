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
    # C4: JWT は httpOnly Cookie で返る。body に token は含まれない。
    assert "token" not in r.json()
    # TestClient は cookie jar を自動保持するので、/me を叩けば認証状態。
    me = c.get("/api/auth/me").json()
    assert me["authenticated"] is True
    assert me["email"] == "u@example.com"
    # 間違いログインは 401
    assert c.post("/api/auth/login", json={"email": "u@example.com", "password": "wrongpass"}).status_code == 401
    # logout で cookie を削除すると /me は未認証に戻る
    assert c.post("/api/auth/logout").status_code == 200
    # 別クライアント相当にするため cookie jar を捨てる
    c2 = _client()
    assert c2.get("/api/auth/me").json()["authenticated"] is False


def test_signup_token_not_exposed_in_body(db):
    """C4: signup 応答 body に JWT が含まれないことを検証(XSS 被害面を縮小)。"""
    c = _client()
    r = c.post("/api/auth/signup", json={"email": "x@example.com", "password": "secret123"})
    body = r.json()
    assert "token" not in body
    # Set-Cookie ヘッダーには入っている(HttpOnly なので JS からは読めない)
    set_cookie = r.headers.get("set-cookie", "")
    assert "aikata_token=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie
