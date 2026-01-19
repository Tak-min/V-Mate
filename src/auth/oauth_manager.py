"""
OAuth 2.0 マネージャー - Google & GitHub OAuth統合
"""
from authlib.integrations.flask_client import OAuth
from flask import url_for, session
import os
import logging

logger = logging.getLogger(__name__)


class OAuthManager:
    """OAuth 2.0認証マネージャークラス"""
    
    def __init__(self, app, user_model, auth_manager):
        """
        OAuth マネージャーを初期化
        
        Args:
            app: Flask アプリケーション
            user_model: ユーザーモデル
            auth_manager: JWT認証マネージャー
        """
        self.app = app
        self.user_model = user_model
        self.auth_manager = auth_manager
        self.oauth = OAuth(app)
        
        # Google OAuth設定
        self._setup_google_oauth()
    
    def _setup_google_oauth(self):
        """Google OAuth 2.0の設定"""
        google_client_id = os.getenv('GOOGLE_CLIENT_ID')
        google_client_secret = os.getenv('GOOGLE_CLIENT_SECRET')
        
        if not google_client_id or not google_client_secret:
            logger.warning("Google OAuth credentials not configured")
            self.google_client = None
            return
        
        try:
            # OAuth クライアントを登録（名前衝突を避けるため google_client という属性名を使用）
            self.google_client = self.oauth.register(
                name='google',
                client_id=google_client_id,
                client_secret=google_client_secret,
                server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
                client_kwargs={
                    'scope': 'openid email profile',
                    'prompt': 'select_account',  # 常にアカウント選択画面を表示
                }
            )
            
            logger.info("Google OAuth configured successfully")
        except Exception as e:
            logger.error(f"Failed to setup Google OAuth: {e}", exc_info=True)
            self.google_client = None
    
    def get_google_authorize_redirect(self):
        """Google OAuth認証リダイレクトURLを取得"""
        if not self.google_client:
            raise Exception("Google OAuth is not configured")
        
        try:
            # コールバックURLを明示的に生成（再帰を避けるため）
            redirect_uri = url_for('google_callback', _external=True)
            logger.info(f"Google OAuth redirect URI: {redirect_uri}")
            return self.google_client.authorize_redirect(redirect_uri)
        except Exception as e:
            logger.error(f"Failed to create Google authorize redirect: {e}", exc_info=True)
            raise
    
    def handle_google_callback(self):
        """
        Google OAuthコールバック処理
        
        Returns:
            dict: ユーザー情報とトークン
        """
        if not self.google_client:
            raise Exception("Google OAuth is not configured")
        
        try:
            # トークン取得
            token = self.google_client.authorize_access_token()
            
            # ユーザー情報取得 - tokenオブジェクトから直接取得
            user_info = token.get('userinfo')
            
            # user_infoがない場合は、APIエンドポイントから取得
            if not user_info:
                logger.warning("userinfo not in token, fetching from API")
                resp = self.google_client.get('https://www.googleapis.com/oauth2/v3/userinfo')
                user_info = resp.json()
            
            if not user_info:
                logger.error(f"Failed to get user info. Token keys: {list(token.keys())}")
                raise Exception("Failed to get user info from Google")
            
            logger.info(f"Google user info retrieved: {user_info.get('email', 'unknown')}")
            
            # ユーザー情報を整形
            oauth_user = {
                'provider': 'google',
                'provider_user_id': user_info.get('sub'),
                'email': user_info.get('email'),
                'username': user_info.get('name', user_info.get('email', 'user').split('@')[0]),
                'avatar_url': user_info.get('picture'),
                'email_verified': user_info.get('email_verified', False)
            }
            
            # 必須フィールドのバリデーション
            if not oauth_user['provider_user_id'] or not oauth_user['email']:
                logger.error(f"Missing required fields in user_info: {user_info}")
                raise Exception("ユーザー情報に必須フィールドが不足しています")
            
            return self._process_oauth_user(oauth_user)
            
        except Exception as e:
            logger.error(f"Google OAuth callback error: {str(e)}", exc_info=True)
            raise
    
    def _process_oauth_user(self, oauth_user):
        """
        OAuth認証されたユーザーを処理（登録または既存ユーザー取得）
        
        Args:
            oauth_user: OAuth provider から取得したユーザー情報
            
        Returns:
            dict: JWTトークンとユーザー情報
        """
        # OAuth プロバイダーでユーザーを検索
        user = self.user_model.get_user_by_oauth(
            oauth_user['provider'],
            oauth_user['provider_user_id']
        )
        
        if user:
            # 既存ユーザーの場合、情報を更新
            logger.info(f"Existing OAuth user logged in: {oauth_user['email']}")
            user_id = user['id']
            
            # ユーザー情報を更新（アバターURLなど）
            self.user_model.update_oauth_user(
                user_id,
                oauth_user.get('avatar_url')
            )
        else:
            # 新規ユーザーの場合、登録
            logger.info(f"New OAuth user registered: {oauth_user['email']}")
            
            # メールアドレスで既存ユーザーをチェック
            existing_user = self.user_model.get_user_by_email(oauth_user['email'])
            
            if existing_user:
                # 既存のメールアドレスがある場合、OAuthアカウントをリンク
                user_id = existing_user['id']
                self.user_model.link_oauth_account(
                    user_id,
                    oauth_user['provider'],
                    oauth_user['provider_user_id'],
                    oauth_user.get('avatar_url')
                )
                logger.info(f"Linked OAuth account to existing user: {oauth_user['email']}")
            else:
                # 完全に新規のユーザー
                user_id = self.user_model.create_oauth_user(
                    username=oauth_user['username'],
                    email=oauth_user['email'],
                    provider=oauth_user['provider'],
                    provider_user_id=oauth_user['provider_user_id'],
                    avatar_url=oauth_user.get('avatar_url')
                )
            
            user = self.user_model.get_user_by_id(user_id)
        
        # JWTトークン生成
        access_token = self.auth_manager.generate_access_token(user['id'], user['email'])
        refresh_token = self.auth_manager.generate_refresh_token(user['id'])
        
        return {
            'access_token': access_token,
            'refresh_token': refresh_token,
            'token_type': 'Bearer',
            'user': {
                'id': user['id'],
                'username': user['username'],
                'email': user['email'],
                'avatar_url': user.get('avatar_url'),
                'provider': oauth_user['provider']
            }
        }
