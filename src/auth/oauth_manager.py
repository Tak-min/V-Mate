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
        
        # GitHub OAuth設定
        self._setup_github_oauth()
    
    def _setup_google_oauth(self):
        """Google OAuth 2.0の設定"""
        google_client_id = os.getenv('GOOGLE_CLIENT_ID')
        google_client_secret = os.getenv('GOOGLE_CLIENT_SECRET')
        
        if not google_client_id or not google_client_secret:
            logger.warning("Google OAuth credentials not configured")
            self.google = None
            return
        
        self.google = self.oauth.register(
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
    
    def _setup_github_oauth(self):
        """GitHub OAuth 2.0の設定"""
        github_client_id = os.getenv('GITHUB_CLIENT_ID')
        github_client_secret = os.getenv('GITHUB_CLIENT_SECRET')
        
        if not github_client_id or not github_client_secret:
            logger.warning("GitHub OAuth credentials not configured")
            self.github = None
            return
        
        self.github = self.oauth.register(
            name='github',
            client_id=github_client_id,
            client_secret=github_client_secret,
            access_token_url='https://github.com/login/oauth/access_token',
            access_token_params=None,
            authorize_url='https://github.com/login/oauth/authorize',
            authorize_params=None,
            api_base_url='https://api.github.com/',
            client_kwargs={'scope': 'user:email'},
        )
        
        logger.info("GitHub OAuth configured successfully")
    
    def get_google_authorize_redirect(self):
        """Google OAuth認証リダイレクトURLを取得"""
        if not self.google:
            raise Exception("Google OAuth is not configured")
        
        redirect_uri = url_for('google_callback', _external=True)
        return self.google.authorize_redirect(redirect_uri)
    
    def get_github_authorize_redirect(self):
        """GitHub OAuth認証リダイレクトURLを取得"""
        if not self.github:
            raise Exception("GitHub OAuth is not configured")
        
        redirect_uri = url_for('github_callback', _external=True)
        return self.github.authorize_redirect(redirect_uri)
    
    def handle_google_callback(self):
        """
        Google OAuthコールバック処理
        
        Returns:
            dict: ユーザー情報とトークン
        """
        if not self.google:
            raise Exception("Google OAuth is not configured")
        
        # トークン取得
        token = self.google.authorize_access_token()
        
        # ユーザー情報取得
        user_info = token.get('userinfo')
        
        if not user_info:
            raise Exception("Failed to get user info from Google")
        
        # ユーザー情報を整形
        oauth_user = {
            'provider': 'google',
            'provider_user_id': user_info['sub'],
            'email': user_info['email'],
            'username': user_info.get('name', user_info['email'].split('@')[0]),
            'avatar_url': user_info.get('picture'),
            'email_verified': user_info.get('email_verified', False)
        }
        
        return self._process_oauth_user(oauth_user)
    
    def handle_github_callback(self):
        """
        GitHub OAuthコールバック処理
        
        Returns:
            dict: ユーザー情報とトークン
        """
        if not self.github:
            raise Exception("GitHub OAuth is not configured")
        
        # トークン取得
        token = self.github.authorize_access_token()
        
        # ユーザー情報取得
        resp = self.github.get('user', token=token)
        user_info = resp.json()
        
        # メールアドレス取得（プライベート設定の場合は別途取得が必要）
        email = user_info.get('email')
        if not email:
            # プライベートメールを取得
            emails_resp = self.github.get('user/emails', token=token)
            emails = emails_resp.json()
            # プライマリメールを探す
            for email_obj in emails:
                if email_obj.get('primary'):
                    email = email_obj['email']
                    break
            
            # プライマリがない場合は最初のメールを使用
            if not email and emails:
                email = emails[0]['email']
        
        if not email:
            raise Exception("Could not retrieve email from GitHub account")
        
        # ユーザー情報を整形
        oauth_user = {
            'provider': 'github',
            'provider_user_id': str(user_info['id']),
            'email': email,
            'username': user_info.get('login', email.split('@')[0]),
            'avatar_url': user_info.get('avatar_url'),
            'email_verified': True  # GitHubは検証済みメールのみ
        }
        
        return self._process_oauth_user(oauth_user)
    
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
