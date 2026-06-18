"""研究条件割付とイベントログのテスト。"""

from fastapi.testclient import TestClient

from app import memory


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


def test_research_session_assigns_stable_condition(db):
    c = _client()
    first = c.post("/api/research/session", json={"source": "test"}).json()
    second = c.post("/api/research/session", json={"source": "test"}).json()
    assert first["condition"] in {"text", "stylized", "realistic"}
    assert second["condition"] == first["condition"]


def test_research_condition_override_and_event_log(db):
    c = _client()
    session = c.post(
        "/api/research/session",
        json={"condition": "text", "source": "test"},
    ).json()
    assert session["condition"] == "text"

    r = c.post(
        "/api/research/event",
        json={
            "condition": "text",
            "event_type": "survey_response",
            "payload": {"scores": {"social_presence": 4}},
        },
    )
    assert r.status_code == 200

    uid = c.cookies.get("aikata_uid")
    events = memory.list_research_events(uid, 20)
    assert [event["event_type"] for event in events] == [
        "session_start",
        "survey_response",
    ]
    assert all(event["condition"] == "text" for event in events)
    assert '"social_presence":4' in events[-1]["payload"]
