"""Aikata バックエンド — 3D AI コンパニオン「シロ」のAPIサーバ。

マルチユーザー対応(Phase A): すべての記憶は user_id でスコープされる。
Phase A では user_id は匿名Cookie(`aikata_uid`)で識別する。
Phase C でアカウント(ログイン)に昇格させる予定。
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import date, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import httpx  # noqa: E402
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


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """LLM/TTS用のhttpxクライアントをプロセス寿命で共有する(毎ターンのTLSハンドシェイクを回避)。"""
    llm_client = httpx.AsyncClient(
        timeout=llm.REQUEST_TIMEOUT,
        limits=httpx.Limits(max_keepalive_connections=20, keepalive_expiry=30),
    )
    tts_client = httpx.AsyncClient(
        timeout=tts.REQUEST_TIMEOUT,
        limits=httpx.Limits(max_keepalive_connections=20, keepalive_expiry=30),
    )
    llm.set_client(llm_client)
    tts.set_client(tts_client)
    try:
        yield
    finally:
        await llm_client.aclose()
        await tts_client.aclose()
        llm.set_client(None)
        tts.set_client(None)


app = FastAPI(title="Aikata", lifespan=_lifespan)
# H9: 旧実装は allow_methods/allow_headers=["*"] を許可していた。
# allow_credentials=True と併用すると、strict なブラウザで preflight が
# 通らないケースを生む他、credentials 付きで使う実表面に対する過剰許可になる。
# 本API が実際に使うのは GET/POST と Authorization/Content-Type だけなので明示的に限定する。
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)
memory.init_db()

# --- レート制限 / TTS ゲート(Phase D: 公開時のコスト・不正利用対策)---
# 公開では既定で TTS オフ(Aivis Cloud API のクレジット消費を抑えるため)。ローカルは .env で ENABLE_TTS=true。
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
# 認証用JWTクッキー(C4: localStorage → HttpOnly Cookie 化)。
# JSから読めないため XSS でアカウント乗っ取り不可能になる。
AUTH_COOKIE_NAME = "aikata_token"
AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30日(JWT_TTL と整合)
EMOTION_TAG_RE = re.compile(r"\[(neutral|happy|sad|angry|relaxed|shy)\]")
_EMOTION_TAG_LITERALS = tuple(f"[{e}]" for e in persona.EMOTIONS)


def _could_still_be_tag_prefix(buffer: str) -> bool:
    """bufferが冒頭の感情タグ([happy]等)の途中である可能性が残っているかを判定する。

    応答ストリームの最初のトークンを「感情タグが確定するまで」待たせると、モデルが
    タグを書かない/書くのが遅いケースで不要なレイテンシが乗る。タグの途中である
    可能性が無くなった時点(=先頭が`[`でない、または6種いずれの接頭辞でもない)で
    即座にバッファ保持をやめられるよう、この判定だけを切り出す。
    """
    candidate = buffer.lstrip()
    if not candidate:
        return True
    return any(literal.startswith(candidate) for literal in _EMOTION_TAG_LITERALS)


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


class AuthRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=200)


def _resolve_uid(request: Request) -> str:
    """有効な JWT(httpOnly Cookie) があればそのアカウントID、無ければ匿名Cookie ID を返す。

    C4: 旧実装は Authorization: Bearer ヘッダ(localStorage 由来)を読んでいたが、
    XSS で JS 経由でトークンが即座に奪われる弱点だったため httpOnly Cookie に移行。
    """
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if token:
        sub = auth.decode_token(token)
        if sub:
            return sub
    return request.state.uid


def _is_https(request: Request) -> bool:
    """プロキシ背後(Render/Caddy 等)の X-Forwarded-Proto も信頼して https 判定。

    Secure クッキーは https でなければブラウザが保存しない(chrome は SameSite=None には
    Secure 必須だが、SameSite=Lax でも https 判定に依存しないと AttributeError 系の落とし穴)。
    """
    if request.url.scheme == "https":
        return True
    return request.headers.get("x-forwarded-proto", "").lower().startswith("https")


def _set_auth_cookie(response: Response, token: str, request: Request) -> None:
    response.set_cookie(
        AUTH_COOKIE_NAME,
        token,
        max_age=AUTH_COOKIE_MAX_AGE,
        httponly=True,
        secure=_is_https(request),
        samesite="lax",
        path="/",
    )


def _clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")


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


@app.post("/api/auth/signup")
async def auth_signup(req: AuthRequest, request: Request, response: Response) -> dict:
    try:
        token = auth.signup(req.email, req.password, anon_uid=request.state.uid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _set_auth_cookie(response, token, request)
    return {"ok": True}


@app.post("/api/auth/login")
async def auth_login(req: AuthRequest, request: Request, response: Response) -> dict:
    ip = request.client.host if request.client else "unknown"
    if memory.bump_usage(f"login:{ip}", date.today().isoformat()) > RATE_LOGIN_PER_IP_PER_DAY:
        raise HTTPException(status_code=429, detail="ログイン試行が多すぎます。時間をおいて再度お試しください。")
    try:
        token = auth.login(req.email, req.password)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    _set_auth_cookie(response, token, request)
    return {"ok": True}


@app.post("/api/auth/logout")
async def auth_logout(response: Response) -> dict:
    """認証JWTクッキーを削除。匿名Cookieは残る(再ログイン前は匿名扱いに戻る)。"""
    _clear_auth_cookie(response)
    return {"ok": True}


@app.get("/api/auth/me")
async def auth_me(request: Request) -> dict:
    uid = _resolve_uid(request)
    user = memory.get_user_by_id(uid)
    return {"authenticated": user is not None, "email": user["email"] if user else None}


@app.get("/api/state")
async def get_state(request: Request) -> dict:
    return _state_payload(_resolve_uid(request))


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
    except Exception as exc:
        logger.warning("fact extraction failed for user %s: %s", user_id, exc)
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
    except Exception as exc:
        logger.warning("history summarization failed for user %s: %s", user_id, exc)
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
    _enforce_rate_limit(uid)
    # 親密度: 1発言 +1、その日最初の会話はボーナス
    today_first = not any(
        m["role"] == "user" for m in memory.messages_on(uid, date.today())
    )
    memory.add_message(uid, "user", req.message)
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
                    # 感情タグはペルソナ指示で応答冒頭に来る前提だが、全部确定するまで待つと
                    # タグが無い/遅いケースで不要なレイテンシが乗る。「まだタグの途中かも
                    # しれない」間だけバッファし、タグが来ない/タグが終わった時点で即座に流す。
                    match = EMOTION_TAG_RE.search(buffer)
                    if match:
                        emotion = match.group(1)
                        yield sse({"type": "emotion", "emotion": emotion})
                        # タグ自身だけを取り除き、タグより前のテキスト(本来は無い想定だが
                        # モデルが守らない場合もある)は保持する。match.end()からの切り出しは
                        # タグ前のテキストを失うため使わない。
                        buffer = (buffer[:match.start()] + buffer[match.end():]).lstrip()
                    elif len(buffer) > 24 or not _could_still_be_tag_prefix(buffer):
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
            # H5: 旧実装は type(exc).__name__ をクライアントへ晒し、
            # 内部スタック/ベンダ情報の偵察起点になっていた。サーバログだけで詳細を扱い、
            # ユーザー向けメッセージは固定化する。
            logger.error("chat stream failed for user %s: %s", uid, exc)
            yield sse({
                "type": "error",
                "message": "応答の生成に失敗しました。しばらくしてから再度お試しください。",
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
    uid = _resolve_uid(request)
    last_seen = memory.get_kv(uid, "last_seen")
    user_name = memory.get_kv(uid, "user_name")
    name_note = (
        f"相手の名前は「{user_name}」。"
        if user_name
        else "相手の名前はまだ知らない(「ユーザーさん」のような呼び方はせず、名前を呼ばずに話す)。"
    )
    days_away: int | None = None
    if req.reason == "greeting":
        if last_seen:
            elapsed = datetime.now() - datetime.fromisoformat(last_seen)
            if elapsed.total_seconds() < GREETING_MIN_GAP_SECONDS:
                # ついさっき(リロード等)開いただけ。毎回挨拶し直すと干渉しすぎになるので省略する。
                memory.touch_last_seen(uid)
                return {"text": "", "emotion": "neutral", "days_away": None}
        gap = ""
        if last_seen:
            days = (datetime.now() - datetime.fromisoformat(last_seen)).days
            if days >= 2:
                gap = f"ユーザーと会うのは約{days}日ぶり。"
                days_away = days
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
        return {"text": "", "emotion": "neutral", "days_away": None}
    emotion, text = _strip_emotion(raw)
    if text:
        memory.add_message(uid, "assistant", text, emotion)
    memory.touch_last_seen(uid)
    return {"text": text, "emotion": emotion, "days_away": days_away}


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


def _filter_for_tts(text: str) -> str:
    """TTS 送信前にテキストを整形する。
    [emotion] タグ・(括弧補足)・*強調*・<タグ> をそのまま読み上げるバグを防ぐ。
    LLM の記憶・字幕・履歴には影響させないこと(TTS 直前のみ適用)。
    """
    text = re.sub(r"\[.*?\]", "", text, flags=re.DOTALL)  # [happy] 等の感情タグ
    text = re.sub(r"\(.*?\)", "", text, flags=re.DOTALL)  # (補足)
    text = re.sub(r"\*.*?\*", "", text, flags=re.DOTALL)  # *強調*
    text = re.sub(r"<[^>]+>", "", text)                   # <think> 残滓など
    return text.strip()


@app.get("/api/tts")
async def get_tts(text: str, emotion: str | None = None) -> Response:
    if not ENABLE_TTS:  # 公開では既定オフ(無料枠保護)。無音=テキストのみ
        return Response(status_code=204)
    audio = await tts.synthesize(_filter_for_tts(text[:300]), emotion)
    if audio is None:
        return Response(status_code=204)
    return Response(content=audio, media_type="audio/mpeg")


# 本番ビルド時はフロントエンドの成果物を同居配信する
_static = Path(__file__).resolve().parent.parent / "static"
if _static.is_dir():
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
