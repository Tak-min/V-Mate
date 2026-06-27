"""CORS 設計の回帰テスト(H9)。

旧実装は allow_methods=["*"] / allow_headers=["*"] で、credentials 付き API に対して
過剰許可だった。本APIは GET/POST と Authorization/Content-Type しか使わないので
明示的に限定する。将来 PUT/DELETE を足すときはここも更新すること。
"""

from fastapi.testclient import TestClient

from app.main import app, memory


def _client() -> TestClient:
    return TestClient(app)


def test_cors_preflight_returns_explicit_methods(db):
    c = _client()
    r = c.options(
        "/api/state",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code == 200
    allow = r.headers.get("access-control-allow-methods", "")
    # 明示的に限定している。PUT/DELETE/PATCH は含まれない。
    assert "GET" in allow and "POST" in allow
    assert "PUT" not in allow
    assert "DELETE" not in allow


def test_cors_preflight_returns_restricted_headers(db):
    c = _client()
    r = c.options(
        "/api/auth/login",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
        },
    )
    assert r.status_code == 200
    allow = r.headers.get("access-control-allow-headers", "")
    assert "Authorization" in allow
    assert "Content-Type" in allow


def test_cors_credentials_true_for_known_origin(db):
    c = _client()
    r = c.options(
        "/api/state",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.headers.get("access-control-allow-credentials") == "true"
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"