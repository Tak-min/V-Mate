"""Aikata バックエンド — 3D AI コンパニオン「シロ」のAPIサーバ。

マルチユーザー対応(Phase A): すべての記憶は user_id でスコープされる。
Phase A では user_id は匿名Cookie(`aikata_uid`)で識別する。
Phase C でアカウント(ログイン)に昇格させる予定。
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import BackgroundTasks, FastAPI, Request, Response  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from . import llm, memory, persona, tts  # noqa: E402

app = FastAPI(title="Aikata")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
memory.init_db()

COOKIE_NAME = "aikata_uid"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2  # 2年
EMOTION_TAG_RE = re.compile(r"\[(neutral|happy|sad|angry|relaxed|shy)\]")
FACT_EXTRACTION_INTERVAL = 6  # ユーザー発言N回ごとに事実抽出
DAILY_FIRST_CHAT_BONUS = 5
HISTORY_WINDOW = 24  # 逐語でLLMに渡す直近メッセージ数
SUMMARY_CHUNK = 16  # 窓から溢れた未要約メッセージがN件たまったら要約に畳み込む
SUMMARY_MAX_CHARS = 1200  # 要約が無限に伸びないための安全上限


@app.middleware("http")
async def ensure_user_cookie(request: Request, call_next):
    """訪問者ごとに匿名 user_id を Cookie で発行・維持する(各ブラウザ=別シロ)。"""
    uid = request.cookies.get(COOKIE_NAME)
    is_new = not uid
    if is_new:
        uid = uuid.uuid4().hex
    request.state.uid = uid
    response = await call_next(request)
    if is_new:
        response.set_cookie(
            COOKIE_NAME,
            uid,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
        )
    return response


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class ProfileRequest(BaseModel):
    user_name: str = Field(min_length=1, max_length=40)


class NudgeRequest(BaseModel):
    reason: str = Field(default="idle", pattern="^(idle|greeting)$")


def _strip_emotion(text: str) -> tuple[str, str]:
    """先頭の感情タグを抽出し、本文からすべてのタグを除去する。"""
    match = EMOTION_TAG_RE.search(text)
    emotion = match.group(1) if match else "neutral"
    return emotion, EMOTION_TAG_RE.sub("", text).strip()


def _time_context() -> str:
    now = datetime.now()
    hour = now.hour
    if hour < 5:
        period = "深夜"
    elif hour < 11:
        period = "朝"
    elif hour < 17:
        period = "昼"
    elif hour < 22:
        period = "夜"
    else:
        period = "夜遅く"
    return f"現在は{now.strftime('%m月%d日 %H:%M')}({period})。"


def _state_payload(user_id: str) -> dict:
    score = memory.get_affinity(user_id)
    stage_name, _ = persona.stage_for(score)
    return {
        "user_name": memory.get_kv(user_id, "user_name"),
        "affinity": score,
        "stage": stage_name,
        "next_stage_at": persona.next_stage_threshold(score),
        "provider": llm.provider(),
    }


@app.get("/api/state")
async def get_state(request: Request) -> dict:
    return _state_payload(request.state.uid)


@app.post("/api/profile")
async def set_profile(req: ProfileRequest, request: Request) -> dict:
    uid = request.state.uid
    name = req.user_name.strip()
    memory.set_kv(uid, "user_name", name)
    memory.add_fact(uid, f"名前(呼び方)は「{name}」")
    return _state_payload(uid)


@app.get("/api/history")
async def get_history(request: Request, limit: int = 30) -> list[dict]:
    return memory.recent_messages(request.state.uid, min(limit, 100))


async def _extract_facts(user_id: str) -> None:
    conversation = "\n".join(
        f"{'ユーザー' if m['role'] == 'user' else 'シロ'}: {m['content']}"
        for m in memory.recent_messages(user_id, FACT_EXTRACTION_INTERVAL * 2)
    )
    try:
        result = await llm.complete(
            persona.FACT_EXTRACTION_PROMPT.format(conversation=conversation)
        )
    except Exception:
        return
    for line in result.splitlines():
        line = line.strip().lstrip("-・*0123456789. ").strip()
        if line and line != "なし" and len(line) < 120:
            memory.add_fact(user_id, line)


async def _summarize_old_history(user_id: str) -> None:
    """逐語の窓(HISTORY_WINDOW)から溢れた古い会話を、たまったら要約へ畳み込む。
    閾値未満なら軽量クエリだけで即return し、LLM は呼ばない。"""
    through = memory.get_summary_through_id(user_id)
    pending = memory.messages_to_summarize(user_id, through, HISTORY_WINDOW)
    if len(pending) < SUMMARY_CHUNK:
        return
    conversation = "\n".join(
        f"{'ユーザー' if m['role'] == 'user' else 'シロ'}: {m['content']}"
        for m in pending
    )
    try:
        raw = await llm.complete(
            persona.SUMMARY_PROMPT.format(
                summary=memory.get_summary(user_id) or "(まだ要約はない)",
                conversation=conversation,
            )
        )
    except Exception:
        return  # 失敗時は through_id を進めないので次回再試行される
    _, new_summary = _strip_emotion(raw)
    new_summary = new_summary.strip()
    if new_summary:
        memory.set_summary(user_id, new_summary[:SUMMARY_MAX_CHARS], pending[-1]["id"])


@app.post("/api/chat")
async def chat(
    req: ChatRequest, request: Request, background: BackgroundTasks
) -> StreamingResponse:
    uid = request.state.uid
    # 親密度: 1発言 +1、その日最初の会話はボーナス
    today_first = not any(
        m["role"] == "user" for m in memory.messages_on(uid, date.today())
    )
    memory.add_message(uid, "user", req.message)
    affinity = memory.add_affinity(
        uid, 1 + (DAILY_FIRST_CHAT_BONUS if today_first else 0)
    )
    memory.touch_last_seen(uid)

    system = persona.build_system_prompt(
        user_name=memory.get_kv(uid, "user_name"),
        affinity=affinity,
        facts=memory.list_facts(uid),
        time_context=_time_context(),
        summary=memory.get_summary(uid),
    )
    history = [
        {"role": m["role"], "content": m["content"]}
        for m in memory.recent_messages(uid, HISTORY_WINDOW)
    ]

    if memory.user_message_count(uid) % FACT_EXTRACTION_INTERVAL == 0:
        background.add_task(_extract_facts, uid)
    background.add_task(_summarize_old_history, uid)

    async def event_stream():
        def sse(payload: dict) -> str:
            return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        buffer = ""
        emotion: str | None = None
        full_text = ""
        try:
            async for chunk in llm.stream_chat(system, history):
                buffer += chunk
                if emotion is None:
                    # 感情タグが確定するまでバッファし、確定後にまとめて流す
                    match = EMOTION_TAG_RE.search(buffer)
                    if match:
                        emotion = match.group(1)
                        yield sse({"type": "emotion", "emotion": emotion})
                        buffer = EMOTION_TAG_RE.sub("", buffer).lstrip()
                    elif len(buffer) > 24:
                        emotion = "neutral"
                        yield sse({"type": "emotion", "emotion": emotion})
                    else:
                        continue
                if buffer:
                    clean = EMOTION_TAG_RE.sub("", buffer)
                    full_text += clean
                    yield sse({"type": "token", "text": clean})
                    buffer = ""
            if emotion is None:
                emotion, rest = _strip_emotion(buffer)
                yield sse({"type": "emotion", "emotion": emotion})
                if rest:
                    full_text += rest
                    yield sse({"type": "token", "text": rest})
        except Exception as exc:  # クラウドLLM接続失敗・APIキー未設定など
            yield sse({
                "type": "error",
                "message": f"応答の生成に失敗しました ({type(exc).__name__})。"
                "LLM_API_KEY の設定とネットワーク接続を確認してください。",
            })
            return
        full_text = full_text.strip()
        if full_text:
            memory.add_message(uid, "assistant", full_text, emotion)
        state = _state_payload(uid)
        yield sse({"type": "done", **state})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/nudge")
async def nudge(req: NudgeRequest, request: Request) -> dict:
    uid = request.state.uid
    last_seen = memory.get_kv(uid, "last_seen")
    user_name = memory.get_kv(uid, "user_name")
    name_note = (
        f"相手の名前は「{user_name}」。"
        if user_name
        else "相手の名前はまだ知らない(「ユーザーさん」のような呼び方はせず、名前を呼ばずに話す)。"
    )
    if req.reason == "greeting":
        gap = ""
        if last_seen:
            days = (datetime.now() - datetime.fromisoformat(last_seen)).days
            if days >= 2:
                gap = f"ユーザーと会うのは約{days}日ぶり。"
        context = f"{_time_context()}{name_note}{gap}ユーザーがアプリを開いて現れたところ。挨拶する。"
    else:
        context = f"{_time_context()}{name_note}会話が途切れて少し時間が経った。"
    facts = memory.list_facts(uid, 8)
    if facts:
        context += "覚えていること: " + " / ".join(facts)
    prompt = persona.NUDGE_PROMPT.format(
        context=context, emotions="|".join(persona.EMOTIONS)
    )
    try:
        raw = await llm.complete(prompt)
    except Exception:
        return {"text": "", "emotion": "neutral"}
    emotion, text = _strip_emotion(raw)
    if text:
        memory.add_message(uid, "assistant", text, emotion)
    memory.touch_last_seen(uid)
    return {"text": text, "emotion": emotion}


@app.get("/api/diary")
async def get_diary(request: Request) -> dict:
    uid = request.state.uid
    today = date.today()
    can_generate = (
        not memory.has_diary(uid, today) and len(memory.messages_on(uid, today)) >= 4
    )
    return {"entries": memory.list_diary(uid), "can_generate_today": can_generate}


@app.post("/api/diary/generate")
async def generate_diary(request: Request) -> dict:
    uid = request.state.uid
    today = date.today()
    msgs = memory.messages_on(uid, today)
    if len(msgs) < 4:
        return {"ok": False, "reason": "今日はまだ会話が少ないみたい。"}
    conversation = "\n".join(
        f"{'ユーザー' if m['role'] == 'user' else 'シロ'}: {m['content']}"
        for m in msgs[-60:]
    )
    content = await llm.complete(
        persona.DIARY_PROMPT.format(
            user_name=memory.get_kv(uid, "user_name") or "ユーザー",
            conversation=conversation,
        )
    )
    _, content = _strip_emotion(content)
    memory.add_diary(uid, today, content)
    return {"ok": True, "entry": {"entry_date": today.isoformat(), "content": content}}


@app.get("/api/tts")
async def get_tts(text: str) -> Response:
    audio = await tts.synthesize(text[:300])
    if audio is None:
        return Response(status_code=204)
    return Response(content=audio, media_type="audio/mpeg")


# 本番ビルド時はフロントエンドの成果物を同居配信する
_static = Path(__file__).resolve().parent.parent / "static"
if _static.is_dir():
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
