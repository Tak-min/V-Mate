"""
認証マネージャー - JWT トークン生成・検証
"""
import jwt
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional, Dict
from functools import wraps
from flask import request, jsonify
import logging

logger = logging.getLogger(__name__)


class AuthManager:
    """JWT認証マネージャークラス"""
    
    def __init__(self, secret_key: str, user_model):
        self.secret_key = secret_key
        self.user_model = user_model
        self.algorithm = 'HS256'
        self.access_token_expire_minutes = 15
        self.refresh_token_expire_days = 30
    
    def generate_access_token(self, user_id: int, email: str) -> str:
        """アクセストークンを生成"""
        payload = {
            'user_id': user_id,
            'email': email,
            'type': 'access',
            'exp': datetime.utcnow() + timedelta(minutes=self.access_token_expire_minutes),
            'iat': datetime.utcnow()
        }
        
        token = jwt.encode(payload, self.secret_key, algorithm=self.algorithm)
        return token
    
    def generate_refresh_token(self, user_id: int) -> str:
        """リフレッシュトークンを生成"""
        # ランダムなトークン生成
        token = secrets.token_urlsafe(64)
        
        # トークンハッシュ化（データベース保存用）
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        
        # 有効期限
        expires_at = datetime.utcnow() + timedelta(days=self.refresh_token_expire_days)
        
        # データベースに保存
        self.user_model.save_refresh_token(user_id, token_hash, expires_at)
        
        return token
    
    def verify_access_token(self, token: str) -> Optional[Dict]:
        """アクセストークンを検証"""
        try:
            payload = jwt.decode(token, self.secret_key, algorithms=[self.algorithm])
            
            # トークンタイプチェック
            if payload.get('type') != 'access':
                return None
            
            return {
                'user_id': payload['user_id'],
                'email': payload['email']
            }
            
        except jwt.ExpiredSignatureError:
            logger.warning("Access token expired")
            return None
        except jwt.InvalidTokenError as e:
            logger.warning(f"Invalid access token: {e}")
            return None
    
    def verify_refresh_token(self, token: str) -> Optional[int]:
        """リフレッシュトークンを検証してユーザーIDを返す"""
        try:
            # トークンハッシュ化
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            
            # データベースで検証
            user_id = self.user_model.verify_refresh_token(token_hash)
            
            return user_id
            
        except Exception as e:
            logger.error(f"Failed to verify refresh token: {e}")
            return None
    
    def revoke_refresh_token(self, token: str):
        """リフレッシュトークンを無効化"""
        try:
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            self.user_model.delete_refresh_token(token_hash)
            
        except Exception as e:
            logger.error(f"Failed to revoke refresh token: {e}")
    
    def revoke_all_user_tokens(self, user_id: int):
        """ユーザーの全トークンを無効化（ログアウト）"""
        try:
            self.user_model.delete_user_refresh_tokens(user_id)
            
        except Exception as e:
            logger.error(f"Failed to revoke all user tokens: {e}")
    
    def refresh_access_token(self, refresh_token: str) -> Optional[Dict]:
        """リフレッシュトークンを使って新しいアクセストークンを生成"""
        user_id = self.verify_refresh_token(refresh_token)
        
        if not user_id:
            return None
        
        # ユーザー情報取得
        user = self.user_model.get_user_by_id(user_id)
        
        if not user or not user['is_active']:
            return None
        
        # 新しいアクセストークン生成
        access_token = self.generate_access_token(user_id, user['email'])
        
        return {
            'access_token': access_token,
            'user': user
        }


def token_required(f):
    """
    デコレーター: アクセストークン認証が必要なエンドポイント用
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        
        # ヘッダーからトークン取得
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            try:
                token = auth_header.split(' ')[1]  # "Bearer <token>"
            except IndexError:
                return jsonify({'error': 'Invalid authorization header format'}), 401
        
        if not token:
            return jsonify({'error': 'Authentication token is missing'}), 401
        
        # トークン検証
        from flask import current_app
        auth_manager = current_app.config['AUTH_MANAGER']
        
        payload = auth_manager.verify_access_token(token)
        
        if not payload:
            return jsonify({'error': 'Invalid or expired token'}), 401
        
        # ユーザー情報を関数に渡す
        return f(current_user=payload, *args, **kwargs)
    
    return decorated


def optional_token(f):
    """
    デコレーター: トークン認証がオプションのエンドポイント用
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        current_user = None
        
        # ヘッダーからトークン取得
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            try:
                token = auth_header.split(' ')[1]
                
                # トークン検証
                from flask import current_app
                auth_manager = current_app.config['AUTH_MANAGER']
                
                payload = auth_manager.verify_access_token(token)
                
                if payload:
                    current_user = payload
                    
            except (IndexError, KeyError):
                pass
        
        # ユーザー情報を関数に渡す
        return f(current_user=current_user, *args, **kwargs)
    
    return decorated
