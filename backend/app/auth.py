"""認証 — email+password(bcrypt)+ JWT(HS256)。

user_id は users.id(uuid hex)。JWT の sub に格納する。
匿名Cookieユーザーのデータは signup 時にアカウントへ引き継ぐ(reassign)。
本番では必ず環境変数 JWT_SECRET を設定すること(未設定だと再起動でトークン失効)。
"""

from __future__ import annotations

import os
import re
import time
import uuid

import bcrypt
import jwt

from . import memory

JWT_ALG = "HS256"
JWT_TTL = 60 * 60 * 24 * 30  # 30日
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# JWT_SECRET は環境変数で必ず 32 バイト以上の強固な値を設定する。
# 旧実装は未設定/短すぎる場合にハードコード定数でフォールバック静默稼働し、
# ソースを知る攻撃者が任意 sub の JWT を偽造できる致命的弱点だった。
# 参照は _get_jwt_secret() 経由のみとし、未設定/短すぎでは即座に RuntimeError で fail-fast する。
# モジュール import 時点では env を評価せず、トークン発行/検証の使用時に毎回評価する
# (テストが conftest で JWT_SECRET を注入できるようにするため)。
_MIN_SECRET_BYTES = 32


def _get_jwt_secret() -> str:
    raw = os.environ.get("JWT_SECRET", "").strip()
    if len(raw) < _MIN_SECRET_BYTES:
        raise RuntimeError(
            "JWT_SECRET が未設定または32バイト未満です。"
            "本番運用時は必ず32バイト以上のランダム文字列を環境変数 JWT_SECRET に設定してください。"
            " 開発時: export JWT_SECRET=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')"
        )
    return raw


def _pw_bytes(password: str) -> bytes:
    # bcrypt は 72 バイト上限。超過分は切り捨てる。
    return password.encode("utf-8")[:72]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_pw_bytes(password), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_pw_bytes(password), password_hash.encode("ascii"))
    except (ValueError, TypeError):
        return False


def create_token(user_id: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": user_id, "iat": now, "exp": now + JWT_TTL},
        _get_jwt_secret(),
        algorithm=JWT_ALG,
    )


def decode_token(token: str) -> str | None:
    """検証成功で user_id(sub)、失敗で None。"""
    try:
        payload = jwt.decode(token, _get_jwt_secret(), algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) else None


def signup(email: str, password: str, anon_uid: str | None = None) -> str:
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise ValueError("メールアドレスの形式が正しくありません")
    if memory.get_user_by_email(email):
        raise ValueError("このメールアドレスは既に登録されています")
    user_id = uuid.uuid4().hex
    memory.create_user(user_id, email, hash_password(password))
    # 匿名で貯めた会話・記憶をアカウントへ引き継ぐ
    if anon_uid and anon_uid != user_id and not memory.get_user_by_id(anon_uid):
        memory.reassign_user_data(anon_uid, user_id)
    return create_token(user_id)


def login(email: str, password: str) -> str:
    email = email.strip().lower()
    user = memory.get_user_by_email(email)
    if not user or not verify_password(password, user["password_hash"]):
        raise ValueError("メールアドレスまたはパスワードが違います")
    return create_token(user["id"])
