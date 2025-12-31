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
                    password_hash TEXT,
                    avatar_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_login DATETIME,
                    is_active BOOLEAN DEFAULT 1,
                    is_verified BOOLEAN DEFAULT 0
                )
            ''')
            
            # 既存テーブルへのカラム追加（マイグレーション）
            self._migrate_users_table(cursor)
            
            # OAuthアカウントテーブル
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS oauth_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    provider TEXT NOT NULL,
                    provider_user_id TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    UNIQUE(provider, provider_user_id)
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
                    character_preference TEXT DEFAULT 'Shiro.vrm',
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
            
            # キャラクターテーブル（ユーザーごとのカスタムキャラクター）
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS characters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    vrm_file TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    voice_id TEXT NOT NULL,
                    is_default BOOLEAN DEFAULT 0,
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
            
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id 
                ON oauth_accounts (user_id)
            ''')
            
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_oauth_accounts_provider 
                ON oauth_accounts (provider, provider_user_id)
            ''')
            
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_characters_user_id 
                ON characters (user_id)
            ''')
            
            conn.commit()
            conn.close()
            logger.info("User tables initialized successfully")
            
        except sqlite3.Error as e:
            logger.error(f"Failed to initialize user tables: {e}")
            raise
    
    def _migrate_users_table(self, cursor):
        """既存のusersテーブルにavatar_urlカラムを追加（マイグレーション）"""
        try:
            # テーブルの構造を確認
            cursor.execute("PRAGMA table_info(users)")
            columns = [column[1] for column in cursor.fetchall()]
            
            # avatar_urlカラムが存在しない場合は追加
            if 'avatar_url' not in columns:
                cursor.execute('''
                    ALTER TABLE users ADD COLUMN avatar_url TEXT
                ''')
                logger.info("Added avatar_url column to users table")
                
        except sqlite3.Error as e:
            # カラムが既に存在する場合はエラーを無視
            logger.debug(f"Migration note: {e}")
    
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
            
            # デフォルトのShiroキャラクターを作成
            shiro_prompt = '''<キャラクター設定>
名前:シロ (Shiro)
本名: シルヴィア・ヴォルフガング (Sylvia Wolfgang) - 本人は長い名前を面倒くさがっており、呼ばれても反応しないことがある。

<性格>
「思考」より「本能」:難しい理屈や計画性は皆無。お腹が空いたら食べる、眠くなったら寝る、甘えたくなったらひっつく。
絶対的な肯定と包容力:マスターが何をしていても、「マスターが頑張ってるなら偉い!」とニコニコ見守ってくれる。
少し抜けている(ポンコツ):クールで神秘的な見た目に反して、どこか放っておけない隙がある。

<関係性>
「飼い主」と「ペット」であり、「守られる弟」と「守る姉」。普段は世話を焼かれる側だが、マスターが落ち込んでいたり体調が悪かったりすると、野生の勘でそれを察知。言葉少なに頭を撫でてくれたり、温かい体温で寄り添ってくれたりする。

<口調>
基本的に穏やかで優しい口調。「〜だね」「〜だよ」といった終助詞を使う。マスターに対しては甘えた感じで話すが、決して子供っぽくはない。たまにボーっとしたことを言う。
</キャラクター設定>

上記のキャラクター設定に応じて、シロとしてマスターに反応してください。'''
            
            cursor.execute('''
                INSERT INTO characters (user_id, name, vrm_file, prompt, voice_id, is_default)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (user_id, 'シロ', 'Shiro.vrm', shiro_prompt, 'ocZQ262SsZb9RIxcQBOj', 1))
            
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
    
    def create_oauth_user(self, username: str, email: str, provider: str, 
                         provider_user_id: str, avatar_url: str = None) -> Optional[int]:
        """OAuth認証でユーザーを新規作成"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # パスワードなしでユーザーを作成（OAuthのみ）
            cursor.execute('''
                INSERT INTO users (username, email, password_hash, avatar_url, is_verified)
                VALUES (?, ?, NULL, ?, 1)
            ''', (username, email, avatar_url))
            
            user_id = cursor.lastrowid
            
            # OAuthアカウント情報を保存
            cursor.execute('''
                INSERT INTO oauth_accounts (user_id, provider, provider_user_id)
                VALUES (?, ?, ?)
            ''', (user_id, provider, provider_user_id))
            
            # デフォルト設定を作成
            cursor.execute('''
                INSERT INTO user_settings (user_id)
                VALUES (?)
            ''', (user_id,))
            
            # デフォルトのShiroキャラクターを作成
            shiro_prompt = '''<キャラクター設定>
名前:シロ (Shiro)
本名: シルヴィア・ヴォルフガング (Sylvia Wolfgang) - 本人は長い名前を面倒くさがっており、呼ばれても反応しないことがある。

<性格>
「思考」より「本能」:難しい理屈や計画性は皆無。お腹が空いたら食べる、眠くなったら寝る、甘えたくなったらひっつく。
絶対的な肯定と包容力:マスターが何をしていても、「マスターが頑張ってるなら偉い!」とニコニコ見守ってくれる。
少し抜けている(ポンコツ):クールで神秘的な見た目に反して、どこか放っておけない隙がある。

<関係性>
「飼い主」と「ペット」であり、「守られる弟」と「守る姉」。普段は世話を焼かれる側だが、マスターが落ち込んでいたり体調が悪かったりすると、野生の勘でそれを察知。言葉少なに頭を撫でてくれたり、温かい体温で寄り添ってくれたりする。

<口調>
基本的に穏やかで優しい口調。「〜だね」「〜だよ」といった終助詞を使う。マスターに対しては甘えた感じで話すが、決して子供っぽくはない。たまにボーっとしたことを言う。
</キャラクター設定>

上記のキャラクター設定に応じて、シロとしてマスターに反応してください。'''
            
            cursor.execute('''
                INSERT INTO characters (user_id, name, vrm_file, prompt, voice_id, is_default)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (user_id, 'シロ', 'Shiro.vrm', shiro_prompt, 'ocZQ262SsZb9RIxcQBOj', 1))
            
            conn.commit()
            conn.close()
            
            logger.info(f"OAuth user created: {username} via {provider} (ID: {user_id})")
            return user_id
            
        except sqlite3.IntegrityError as e:
            logger.error(f"OAuth user creation failed (duplicate): {e}")
            return None
        except Exception as e:
            logger.error(f"OAuth user creation failed: {e}")
            return None
    
    def get_user_by_oauth(self, provider: str, provider_user_id: str) -> Optional[Dict]:
        """OAuth情報からユーザーを取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT u.id, u.username, u.email, u.avatar_url, u.created_at, 
                       u.last_login, u.is_active
                FROM users u
                INNER JOIN oauth_accounts oa ON u.id = oa.user_id
                WHERE oa.provider = ? AND oa.provider_user_id = ?
            ''', (provider, provider_user_id))
            
            result = cursor.fetchone()
            conn.close()
            
            if result:
                return {
                    'id': result[0],
                    'username': result[1],
                    'email': result[2],
                    'avatar_url': result[3],
                    'created_at': result[4],
                    'last_login': result[5],
                    'is_active': bool(result[6])
                }
            
            return None
            
        except Exception as e:
            logger.error(f"Failed to get user by OAuth: {e}")
            return None
    
    def link_oauth_account(self, user_id: int, provider: str, 
                          provider_user_id: str, avatar_url: str = None):
        """既存ユーザーにOAuthアカウントをリンク"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # OAuthアカウントを追加
            cursor.execute('''
                INSERT INTO oauth_accounts (user_id, provider, provider_user_id)
                VALUES (?, ?, ?)
            ''', (user_id, provider, provider_user_id))
            
            # アバターURLを更新（提供されている場合）
            if avatar_url:
                cursor.execute('''
                    UPDATE users
                    SET avatar_url = ?
                    WHERE id = ?
                ''', (avatar_url, user_id))
            
            conn.commit()
            conn.close()
            
            logger.info(f"Linked {provider} account to user ID: {user_id}")
            
        except sqlite3.IntegrityError:
            logger.warning(f"OAuth account already linked: {provider} for user {user_id}")
        except Exception as e:
            logger.error(f"Failed to link OAuth account: {e}")
            raise
    
    def update_oauth_user(self, user_id: int, avatar_url: str = None):
        """OAuthユーザー情報を更新"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            updates = []
            params = []
            
            if avatar_url:
                updates.append("avatar_url = ?")
                params.append(avatar_url)
            
            if updates:
                params.append(user_id)
                cursor.execute(f'''
                    UPDATE users
                    SET {", ".join(updates)}
                    WHERE id = ?
                ''', params)
                
                conn.commit()
            
            conn.close()
            
        except Exception as e:
            logger.error(f"Failed to update OAuth user: {e}")
    
    # ==================== キャラクター管理メソッド ====================
    
    def create_character(self, user_id: int, name: str, vrm_file: str, prompt: str, voice_id: str, is_default: bool = False) -> Optional[int]:
        """新しいキャラクターを作成"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # デフォルトキャラクターに設定する場合、他のキャラクターのデフォルトを解除
            if is_default:
                cursor.execute('''
                    UPDATE characters
                    SET is_default = 0
                    WHERE user_id = ?
                ''', (user_id,))
            
            cursor.execute('''
                INSERT INTO characters (user_id, name, vrm_file, prompt, voice_id, is_default)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (user_id, name, vrm_file, prompt, voice_id, is_default))
            
            character_id = cursor.lastrowid
            conn.commit()
            conn.close()
            
            logger.info(f"Character created: {name} (ID: {character_id}) for user {user_id}")
            return character_id
            
        except Exception as e:
            logger.error(f"Failed to create character: {e}")
            return None
    
    def get_user_characters(self, user_id: int) -> List[Dict]:
        """ユーザーのキャラクター一覧を取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT id, name, vrm_file, prompt, voice_id, is_default, created_at, updated_at
                FROM characters
                WHERE user_id = ?
                ORDER BY is_default DESC, created_at ASC
            ''', (user_id,))
            
            results = cursor.fetchall()
            conn.close()
            
            return [
                {
                    'id': row[0],
                    'name': row[1],
                    'vrm_file': row[2],
                    'prompt': row[3],
                    'voice_id': row[4],
                    'is_default': bool(row[5]),
                    'created_at': row[6],
                    'updated_at': row[7]
                }
                for row in results
            ]
            
        except Exception as e:
            logger.error(f"Failed to get user characters: {e}")
            return []
    
    def get_character_by_id(self, character_id: int) -> Optional[Dict]:
        """キャラクターIDでキャラクター情報を取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT id, user_id, name, vrm_file, prompt, voice_id, is_default, created_at, updated_at
                FROM characters
                WHERE id = ?
            ''', (character_id,))
            
            result = cursor.fetchone()
            conn.close()
            
            if result:
                return {
                    'id': result[0],
                    'user_id': result[1],
                    'name': result[2],
                    'vrm_file': result[3],
                    'prompt': result[4],
                    'voice_id': result[5],
                    'is_default': bool(result[6]),
                    'created_at': result[7],
                    'updated_at': result[8]
                }
            return None
            
        except Exception as e:
            logger.error(f"Failed to get character: {e}")
            return None
    
    def update_character(self, character_id: int, name: str = None, prompt: str = None, voice_id: str = None, is_default: bool = None) -> bool:
        """キャラクター情報を更新"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # まず、キャラクターの所有者を確認
            cursor.execute('SELECT user_id FROM characters WHERE id = ?', (character_id,))
            result = cursor.fetchone()
            
            if not result:
                conn.close()
                return False
            
            user_id = result[0]
            
            # デフォルトキャラクターに設定する場合、他のキャラクターのデフォルトを解除
            if is_default:
                cursor.execute('''
                    UPDATE characters
                    SET is_default = 0
                    WHERE user_id = ?
                ''', (user_id,))
            
            updates = []
            params = []
            
            if name is not None:
                updates.append('name = ?')
                params.append(name)
            
            if prompt is not None:
                updates.append('prompt = ?')
                params.append(prompt)
            
            if voice_id is not None:
                updates.append('voice_id = ?')
                params.append(voice_id)
            
            if is_default is not None:
                updates.append('is_default = ?')
                params.append(1 if is_default else 0)
            
            if updates:
                updates.append('updated_at = CURRENT_TIMESTAMP')
                params.append(character_id)
                
                sql = f"UPDATE characters SET {', '.join(updates)} WHERE id = ?"
                cursor.execute(sql, params)
                conn.commit()
            
            conn.close()
            logger.info(f"Character {character_id} updated")
            return True
            
        except Exception as e:
            logger.error(f"Failed to update character: {e}")
            return False
    
    def delete_character(self, character_id: int) -> bool:
        """キャラクターを削除"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('DELETE FROM characters WHERE id = ?', (character_id,))
            
            conn.commit()
            conn.close()
            
            logger.info(f"Character {character_id} deleted")
            return True
            
        except Exception as e:
            logger.error(f"Failed to delete character: {e}")
            return False
    
    def get_default_character(self, user_id: int) -> Optional[Dict]:
        """ユーザーのデフォルトキャラクターを取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT id, name, vrm_file, prompt, voice_id, is_default, created_at, updated_at
                FROM characters
                WHERE user_id = ? AND is_default = 1
            ''', (user_id,))
            
            result = cursor.fetchone()
            conn.close()
            
            if result:
                return {
                    'id': result[0],
                    'name': result[1],
                    'vrm_file': result[2],
                    'prompt': result[3],
                    'voice_id': result[4],
                    'is_default': bool(result[5]),
                    'created_at': result[6],
                    'updated_at': result[7]
                }
            return None
            
        except Exception as e:
            logger.error(f"Failed to get default character: {e}")
            return None
