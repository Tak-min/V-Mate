"""
ユーザーモデル - データベーススキーマと操作
"""
import sqlite3
import bcrypt
from datetime import datetime, timedelta
from typing import Optional, Dict, List
import logging

logger = logging.getLogger(__name__)


class User:
    """ユーザーモデルクラス"""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.init_tables()
    
    def init_tables(self):
        """ユーザー関連テーブルの初期化"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # ユーザーテーブル
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_login DATETIME,
                    is_active BOOLEAN DEFAULT 1,
                    is_verified BOOLEAN DEFAULT 0
                )
            ''')
            
            # リフレッシュトークンテーブル
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')
            
            # ユーザー設定テーブル
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id INTEGER PRIMARY KEY,
                    character_preference TEXT DEFAULT 'yui.vrm',
                    background_preference TEXT DEFAULT 'sky.jpg',
                    voice_volume REAL DEFAULT 0.7,
                    voice_speed REAL DEFAULT 1.0,
                    memory_enabled BOOLEAN DEFAULT 1,
                    use_3d_ui BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            ''')
            
            # インデックス作成
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_users_email 
                ON users (email)
            ''')
            
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_users_username 
                ON users (username)
            ''')
            
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id 
                ON refresh_tokens (user_id)
            ''')
            
            conn.commit()
            conn.close()
            logger.info("User tables initialized successfully")
            
        except sqlite3.Error as e:
            logger.error(f"Failed to initialize user tables: {e}")
            raise
    
    def create_user(self, username: str, email: str, password: str) -> Optional[int]:
        """新規ユーザーを作成"""
        try:
            # パスワードハッシュ化
            password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt(rounds=12))
            
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT INTO users (username, email, password_hash)
                VALUES (?, ?, ?)
            ''', (username, email, password_hash))
            
            user_id = cursor.lastrowid
            
            # デフォルト設定を作成
            cursor.execute('''
                INSERT INTO user_settings (user_id)
                VALUES (?)
            ''', (user_id,))
            
            conn.commit()
            conn.close()
            
            logger.info(f"User created: {username} (ID: {user_id})")
            return user_id
            
        except sqlite3.IntegrityError as e:
            logger.error(f"User creation failed (duplicate): {e}")
            return None
        except Exception as e:
            logger.error(f"User creation failed: {e}")
            return None
    
    def verify_password(self, email: str, password: str) -> Optional[Dict]:
        """パスワードを検証してユーザー情報を返す"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT id, username, email, password_hash, is_active
                FROM users
                WHERE email = ?
            ''', (email,))
            
            result = cursor.fetchone()
            conn.close()
            
            if not result:
                return None
            
            user_id, username, email, password_hash, is_active = result
            
            # アカウント無効チェック
            if not is_active:
                logger.warning(f"Login attempt for inactive account: {email}")
                return None
            
            # パスワード検証
            if bcrypt.checkpw(password.encode('utf-8'), password_hash):
                return {
                    'id': user_id,
                    'username': username,
                    'email': email,
                    'is_active': bool(is_active)
                }
            
            return None
            
        except Exception as e:
            logger.error(f"Password verification failed: {e}")
            return None
    
    def update_last_login(self, user_id: int):
        """最終ログイン時刻を更新"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                UPDATE users
                SET last_login = CURRENT_TIMESTAMP
                WHERE id = ?
            ''', (user_id,))
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logger.error(f"Failed to update last login: {e}")
    
    def get_user_by_id(self, user_id: int) -> Optional[Dict]:
        """ユーザーIDからユーザー情報を取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT id, username, email, created_at, last_login, is_active
                FROM users
                WHERE id = ?
            ''', (user_id,))
            
            result = cursor.fetchone()
            conn.close()
            
            if result:
                return {
                    'id': result[0],
                    'username': result[1],
                    'email': result[2],
                    'created_at': result[3],
                    'last_login': result[4],
                    'is_active': bool(result[5])
                }
            
            return None
            
        except Exception as e:
            logger.error(f"Failed to get user by id: {e}")
            return None
    
    def get_user_by_email(self, email: str) -> Optional[Dict]:
        """メールアドレスからユーザー情報を取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT id, username, email, created_at, last_login, is_active
                FROM users
                WHERE email = ?
            ''', (email,))
            
            result = cursor.fetchone()
            conn.close()
            
            if result:
                return {
                    'id': result[0],
                    'username': result[1],
                    'email': result[2],
                    'created_at': result[3],
                    'last_login': result[4],
                    'is_active': bool(result[5])
                }
            
            return None
            
        except Exception as e:
            logger.error(f"Failed to get user by email: {e}")
            return None
    
    def get_user_settings(self, user_id: int) -> Optional[Dict]:
        """ユーザー設定を取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT character_preference, background_preference, 
                       voice_volume, voice_speed, memory_enabled, use_3d_ui
                FROM user_settings
                WHERE user_id = ?
            ''', (user_id,))
            
            result = cursor.fetchone()
            conn.close()
            
            if result:
                return {
                    'character': result[0],
                    'background': result[1],
                    'volume': result[2],
                    'voiceSpeed': result[3],
                    'memoryEnabled': bool(result[4]),
                    'use3DUI': bool(result[5])
                }
            
            return None
            
        except Exception as e:
            logger.error(f"Failed to get user settings: {e}")
            return None
    
    def update_user_settings(self, user_id: int, settings: Dict):
        """ユーザー設定を更新"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                UPDATE user_settings
                SET character_preference = ?,
                    background_preference = ?,
                    voice_volume = ?,
                    voice_speed = ?,
                    memory_enabled = ?,
                    use_3d_ui = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ?
            ''', (
                settings.get('character', 'yui.vrm'),
                settings.get('background', 'sky.jpg'),
                settings.get('volume', 0.7),
                settings.get('voiceSpeed', 1.0),
                settings.get('memoryEnabled', True),
                settings.get('use3DUI', True),
                user_id
            ))
            
            conn.commit()
            conn.close()
            
            logger.info(f"User settings updated for user ID: {user_id}")
            
        except Exception as e:
            logger.error(f"Failed to update user settings: {e}")
            raise
    
    def save_refresh_token(self, user_id: int, token_hash: str, expires_at: datetime):
        """リフレッシュトークンを保存"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
                VALUES (?, ?, ?)
            ''', (user_id, token_hash, expires_at.isoformat()))
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logger.error(f"Failed to save refresh token: {e}")
            raise
    
    def verify_refresh_token(self, token_hash: str) -> Optional[int]:
        """リフレッシュトークンを検証してユーザーIDを返す"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT user_id, expires_at
                FROM refresh_tokens
                WHERE token_hash = ?
            ''', (token_hash,))
            
            result = cursor.fetchone()
            conn.close()
            
            if not result:
                return None
            
            user_id, expires_at = result
            
            # 有効期限チェック
            if datetime.fromisoformat(expires_at) < datetime.utcnow():
                return None
            
            return user_id
            
        except Exception as e:
            logger.error(f"Failed to verify refresh token: {e}")
            return None
    
    def delete_refresh_token(self, token_hash: str):
        """リフレッシュトークンを削除"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                DELETE FROM refresh_tokens
                WHERE token_hash = ?
            ''', (token_hash,))
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logger.error(f"Failed to delete refresh token: {e}")
    
    def delete_user_refresh_tokens(self, user_id: int):
        """ユーザーの全リフレッシュトークンを削除（ログアウト）"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                DELETE FROM refresh_tokens
                WHERE user_id = ?
            ''', (user_id,))
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logger.error(f"Failed to delete user refresh tokens: {e}")
