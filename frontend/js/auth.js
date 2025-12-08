/**
 * 認証システム - フロントエンド
 */

class AuthService {
    constructor() {
        this.API_BASE = '/api/auth';
        this.tokens = this.loadTokens();
        
        // トークン自動更新を設定
        this.setupTokenRefresh();
    }
    
    /**
     * ローカルストレージからトークンを読み込み
     */
    loadTokens() {
        return {
            accessToken: localStorage.getItem('access_token'),
            refreshToken: localStorage.getItem('refresh_token')
        };
    }
    
    /**
     * トークンを保存
     */
    saveTokens(accessToken, refreshToken) {
        this.tokens.accessToken = accessToken;
        this.tokens.refreshToken = refreshToken;
        
        localStorage.setItem('access_token', accessToken);
        localStorage.setItem('refresh_token', refreshToken);
    }
    
    /**
     * トークンをクリア
     */
    clearTokens() {
        this.tokens = { accessToken: null, refreshToken: null };
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('user');
    }
    
    /**
     * ユーザー情報を保存
     */
    saveUser(user) {
        localStorage.setItem('user', JSON.stringify(user));
    }
    
    /**
     * ユーザー情報を取得
     */
    getUser() {
        const userStr = localStorage.getItem('user');
        return userStr ? JSON.parse(userStr) : null;
    }
    
    /**
     * ログイン状態チェック
     */
    isAuthenticated() {
        return !!this.tokens.accessToken;
    }
    
    /**
     * 新規登録
     */
    async register(username, email, password) {
        try {
            const response = await fetch(`${this.API_BASE}/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, email, password })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || '登録に失敗しました');
            }
            
            // トークンとユーザー情報を保存
            this.saveTokens(data.access_token, data.refresh_token);
            this.saveUser(data.user);
            
            return data;
            
        } catch (error) {
            console.error('Registration error:', error);
            throw error;
        }
    }
    
    /**
     * ログイン
     */
    async login(email, password) {
        try {
            const response = await fetch(`${this.API_BASE}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'ログインに失敗しました');
            }
            
            // トークンとユーザー情報を保存
            this.saveTokens(data.access_token, data.refresh_token);
            this.saveUser(data.user);
            
            return data;
            
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    }
    
    /**
     * ログアウト
     */
    async logout() {
        try {
            if (this.isAuthenticated()) {
                await fetch(`${this.API_BASE}/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.tokens.accessToken}`
                    }
                });
            }
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            this.clearTokens();
        }
    }
    
    /**
     * トークンリフレッシュ
     */
    async refreshToken() {
        try {
            if (!this.tokens.refreshToken) {
                throw new Error('Refresh token not found');
            }
            
            const response = await fetch(`${this.API_BASE}/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ refresh_token: this.tokens.refreshToken })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'トークン更新に失敗しました');
            }
            
            // 新しいアクセストークンを保存
            this.tokens.accessToken = data.access_token;
            localStorage.setItem('access_token', data.access_token);
            this.saveUser(data.user);
            
            return data.access_token;
            
        } catch (error) {
            console.error('Token refresh error:', error);
            // リフレッシュ失敗時はログアウト
            this.clearTokens();
            throw error;
        }
    }
    
    /**
     * トークン自動更新を設定（14分ごと）
     */
    setupTokenRefresh() {
        if (this.isAuthenticated()) {
            // 14分ごとにトークンを更新（有効期限15分より少し前）
            setInterval(() => {
                this.refreshToken().catch(err => {
                    console.error('Auto refresh failed:', err);
                });
            }, 14 * 60 * 1000);
        }
    }
    
    /**
     * APIリクエストヘッダーを取得
     */
    getAuthHeaders() {
        if (this.isAuthenticated()) {
            return {
                'Authorization': `Bearer ${this.tokens.accessToken}`,
                'Content-Type': 'application/json'
            };
        }
        return {
            'Content-Type': 'application/json'
        };
    }
}

// グローバルに公開
const authService = new AuthService();

// ログインページの処理 - ログインページでのみ実行
if (window.location.pathname.includes('/auth/login.html')) {
    document.addEventListener('DOMContentLoaded', () => {
        // 既にログイン済みの場合はメインページへリダイレクト
        if (authService.isAuthenticated()) {
            window.location.href = '/';
            return;
        }
        
        // タブ切り替え
        const tabs = document.querySelectorAll('.auth-tab');
        const forms = document.querySelectorAll('.auth-form');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                
                tabs.forEach(t => t.classList.remove('active'));
                forms.forEach(f => f.classList.remove('active'));
                
                tab.classList.add('active');
                document.getElementById(`${targetTab}Form`).classList.add('active');
                
                // メッセージをクリア
                hideMessage();
            });
        });
        
        // ログインフォーム送信
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                
                const email = document.getElementById('loginEmail').value;
                const password = document.getElementById('loginPassword').value;
                const submitBtn = e.target.querySelector('button[type="submit"]');
                
                try {
                    submitBtn.classList.add('loading');
                    submitBtn.disabled = true;
                    
                    await authService.login(email, password);
                    
                    showMessage('ログインに成功しました！', 'success');
                    
                    // 1秒後にメインページへ
                    setTimeout(() => {
                        window.location.href = '/';
                    }, 1000);
                    
                } catch (error) {
                    showMessage(error.message, 'error');
                } finally {
                    submitBtn.classList.remove('loading');
                    submitBtn.disabled = false;
                }
            });
        }
        
        // 登録フォーム送信
        const registerForm = document.getElementById('registerForm');
        if (registerForm) {
            registerForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                
                const username = document.getElementById('registerUsername').value;
                const email = document.getElementById('registerEmail').value;
                const password = document.getElementById('registerPassword').value;
                const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
                const submitBtn = e.target.querySelector('button[type="submit"]');
                
                // パスワード確認チェック
                if (password !== passwordConfirm) {
                    showMessage('パスワードが一致しません', 'error');
                    return;
                }
                
                try {
                    submitBtn.classList.add('loading');
                    submitBtn.disabled = true;
                    
                    await authService.register(username, email, password);
                    
                    showMessage('登録が完了しました！', 'success');
                    
                    // 1秒後にメインページへ
                    setTimeout(() => {
                        window.location.href = '/';
                    }, 1000);
                    
                } catch (error) {
                    showMessage(error.message, 'error');
                } finally {
                    submitBtn.classList.remove('loading');
                    submitBtn.disabled = false;
                }
            });
        }
        
        // ゲストリンク
        document.querySelectorAll('.guest-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = '/';
            });
        });
    });
}

/**
 * メッセージを表示
 */
function showMessage(text, type) {
    const messageEl = document.getElementById('authMessage');
    if (!messageEl) return;
    
    messageEl.textContent = text;
    messageEl.className = `auth-message show ${type}`;
    
    if (type === 'error') {
        messageEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${text}`;
    } else {
        messageEl.innerHTML = `<i class="fas fa-check-circle"></i> ${text}`;
    }
}

/**
 * メッセージを非表示
 */
function hideMessage() {
    const messageEl = document.getElementById('authMessage');
    if (!messageEl) return;
    
    messageEl.classList.remove('show');
}

// エクスポート
export { authService, AuthService };
