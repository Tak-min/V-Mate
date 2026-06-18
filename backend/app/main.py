"""Aikata バックエンド — 3D AI コンパニオン「シロ」のAPIサーバ。

マルチユーザー対応(Phase A): すべての記憶は user_id でスコープされる。
Phase A では user_id は匿名Cookie(`aikata_uid`)で識別する。
Phase C でアカウント(ログイン)に昇格させる予定。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import date, datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from . import auth, llm, memory, persona, tts  # noqa: E402

def _cors_origins() -> list[str]:
    base = ["http://localhost:5173", "http://127.0.0.1:5173"]
    extra = os.environ.get("CORS_ORIGINS", "")
    base += [o.strip() for o in extra.split(",") if o.strip()]
    return base


app = FastAPI(title="Aikata")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
memory.init_db()

# --- レート制限 / TTS ゲート(Phase D: 公開時のコスト・不正利用対策)---
# 公開では既定で TTS オフ(ElevenLabs 無料枠が極小なため)。ローカルは .env で ENABLE_TTS=true。
ENABLE_TTS = os.environ.get("ENABLE_TTS", "false").lower() in ("1", "true", "yes", "on")
RATE_PER_USER_PER_DAY = int(os.environ.get("RATE_PER_USER_PER_DAY", "50"))
RATE_GLOBAL_PER_DAY = int(os.environ.get("RATE_GLOBAL_PER_DAY", "800"))  # Groq無料1000/日を保護
RATE_LOGIN_PER_IP_PER_DAY = int(os.environ.get("RATE_LOGIN_PER_IP_PER_DAY", "30"))
# シロは「1〜3文」の短い相づち的な会話が persona.py の指示だが、LLMが指示を無視して
# 長文を返すことがあり、チャット欄が一方的なAI長文で埋まって人間らしさが失われる原因になっていた。
# max_tokens で物理的に上限を切る(日本語1〜3文+感情タグなら十分収まる長さ)。
CHAT_MAX_TOKENS = int(os.environ.get("CHAT_MAX_TOKENS", "260"))
# AIが干渉しすぎる(リロードのたびに挨拶し直す等)との指摘を受けて追加。
# 直前の活動(last_seen)からこの秒数未満なら「戻ってきた」とみなさず挨拶を省略する。
GREETING_MIN_GAP_SECONDS = int(os.environ.get("GREETING_MIN_GAP_SECONDS", "180"))
RESEARCH_ALLOW_CONDITION_OVERRIDE = os.environ.get(
    "RESEARCH_ALLOW_CONDITION_OVERRIDE", "true"
).lower() in ("1", "true", "yes", "on")
RESEARCH_EXPORT_TOKEN = os.environ.get("RESEARCH_EXPORT_TOKEN", "").strip()


def _enforce_rate_limit(uid: str) -> None:
    """チャットの 1ユーザー/日 と 全体/日 の上限を課す。超過で 429。"""
    day = date.today().isoformat()
    if memory.bump_usage(f"user:{uid}", day) > RATE_PER_USER_PER_DAY:
        raise HTTPException(
            status_code=429,
            detail="今日はたくさん話したね。また明日ゆっくり話そう。",
        )
    if memory.bump_usage("global", day) > RATE_GLOBAL_PER_DAY:
        raise HTTPException(
            status_code=429,
            detail="今いろんな人がシロと話していて混み合ってるみたい。少し時間をおいてね。",
        )

COOKIE_NAME = "aikata_uid"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2  # 2年
EMOTION_TAG_RE = re.compile(r"\[(neutral|happy|sad|angry|relaxed|shy)\]")
RESEARCH_CONDITIONS = ("text", "stylized", "realistic")
RESEARCH_METRICS_VERSION = "2026-06-18-v1"
SENSITIVE_SELF_DISCLOSURE_RE = re.compile(
    r"悩|不安|怖|こわ|つら|辛|疲|しんど|泣|孤独|寂|さび|死|消えたい|"
    r"自傷|自殺|病|家族|友達|恋|好き|嫌い|秘密|恥|失敗|将来|進路|受験|"
    r"anxious|lonely|depress|suicide|self-harm|secret|family|friend|love",
    re.IGNORECASE,
)
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
    condition: str | None = Field(default=None, max_length=24)


class ProfileRequest(BaseModel):
    user_name: str = Field(min_length=1, max_length=40)


class NudgeRequest(BaseModel):
    reason: str = Field(default="idle", pattern="^(idle|greeting)$")


class AuthRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=200)


class ResearchSessionRequest(BaseModel):
    condition: str | None = Field(default=None, max_length=24)
    source: str = Field(default="app", max_length=64)


class ResearchEventRequest(BaseModel):
    condition: str = Field(max_length=24)
    event_type: str = Field(min_length=1, max_length=64)
    payload: dict = Field(default_factory=dict)


def _resolve_uid(request: Request) -> str:
    """有効な JWT があればそのアカウントID、無ければ匿名Cookie ID を返す。"""
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        sub = auth.decode_token(header[len("Bearer "):])
        if sub:
            return sub
    return request.state.uid


def _strip_emotion(text: str) -> tuple[str, str]:
    """先頭の感情タグを抽出し、本文からすべてのタグを除去する。"""
    match = EMOTION_TAG_RE.search(text)
    emotion = match.group(1) if match else "neutral"
    return emotion, _sanitize_fourth_wall(EMOTION_TAG_RE.sub("", text).strip())


# persona.py で「ユーザーと呼ばない」と指示しても LLM が稀に漏らすため、
# 表に出る本文からは機械的にも除去する(プロンプト遵守に頼らない最終防衛線)。
_FOURTH_WALL_RE = re.compile(r"ユーザー(さん)?[はがのをにへとで、。]?")


def _sanitize_fourth_wall(text: str) -> str:
    return _FOURTH_WALL_RE.sub("", text)


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


def _default_research_condition(user_id: str) -> str:
    digest = hashlib.sha256(user_id.encode("utf-8")).digest()
    return RESEARCH_CONDITIONS[digest[0] % len(RESEARCH_CONDITIONS)]


def _research_condition(user_id: str, requested: str | None = None) -> str:
    if requested in RESEARCH_CONDITIONS and RESEARCH_ALLOW_CONDITION_OVERRIDE:
        memory.set_kv(user_id, "research_condition", requested)
        return requested
    stored = memory.get_kv(user_id, "research_condition")
    if stored in RESEARCH_CONDITIONS:
        return stored
    condition = _default_research_condition(user_id)
    memory.set_kv(user_id, "research_condition", condition)
    return condition


def _log_research_event(
    user_id: str,
    condition: str,
    event_type: str,
    payload: dict | None = None,
) -> None:
    if condition not in RESEARCH_CONDITIONS:
        condition = _research_condition(user_id)
    body = payload or {}
    body.setdefault("metrics_version", RESEARCH_METRICS_VERSION)
    memory.add_research_event(
        user_id,
        condition,
        event_type,
        json.dumps(body, ensure_ascii=False, separators=(",", ":")),
    )


def _message_metrics(text: str) -> dict:
    stripped = text.strip()
    return {
        "char_count": len(stripped),
        "line_count": stripped.count("\n") + (1 if stripped else 0),
        "question_count": stripped.count("?") + stripped.count("？"),
        "contains_sensitive_self_disclosure": bool(SENSITIVE_SELF_DISCLOSURE_RE.search(stripped)),
    }


@app.post("/api/auth/signup")
async def auth_signup(req: AuthRequest, request: Request) -> dict:
    try:
        token = auth.signup(req.email, req.password, anon_uid=request.state.uid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"token": token}


@app.post("/api/auth/login")
async def auth_login(req: AuthRequest, request: Request) -> dict:
    ip = request.client.host if request.client else "unknown"
    if memory.bump_usage(f"login:{ip}", date.today().isoformat()) > RATE_LOGIN_PER_IP_PER_DAY:
        raise HTTPException(status_code=429, detail="ログイン試行が多すぎます。時間をおいて再度お試しください。")
    try:
        token = auth.login(req.email, req.password)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    return {"token": token}


@app.get("/api/auth/me")
async def auth_me(request: Request) -> dict:
    uid = _resolve_uid(request)
    user = memory.get_user_by_id(uid)
    return {"authenticated": user is not None, "email": user["email"] if user else None}


@app.get("/api/state")
async def get_state(request: Request) -> dict:
    return _state_payload(_resolve_uid(request))


@app.post("/api/research/session")
async def research_session(req: ResearchSessionRequest, request: Request) -> dict:
    uid = _resolve_uid(request)
    condition = _research_condition(uid, req.condition)
    _log_research_event(
        uid,
        condition,
        "session_start",
        {
            "source": req.source,
            "override_requested": req.condition if req.condition in RESEARCH_CONDITIONS else None,
            "override_allowed": RESEARCH_ALLOW_CONDITION_OVERRIDE,
        },
    )
    return {
        "condition": condition,
        "conditions": list(RESEARCH_CONDITIONS),
        "metrics_version": RESEARCH_METRICS_VERSION,
    }


@app.post("/api/research/event")
async def research_event(req: ResearchEventRequest, request: Request) -> dict:
    uid = _resolve_uid(request)
    condition = _research_condition(uid, req.condition)
    _log_research_event(uid, condition, req.event_type, req.payload)
    return {"ok": True}


@app.get("/api/research/export")
async def research_export(request: Request, limit: int = 500) -> list[dict]:
    token = request.headers.get("X-Research-Export-Token", "")
    if not RESEARCH_EXPORT_TOKEN or token != RESEARCH_EXPORT_TOKEN:
        raise HTTPException(status_code=403, detail="research export disabled")
    uid = _resolve_uid(request)
    return memory.list_research_events(uid, min(max(limit, 1), 5000))


@app.post("/api/profile")
async def set_profile(req: ProfileRequest, request: Request) -> dict:
    uid = _resolve_uid(request)
    name = req.user_name.strip()
    memory.set_kv(uid, "user_name", name)
    memory.add_fact(uid, f"名前(呼び方)は「{name}」")
    return _state_payload(uid)


@app.get("/api/history")
async def get_history(request: Request, limit: int = 30) -> list[dict]:
    return memory.recent_messages(_resolve_uid(request), min(limit, 100))


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
    uid = _resolve_uid(request)
    condition = _research_condition(uid, req.condition)
    _enforce_rate_limit(uid)
    # 親密度: 1発言 +1、その日最初の会話はボーナス
    today_first = not any(
        m["role"] == "user" for m in memory.messages_on(uid, date.today())
    )
    memory.add_message(uid, "user", req.message)
    _log_research_event(
        uid,
        condition,
        "chat_sent",
        {
            "message": _message_metrics(req.message),
            "today_first": today_first,
        },
    )
    affinity = memory.add_affinity(
        uid, 1 + (DAILY_FIRST_CHAT_BONUS if today_first else 0)
    )
    memory.touch_last_seen(uid)

    recent_diary = memory.list_diary(uid, 1)
    raw_history = memory.recent_messages(uid, HISTORY_WINDOW)
    recent_emotions = [
        m["emotion"] for m in raw_history if m["role"] == "assistant" and m.get("emotion")
    ][-3:]
    system = persona.build_system_prompt(
        user_name=memory.get_kv(uid, "user_name"),
        affinity=affinity,
        facts=memory.list_facts(uid),
        time_context=_time_context(),
        summary=memory.get_summary(uid),
        recent_diary=recent_diary[0]["content"] if recent_diary else "",
        recent_emotions=recent_emotions,
    )
    history = [{"role": m["role"], "content": m["content"]} for m in raw_history]

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
            async for chunk in llm.stream_chat(system, history, max_tokens=CHAT_MAX_TOKENS):
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
                    clean = _sanitize_fourth_wall(EMOTION_TAG_RE.sub("", buffer))
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
            _log_research_event(
                uid,
                condition,
                "assistant_done",
                {
                    "emotion": emotion or "neutral",
                    "response": _message_metrics(full_text),
                },
            )
        state = _state_payload(uid)
        yield sse({"type": "done", **state})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/nudge")
async def nudge(req: NudgeRequest, request: Request) -> dict:
    uid = _resolve_uid(request)
    last_seen = memory.get_kv(uid, "last_seen")
    user_name = memory.get_kv(uid, "user_name")
    name_note = (
        f"相手の名前は「{user_name}」。"
        if user_name
        else "相手の名前はまだ知らない(「ユーザーさん」のような呼び方はせず、名前を呼ばずに話す)。"
    )
    if req.reason == "greeting":
        if last_seen:
            elapsed = datetime.now() - datetime.fromisoformat(last_seen)
            if elapsed.total_seconds() < GREETING_MIN_GAP_SECONDS:
                # ついさっき(リロード等)開いただけ。毎回挨拶し直すと干渉しすぎになるので省略する。
                memory.touch_last_seen(uid)
                return {"text": "", "emotion": "neutral"}
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
    if req.reason == "greeting":
        recent_diary = memory.list_diary(uid, 1)
        if recent_diary:
            context += f" 前回の自分の日記: {recent_diary[0]['content']}"
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
    uid = _resolve_uid(request)
    today = date.today()
    can_generate = (
        not memory.has_diary(uid, today) and len(memory.messages_on(uid, today)) >= 4
    )
    return {"entries": memory.list_diary(uid), "can_generate_today": can_generate}


@app.post("/api/diary/generate")
async def generate_diary(request: Request) -> dict:
    uid = _resolve_uid(request)
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
async def get_tts(text: str, emotion: str | None = None) -> Response:
    if not ENABLE_TTS:  # 公開では既定オフ(無料枠保護)。無音=テキストのみ
        return Response(status_code=204)
    audio = await tts.synthesize(text[:300], emotion)
    if audio is None:
        return Response(status_code=204)
    return Response(content=audio, media_type="audio/mpeg")


# 本番ビルド時はフロントエンドの成果物を同居配信する
_static = Path(__file__).resolve().parent.parent / "static"
if _static.is_dir():
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
