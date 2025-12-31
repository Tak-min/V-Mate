import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import { authService } from './auth.js';

/**
 * AI Wife - 3D Character Interaction App
 * メインアプリケーションクラス
 */
class AIWifeApp {
    constructor() {
        this.socket = null;
        this.sessionId = this.generateSessionId();
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        
        // 認証情報
        this.authService = authService;
        this.currentUser = authService.getUser();
        this.isAuthenticated = authService.isAuthenticated();
        
        // Three.js関連
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.css3dRenderer = null;
        this.css3dScene = null;
        this.controls = null;
        this.vrm = null;
        this.mixer = null;
        this.clock = new THREE.Clock();
        this.animations = new Map();
        this.currentEmotion = 'neutral';
        this.floor = null; // 足場
        this.backgroundMesh = null; // 背景メッシュ（180度）
        
        // 表情・ブリンク関連
        this.lastBlinkTime = 0;
        this.nextBlinkTime = 0;
        this.isBlinking = false;
        this.currentExpression = 'neutral';
        
        // リップシンク関連
        this.audioContext = null;
        this.audioAnalyser = null;
        this.audioSource = null;
        this.frequencyData = null;
        this.lipSyncWeight = 0.0;
        this.currentAudio = null;
        this.lipSyncSensitivity = 1.0; // 大きめの重みで視認性向上
        
        // 3D UI System
        this.glassPanel = null;
        this.speechBubble = null;
        this.isTyping = false;
        this.bubbleActive = false;
        
        // チャット履歴管理
        this.currentConversation = null;
        this.conversationMessages = [];
        
        // ストリーミング応答管理
        this.currentStreamingSession = null;
        this.audioChunkQueue = [];
        this.isPlayingAudio = false;
        this.audioPlaybackIndex = 0;
        this.receivedChunks = new Map(); // chunk_index -> chunk_data
        this.fullResponseText = '';
        
        // アニメーション状態管理
        this.currentAnimationType = null;
        this.idleTimer = null;
        this.idleTimeout = 10000; // 10秒後にアイドルアニメーションに復帰
        this.lastPlayedAnimation = null; // 前回再生したアニメーションを記録
        this.isSchedulingNextAnimation = false; // 次のアニメーション予約中フラグ
        
        // キャラクター初期化フラグ
        this.isCharacterInitialized = false;
        this.hasPlayedAppearing = false;
        this.isCharacterVisible = false;
        
        // UI要素
        this.elements = {
            hamburgerMenu: document.getElementById('hamburgerMenu'),
            sidebar: document.getElementById('sidebar'),
            closeSidebar: document.getElementById('closeSidebar'),
            chatHistoryMenu: document.getElementById('chatHistoryMenu'),
            chatHistorySidebar: document.getElementById('chatHistorySidebar'),
            closeChatHistory: document.getElementById('closeChatHistory'),
            historyList: document.getElementById('historyList'),
            historySearch: document.getElementById('historySearch'),
            clearHistory: document.getElementById('clearHistory'),
            mainContent: document.getElementById('mainContent'),
            characterContainer: document.getElementById('characterContainer'),
            connectionStatus: document.getElementById('connectionStatus'),
            characterMood: document.getElementById('characterMood'),
            loadingOverlay: document.getElementById('loadingOverlay'),
            errorToast: document.getElementById('errorToast'),
            errorMessage: document.getElementById('errorMessage')
        };
        
        // 設定
        this.settings = {
            character: 'Shiro.vrm', // デフォルトをShiroに変更
            voiceId: 'ocZQ262SsZb9RIxcQBOj', // Shiroの音声ID
            volume: 0.7,
            voiceSpeed: 1.0,
            personality: 'shiro', // デフォルトをshiroに変更
            memoryEnabled: true,
            background: 'sky.jpg', // デフォルト背景を空間に設定
            use3DUI: true // 3D UIモードを有効化
        };
        
        // キャラクター管理
        this.characters = [];
        this.currentCharacter = null;
        this.availableVoices = [];
        
        // デフォルトのShiroキャラクター（ハードコード）
        this.defaultShiroCharacter = {
            id: 'default-shiro',
            name: 'シロ',
            vrm_file: 'Shiro.vrm',
            voice_id: 'ocZQ262SsZb9RIxcQBOj',
            is_default: true,
            prompt: `<キャラクター設定>
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

返答は必ず英語で行ってください。ユーザーが日本語で話しかけても、必ず英語で応答してください。

上記のキャラクター設定を維持しながら、英語で自然に会話してください。
`
        };
        
        this.init();
    }
    
    /**
     * アプリケーションの初期化
     */
    async init() {
        try {
            console.log('[Debug] Starting AIWifeApp initialization...');
            
            console.log('[Debug] Step 1: Setting up event listeners...');
            this.setupEventListeners();
            
            console.log('[Debug] Step 2: Setting up auth UI...');
            this.setupAuthUI();  // 認証UIの設定
            
            console.log('[Debug] Step 3: Loading characters and voices...');
            await this.loadCharactersAndVoices(); // キャラクター一覧と音声一覧を取得
            
            console.log('[Debug] Step 4: Initializing WebSocket...');
            this.initWebSocket();
            
            console.log('[Debug] Step 5: Initializing 3D scene...');
            await this.init3DScene();
            
            console.log('[Debug] Step 6: Loading background...');
            await this.loadBackground();
            
            console.log('[Debug] Step 7: Loading character...');
            await this.loadCharacter();
            
            console.log('[Debug] Step 8: Loading settings...');
            this.loadSettings();
            
            console.log('[Debug] Step 9: Initializing blink timer...');
            this.initBlinkTimer(); // ブリンクタイマー初期化
            
            console.log('[Debug] Step 10: Starting render loop...');
            this.startRenderLoop();
            
            // 新しい会話セッションを開始
            console.log('[Debug] Step 11: Starting new conversation...');
            this.startNewConversation();
            
            console.log('[Success] AI Wife App initialized successfully');
            
            // 初期化完了後の処理を高速化（2秒 → 0.5秒）
            setTimeout(() => {
                // this.send3DMessage('初めまして!');
            }, 500);
        } catch (error) {
            console.error('[Error] Failed to initialize app:', error);
            console.error('[Error] Stack trace:', error.stack);
            this.showError('アプリケーションの初期化に失敗しました: ' + error.message);
        }
    }
    
    /**
     * ブリンクタイマーの初期化
     */
    initBlinkTimer() {
        this.lastBlinkTime = Date.now();
        this.scheduleNextBlink();
    }
    
    /**
     * 次のブリンクをスケジュール
     */
    scheduleNextBlink() {
        // 2-6秒のランダムな間隔でブリンク
        const interval = 2000 + Math.random() * 4000;
        this.nextBlinkTime = Date.now() + interval;
    }

    /**
     * セッションIDの生成
     */
    generateSessionId() {
        return 'session_' + Math.random().toString(36).substring(2, 15) + 
               Math.random().toString(36).substring(2, 15);
    }
    
    /**
     * イベントリスナーの設定
     */
    setupEventListeners() {
        // サイドバー制御
        this.elements.hamburgerMenu.addEventListener('click', () => this.toggleSidebar());
        this.elements.closeSidebar.addEventListener('click', () => this.closeSidebar());
        
        // チャット履歴関連のイベントリスナー
        this.elements.chatHistoryMenu.addEventListener('click', () => this.toggleChatHistory());
        this.elements.closeChatHistory.addEventListener('click', () => this.closeChatHistory());
        this.elements.clearHistory.addEventListener('click', () => this.clearChatHistory());
        this.elements.historySearch.addEventListener('input', (e) => this.searchChatHistory(e.target.value));
        
        // 設定変更
        document.getElementById('characterSelect').addEventListener('change', (e) => {
            // キャラクターIDを取得
            const characterId = parseInt(e.target.value);
            const character = this.characters.find(c => c.id === characterId);
            
            if (character) {
                this.currentCharacter = character;
                
                // 設定を更新
                this.settings.character = character.vrm_file;
                this.settings.personality = 'shiro'; // 全てshiro
                this.settings.voiceId = character.voice_id;
                
                // UIを更新
                this.updateCharacterUI(character);
                
                // キャラクターをロード
                this.loadCharacterWithAppearing();
                
                // 新しい会話セッションを開始
                this.startNewConversation();
            }
        });
        
        // キャラクター名保存
        document.getElementById('saveCharacterName').addEventListener('click', () => {
            this.saveCharacterName();
        });
        
        // プロンプト保存
        document.getElementById('saveCharacterPrompt').addEventListener('click', () => {
            this.saveCharacterPrompt();
        });
        
        // 音声ID保存
        document.getElementById('saveVoiceId').addEventListener('click', () => {
            this.saveVoiceId();
        });

        document.getElementById('backgroundSelect').addEventListener('change', (e) => {
            this.settings.background = e.target.value;
            this.loadBackground();
        });
        
        // ファイルアップロード機能
        document.getElementById('characterUpload').addEventListener('change', (e) => {
            this.handleCharacterUpload(e);
        });
        
        document.getElementById('backgroundUpload').addEventListener('change', (e) => {
            this.handleBackgroundUpload(e);
        });
        
        document.getElementById('volumeSlider').addEventListener('input', (e) => {
            this.settings.volume = e.target.value / 100;
            document.getElementById('volumeValue').textContent = e.target.value + '%';
        });
        
        document.getElementById('voiceSpeed').addEventListener('input', (e) => {
            this.settings.voiceSpeed = parseFloat(e.target.value);
            document.getElementById('voiceSpeedValue').textContent = e.target.value + 'x';
        });
        
        document.getElementById('resetMemory').addEventListener('click', () => {
            this.resetMemory();
        });
        
        // ウィンドウリサイズ
        window.addEventListener('resize', () => this.onWindowResize());
        
        // サイドバー外クリック
        document.addEventListener('click', (e) => {
            if (!this.elements.sidebar.contains(e.target) && 
                !this.elements.hamburgerMenu.contains(e.target) &&
                this.elements.sidebar.classList.contains('open')) {
                this.closeSidebar();
            }
            
            // チャット履歴サイドバー外クリック
            if (!this.elements.chatHistorySidebar.contains(e.target) && 
                !this.elements.chatHistoryMenu.contains(e.target) &&
                this.elements.chatHistorySidebar.classList.contains('open')) {
                this.closeChatHistory();
            }
            
            // 最初のクリックでAudioContextを初期化
            this.initAudioContext();
        });
        
        // AudioContext初期化のための任意のインタラクション
        document.addEventListener('keydown', () => this.initAudioContext());
    }
    
    /**
     * 認証UIのセットアップ
     */
    setupAuthUI() {
        const authButtonsContainer = document.getElementById('authButtons');
        
        if (this.isAuthenticated && this.currentUser) {
            // ログイン済みの場合
            authButtonsContainer.innerHTML = `
                <div class="user-info">
                    <i class="fas fa-user-circle"></i>
                    <span>${this.currentUser.username}</span>
                </div>
                <button class="btn-logout" id="logoutBtn">
                    <i class="fas fa-sign-out-alt"></i> ログアウト
                </button>
            `;
            
            // ログアウトボタンのイベント
            document.getElementById('logoutBtn').addEventListener('click', async () => {
                try {
                    await this.authService.logout();
                    window.location.href = '/auth/login.html';
                } catch (error) {
                    console.error('Logout error:', error);
                }
            });
        } else {
            // 未ログインの場合
            authButtonsContainer.innerHTML = `
                <button class="btn-login" id="loginBtn">
                    <i class="fas fa-sign-in-alt"></i> ログイン
                </button>
            `;
            
            // ログインボタンのイベント
            document.getElementById('loginBtn').addEventListener('click', () => {
                window.location.href = '/auth/login.html';
            });
        }
    }
    
    /**
     * キャラクター一覧と音声一覧を取得
     */
    async loadCharactersAndVoices() {
        try {
            // 音声一覧を取得
            const voicesResponse = await fetch('/api/voices');
            if (voicesResponse.ok) {
                const voicesData = await voicesResponse.json();
                this.availableVoices = voicesData.voices || [];
                console.log('[Debug] Loaded voices:', this.availableVoices.length);
            }
            
            // デフォルトのShiroキャラクターを最初に追加（必ず表示）
            this.characters = [this.defaultShiroCharacter];
            this.currentCharacter = this.defaultShiroCharacter;
            console.log('[Debug] Default Shiro character loaded');
            
            // 認証済みの場合、データベースから追加キャラクターを取得
            if (this.isAuthenticated) {
                try {
                    const token = this.authService.getAccessToken();
                    const charactersResponse = await fetch('/api/characters', {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });
                    
                    if (charactersResponse.ok) {
                        const charactersData = await charactersResponse.json();
                        const dbCharacters = charactersData.characters || [];
                        console.log('[Debug] Loaded DB characters:', dbCharacters.length);
                        
                        // データベースからのキャラクターを追加（Shiro以外）
                        // データベースにShiroがあれば、そのデータで上書き
                        const dbShiro = dbCharacters.find(c => c.vrm_file === 'Shiro.vrm');
                        if (dbShiro) {
                            this.characters[0] = dbShiro;
                            this.currentCharacter = dbShiro;
                            console.log('[Debug] Using Shiro from database');
                        }
                        
                        // その他のキャラクターを追加
                        const otherCharacters = dbCharacters.filter(c => c.vrm_file !== 'Shiro.vrm');
                        this.characters.push(...otherCharacters);
                        
                    } else if (charactersResponse.status === 401) {
                        console.warn('Token expired, using default Shiro only');
                    }
                } catch (dbError) {
                    console.warn('[Warning] Failed to load DB characters, using default Shiro:', dbError);
                }
            }
            
            // 設定を更新
            this.settings.character = this.currentCharacter.vrm_file;
            this.settings.voiceId = this.currentCharacter.voice_id;
            
            // UIを更新
            this.updateCharacterSelectUI();
            this.updateVoiceSelectUI();
            this.updateCharacterUI(this.currentCharacter);
            
            console.log('[Debug] Total characters loaded:', this.characters.length);
            
        } catch (error) {
            console.error('[Error] Failed to load characters and voices:', error);
            // エラーが発生してもデフォルトShiroは使える
            this.characters = [this.defaultShiroCharacter];
            this.currentCharacter = this.defaultShiroCharacter;
            this.updateCharacterSelectUI();
            this.updateCharacterUI(this.currentCharacter);
        }
    }
    
    /**
     * キャラクター選択UIを更新
     */
    updateCharacterSelectUI() {
        const characterSelect = document.getElementById('characterSelect');
        characterSelect.innerHTML = '';
        
        this.characters.forEach(character => {
            const option = document.createElement('option');
            option.value = character.id;
            option.textContent = character.name;
            if (this.currentCharacter && character.id === this.currentCharacter.id) {
                option.selected = true;
            }
            characterSelect.appendChild(option);
        });
    }
    
    /**
     * 音声選択UIを更新
     */
    updateVoiceSelectUI() {
        const voiceSelect = document.getElementById('voiceSelect');
        voiceSelect.innerHTML = '';
        
        this.availableVoices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.id;
            option.textContent = `${voice.name} (${voice.category})`;
            if (this.currentCharacter && voice.id === this.currentCharacter.voice_id) {
                option.selected = true;
            }
            voiceSelect.appendChild(option);
        });
    }
    
    /**
     * キャラクター情報UIを更新
     */
    updateCharacterUI(character) {
        console.log('[Debug] Updating character UI with:', character);
        
        const characterNameInput = document.getElementById('characterName');
        const characterPromptTextarea = document.getElementById('characterPrompt');
        const voiceSelect = document.getElementById('voiceSelect');
        
        if (characterNameInput) {
            characterNameInput.value = character.name || '';
        }
        
        if (characterPromptTextarea) {
            characterPromptTextarea.value = character.prompt || '';
        }
        
        if (voiceSelect && character.voice_id) {
            voiceSelect.value = character.voice_id;
        }
        
        console.log('[Debug] UI updated - Name:', character.name, 'Prompt length:', (character.prompt || '').length, 'Voice:', character.voice_id);
    }
    
    /**
     * キャラクター名を保存
     */
    async saveCharacterName() {
        if (!this.currentCharacter) return;
        
        const newName = document.getElementById('characterName').value.trim();
        if (!newName) {
            this.showError('キャラクター名を入力してください');
            return;
        }
        
        try {
            const token = this.authService.getAccessToken();
            const response = await fetch(`/api/characters/${this.currentCharacter.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ name: newName })
            });
            
            if (response.ok) {
                const data = await response.json();
                this.currentCharacter = data.character;
                this.updateCharacterSelectUI();
                this.showSuccess('キャラクター名を保存しました');
            } else {
                this.showError('保存に失敗しました');
            }
        } catch (error) {
            console.error('[Error] Failed to save character name:', error);
            this.showError('保存中にエラーが発生しました');
        }
    }
    
    /**
     * キャラクタープロンプトを保存
     */
    async saveCharacterPrompt() {
        if (!this.currentCharacter) return;
        
        const newPrompt = document.getElementById('characterPrompt').value.trim();
        if (!newPrompt) {
            this.showError('プロンプトを入力してください');
            return;
        }
        
        try {
            const token = this.authService.getAccessToken();
            const response = await fetch(`/api/characters/${this.currentCharacter.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ prompt: newPrompt })
            });
            
            if (response.ok) {
                const data = await response.json();
                this.currentCharacter = data.character;
                this.showSuccess('プロンプトを保存しました');
            } else {
                this.showError('保存に失敗しました');
            }
        } catch (error) {
            console.error('[Error] Failed to save character prompt:', error);
            this.showError('保存中にエラーが発生しました');
        }
    }
    
    /**
     * 音声IDを保存
     */
    async saveVoiceId() {
        if (!this.currentCharacter) return;
        
        const newVoiceId = document.getElementById('voiceSelect').value;
        if (!newVoiceId) {
            this.showError('音声を選択してください');
            return;
        }
        
        try {
            const token = this.authService.getAccessToken();
            const response = await fetch(`/api/characters/${this.currentCharacter.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ voice_id: newVoiceId })
            });
            
            if (response.ok) {
                const data = await response.json();
                this.currentCharacter = data.character;
                this.settings.voiceId = newVoiceId;
                this.showSuccess('音声を保存しました');
            } else {
                this.showError('保存に失敗しました');
            }
        } catch (error) {
            console.error('[Error] Failed to save voice ID:', error);
            this.showError('保存中にエラーが発生しました');
        }
    }
    
    /**
     * 成功メッセージを表示
     */
    showSuccess(message) {
        // 簡易的なトースト表示（既存のshowErrorと同様の実装）
        const toast = document.createElement('div');
        toast.className = 'success-toast';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #4CAF50;
            color: white;
            padding: 15px 20px;
            border-radius: 5px;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        `;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
        }, 3000);
    }
    
    /**
     * AudioContextの初期化（ユーザーインタラクション後）
     */
    initAudioContext() {
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log('AudioContext initialized for lip sync');
            } catch (error) {
                console.error('Failed to initialize AudioContext:', error);
            }
        }
    }
    
    /**
     * WebSocket接続の初期化
     */
    initWebSocket() {
        // 認証トークンを含めて接続
        const connectionOptions = {
            path: '/socket.io',
            reconnection: true, // 自動再接続を有効
            reconnectionDelay: 1000, // 再接続までの待機時間（ミリ秒）
            reconnectionAttempts: 5, // 最大再接続試行回数
            timeout: 20000 // 接続タイムアウト（ミリ秒）
        };
        
        // 認証済みの場合はトークンをクエリパラメータに追加
        if (this.isAuthenticated && this.authService.tokens.accessToken) {
            connectionOptions.query = {
                token: this.authService.tokens.accessToken
            };
        }
        
        console.log('[Debug] Initializing Socket.IO connection...', connectionOptions);
        this.socket = io(connectionOptions);
        
        this.socket.on('connect', () => {
            console.log('[Debug] Socket.IO connected successfully');
            this.updateConnectionStatus('connected');
        });
        
        this.socket.on('disconnect', (reason) => {
            console.log('[Debug] Socket.IO disconnected. Reason:', reason);
            this.updateConnectionStatus('disconnected');
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('[Error] Socket.IO connection error:', error);
        });
        
        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log('[Debug] Socket.IO reconnection attempt:', attemptNumber);
        });
        
        this.socket.on('reconnect_failed', () => {
            console.error('[Error] Socket.IO reconnection failed after maximum attempts');
            this.showError('サーバーへの接続に失敗しました。ページを再読み込みしてください。');
        });
        
        this.socket.on('connected', (data) => {
            console.log('[Debug] Server connected message received:', data.status);
            if (data.authenticated) {
                console.log('[Debug] Authenticated connection established');
            }
        });
        
        this.socket.on('message_response', (data) => {
            this.handleMessageResponse(data);
        });
        
        // ストリーミング対応イベントハンドラー
        this.socket.on('message_chunk', (data) => {
            console.log('[Debug] WebSocket received message_chunk event');
            this.handleMessageChunk(data);
        });
        
        this.socket.on('streaming_complete', (data) => {
            console.log('[Debug] WebSocket received streaming_complete event');
            this.handleStreamingComplete(data);
        });
        
        this.socket.on('audio_response', (data) => {
            this.handleAudioResponse(data);
        });
        
        this.socket.on('error', (data) => {
            this.showError(data.message);
            this.hideLoading();
        });
    }
    
    /**
     * 3Dシーンの初期化
     */
    async init3DScene() {
        // レンダラー
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.domElement.style.position = 'absolute';
        this.renderer.domElement.style.zIndex = '0'; // 背景レイヤー
        this.elements.characterContainer.appendChild(this.renderer.domElement);
        
        // CSS3DRenderer for UI elements
        this.css3dRenderer = new CSS3DRenderer();
        this.css3dRenderer.setSize(window.innerWidth, window.innerHeight);
        this.css3dRenderer.domElement.style.position = 'absolute';
        this.css3dRenderer.domElement.style.top = '0';
        this.css3dRenderer.domElement.style.left = '0';
        this.css3dRenderer.domElement.style.pointerEvents = 'none';
        this.css3dRenderer.domElement.style.background = 'transparent'; // 透明背景に設定
        this.css3dRenderer.domElement.style.zIndex = '1'; // WebGLRendererより前面に
        this.css3dRenderer.domElement.className = 'css3d-container';
        this.elements.characterContainer.appendChild(this.css3dRenderer.domElement);
        
        // CSS3D Scene
        this.css3dScene = new THREE.Scene();
        
        // カメラ
        this.camera = new THREE.PerspectiveCamera(30.0, window.innerWidth / window.innerHeight, 0.1, 20.0);
        this.camera.position.set(0.0, 0.9, -3.5); // Y座標を下げて下から見上げる角度に
        
        // カメラコントロール
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.screenSpacePanning = true;
        this.controls.target.set(0.0, 0.9, 0.0); // ターゲットも少し下げて水平に近い角度に
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.enableRotate = false; // 回転を無効化
        this.controls.enableZoom = false; // ズームを無効化
        this.controls.enablePan = false; // パンを無効化
        this.controls.update();
        
        // シーン
        this.scene = new THREE.Scene();
        this.scene.background = null; // 透明背景
        
        // ライティング
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
        this.scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 3.0);
        directionalLight.position.set(1.0, 1.0, 1.0);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(directionalLight);
        
        // 追加のライト
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        fillLight.position.set(-1.0, 0.5, -1.0);
        this.scene.add(fillLight);
        
        // 足場（フロア）の作成
        this.createFloor();
        
        // 3D UI System 初期化
        if (this.settings.use3DUI) {
            this.init3DUISystem();
        }
    }
    
    /**
     * 足場（フロア）の作成
     */
    createFloor() {
        // 大きな平面ジオメトリを作成（x-z平面）
        const floorGeometry = new THREE.PlaneGeometry(100, 5); // 1000x1000の巨大なフロア
        
        // 半透明のマテリアル
        const floorMaterial = new THREE.MeshLambertMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide
        });
        
        // フロアメッシュを作成
        this.floor = new THREE.Mesh(floorGeometry, floorMaterial);
        
        // 平面をx-z平面に配置（Y軸で-90度回転）
        this.floor.rotation.x = -Math.PI / 2;
        this.floor.position.y = 0; // 地面の高さ
        
        // 影を受ける設定
        this.floor.receiveShadow = true;
        
        // シーンに追加
        this.scene.add(this.floor);
        
        console.log('Floor created');
    }

    /**
     * 3D UIシステムの初期化
     */
    init3DUISystem() {
        // ガラスパネルの作成
        this.createGlassPanel();
        
        // メッセージ入力パネルの作成
        this.createMessageInputPanel();
        
        // AR吹き出しの作成
        this.createARSpeechBubble();
        
        // 3D UIモードのスタイルを適用
        document.body.classList.add('ui-3d-mode');
        
        console.log('3D UI System initialized');
    }
    
    /**
     * ガラスパネルの作成
     */
    createGlassPanel() {
        // HTML要素の作成
        const panelElement = document.createElement('div');
        panelElement.className = 'glass-panel';
        panelElement.innerHTML = `
            <div class="glass-panel-icon">
                <i class="fas fa-comments"></i>
            </div>
            <div class="glass-panel-text">
                メッセージを送信
            </div>
            <div class="glass-panel-subtext">
                クリックして会話を始める
            </div>
        `;
        
        // CSS3Dオブジェクトとして3D空間に配置
        this.glassPanel = new CSS3DObject(panelElement);
        this.glassPanel.position.set(0.5, 1.0, -0.2); // ユーザーから見て左側に配置
        this.glassPanel.rotation.y = Math.PI + Math.PI * 0.08; // 左側なので回転を調整
        this.glassPanel.scale.set(0.002, 0.002, 0.002); // サイズを大幅に縮小
        this.css3dScene.add(this.glassPanel);
        
        // クリックイベントの設定
        panelElement.style.pointerEvents = 'auto';
        panelElement.addEventListener('click', (e) => {
            this.handleGlassPanelClick(e);
        });
        
        // ホバーアニメーション用のアイドル状態
        this.startGlassPanelAnimation();
    }
    
    /**
     * メッセージ入力パネルの作成
     */
    createMessageInputPanel() {
        const panelElement = document.createElement('div');
        panelElement.className = 'message-input-panel';
        panelElement.innerHTML = `
            <div class="message-input-panel-header">
                <div class="message-input-panel-title">
                    <i class="fas fa-comment-dots"></i> メッセージを入力
                </div>
                <button class="message-input-panel-close">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <textarea class="message-input-textarea" placeholder="ここにメッセージを入力してください..."></textarea>
            <div class="message-input-actions">
                <button class="message-input-btn">キャンセル</button>
                <button class="message-input-btn primary">送信</button>
            </div>
        `;
        
        // CSS3Dオブジェクトとして3D空間に配置（ガラスパネルの下）
        this.messageInputPanel3D = new CSS3DObject(panelElement);
        this.messageInputPanel3D.position.set(0.5, 0.5, -0.2); // ガラスパネルの下
        this.messageInputPanel3D.rotation.y = Math.PI + Math.PI * 0.08;
        this.messageInputPanel3D.scale.set(0.0015, 0.0015, 0.0015);
        this.css3dScene.add(this.messageInputPanel3D);
        
        // イベントリスナーの設定
        panelElement.style.pointerEvents = 'auto';
        
        // 閉じるボタン
        const closeBtn = panelElement.querySelector('.message-input-panel-close');
        closeBtn.addEventListener('click', () => {
            this.hideMessageInputPanel();
        });
        
        // キャンセルボタン
        const cancelBtn = panelElement.querySelector('.message-input-btn:not(.primary)');
        cancelBtn.addEventListener('click', () => {
            this.hideMessageInputPanel();
        });
        
        // 送信ボタン
        const sendBtn = panelElement.querySelector('.message-input-btn.primary');
        sendBtn.addEventListener('click', () => {
            this.sendMessageFromPanel();
        });
        
        // Enterキーで送信（Shift+Enterで改行）
        const textarea = panelElement.querySelector('.message-input-textarea');
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessageFromPanel();
            }
        });
    }
    
    /**
     * AR吹き出しの作成
     */
    createARSpeechBubble() {
        this.speechBubble = document.createElement('div');
        this.speechBubble.className = 'ar-speech-bubble';
        this.speechBubble.innerHTML = `
            <div class="ar-speech-bubble-text"></div>
        `;
        document.body.appendChild(this.speechBubble);
    }
    
    /**
     * ガラスパネルのアイドルアニメーション
     */
    startGlassPanelAnimation() {
        const animatePanel = () => {
            if (this.glassPanel) {
                const time = Date.now() * 0.001;
                this.glassPanel.position.y = 1.0 + Math.sin(time * 0.5) * 0.03; // ユーザーの設定Y=1.0を基準に
                this.glassPanel.rotation.y = Math.PI + Math.PI * 0.08 + Math.sin(time * 0.3) * 0.015; // ユーザーの回転設定に合わせる
            }
            requestAnimationFrame(animatePanel);
        };
        animatePanel();
    }
    
    /**
     * ガラスパネルクリック処理
     */
    async handleGlassPanelClick(event) {
        if (this.isTyping) return;
        
        // タッチフィードバック
        event.target.style.transform = 'scale(0.95)';
        setTimeout(() => {
            event.target.style.transform = '';
        }, 150);
        
        // メッセージ入力パネルを表示
        this.showMessageInputPanel();
    }
    
    /**
     * メッセージ入力パネルを表示
     */
    showMessageInputPanel() {
        const panel = this.messageInputPanel3D;
        if (panel) {
            const panelElement = panel.element;
            panelElement.classList.add('show');
            
            // テキストエリアにフォーカス
            const textarea = panelElement.querySelector('.message-input-textarea');
            setTimeout(() => textarea.focus(), 100);
        }
    }
    
    /**
     * メッセージ入力パネルを非表示
     */
    hideMessageInputPanel() {
        const panel = this.messageInputPanel3D;
        if (panel) {
            const panelElement = panel.element;
            panelElement.classList.remove('show');
            
            // テキストエリアをクリア
            const textarea = panelElement.querySelector('.message-input-textarea');
            textarea.value = '';
        }
    }
    
    /**
     * メッセージ入力パネルから送信
     */
    sendMessageFromPanel() {
        const panel = this.messageInputPanel3D;
        if (panel) {
            const textarea = panel.element.querySelector('.message-input-textarea');
            const message = textarea.value.trim();
            
            if (message) {
                this.send3DMessage(message);
                this.hideMessageInputPanel();
            }
        }
    }
    
    /**
     * 3D UIを使用したメッセージ送信
     */
    send3DMessage(message) {
        console.log('Sending 3D message:', message);
        console.log('Character personality:', this.settings.personality);
        
        // ユーザーがメッセージを送信した際はアイドルアニメーションを再生
        this.playAnimation('idle', { loop: true });
        
        this.showLoading();
        
        // ユーザーメッセージを会話履歴に追加
        this.addMessageToConversation('user', message);
        
        // メッセージデータの構築
        const messageData = {
            session_id: this.sessionId,
            message: message,
            voice_id: this.settings.voiceId,
            personality: this.settings.personality
        };
        
        // 認証済みの場合はuser_idを追加
        if (this.isAuthenticated && this.currentUser) {
            messageData.user_id = this.currentUser.id;
        }
        
        this.socket.emit('send_message', messageData);
    }
    
    /**
     * ストリーミングセッションを初期化
     */
    initializeStreamingSession(message) {
        this.currentStreamingSession = {
            startTime: Date.now(),
            message: message,
            expectedChunks: 0
        };
        
        // 前回のデータをクリア
        this.audioChunkQueue = [];
        this.isPlayingAudio = false;
        this.audioPlaybackIndex = 0;
        this.receivedChunks.clear();
        this.fullResponseText = '';
        
        console.log('[Debug] Streaming session initialized');
    }
    
    /**
     * キャラクターの頭部位置を取得
     */
    getCharacterHeadPosition() {
        if (!this.vrm) return null;
        
        // VRMキャラクターの頭部ボーンを取得
        const headBone = this.vrm.humanoid?.getBoneNode('head');
        if (!headBone) return null;
        
        const headPosition = new THREE.Vector3();
        headBone.getWorldPosition(headPosition);
        
        // 少し上に調整（吹き出し用）
        headPosition.y += 0.3;
        
        return headPosition;
    }
    
    /**
     * 3D座標をスクリーン座標に変換
     */
    worldToScreen(position) {
        if (!position || !this.camera) return { x: 0, y: 0 };
        
        const vector = position.clone();
        vector.project(this.camera);
        
        return {
            x: (vector.x * 0.5 + 0.5) * window.innerWidth,
            y: -(vector.y * 0.5 - 0.5) * window.innerHeight
        };
    }
    
    /**
     * AR吹き出しを表示
     */
    showARSpeechBubble(text) {
        if (!this.speechBubble) return;
        
        const headPosition = this.getCharacterHeadPosition();
        if (!headPosition) return;
        
        const screenPos = this.worldToScreen(headPosition);
        
        // 吹き出しの位置を設定
        this.speechBubble.style.left = `${screenPos.x}px`;
        this.speechBubble.style.top = `${screenPos.y - 60}px`;
        this.speechBubble.style.transform = 'translateX(-50%)';
        
        // テキストをタイピング効果で表示
        this.typeText(text);
    }
    
    /**
     * タイピング効果でテキストを表示（高速化版）
     */
    async typeText(text) {
        if (!this.speechBubble) return;
        
        this.isTyping = true;
        this.bubbleActive = true;
        
        const textElement = this.speechBubble.querySelector('.ar-speech-bubble-text');
        textElement.innerHTML = '<span class="typing-indicator"></span>';
        
        // 吹き出しを表示
        this.speechBubble.classList.add('show');
        
        // タイピング開始前の待機時間を短縮（300ms → 100ms）
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // タイピング効果（高速化：50ms → 20ms）
        textElement.innerHTML = '';
        for (let i = 0; i <= text.length; i++) {
            textElement.textContent = text.substring(0, i);
            await new Promise(resolve => setTimeout(resolve, 20)); // 高速化
        }
        
        this.isTyping = false;
        
        // 自動非表示時間を短縮（5秒 → 3秒）
        setTimeout(() => {
            this.hideARSpeechBubble();
        }, 3000);
    }
    
    /**
     * AR吹き出しを隠す
     */
    hideARSpeechBubble() {
        if (this.speechBubble) {
            this.speechBubble.classList.remove('show');
            this.bubbleActive = false;
        }
    }
    
    /**
     * 背景の読み込み
     */
    async loadBackground() {
        try {
            // 既存の背景オブジェクトを削除
            if (this.backgroundMesh) {
                this.scene.remove(this.backgroundMesh);
                this.backgroundMesh = null;
            }
            
            if (this.settings.background === 'none') {
                this.scene.background = null;
                return;
            }
            
            let textureUrl;
            
            // カスタムファイルかどうかを確認
            const backgroundSelect = document.getElementById('backgroundSelect');
            const selectedOption = backgroundSelect.querySelector(`option[value="${this.settings.background}"]`);
            
            if (selectedOption && selectedOption.dataset.localUrl) {
                // カスタムアップロードファイルの場合
                textureUrl = selectedOption.dataset.localUrl;
            } else {
                // デフォルトファイルの場合
                textureUrl = `/backgrounds/${this.settings.background}`;
            }
            
            const loader = new THREE.TextureLoader();
            const texture = await loader.loadAsync(textureUrl);
            
            // テクスチャの設定
            texture.mapping = THREE.EquirectangularReflectionMapping;
            texture.encoding = THREE.sRGBEncoding;
            
            // 前方90度x90度の球体を作成（内側から見る）
            const geometry = new THREE.SphereGeometry(
                10, // 半径を大幅に拡大
                64,  // 横の分割数
                32,  // 縦の分割数
                Math.PI/4,   // 水平方向の開始角度（-45度から開始）
                Math.PI/2,   // 水平方向の角度範囲（90度）
                Math.PI/6,   // 垂直方向の開始角度（上45度から開始）
                Math.PI/2    // 垂直方向の角度範囲（90度）
            );
            
            const material = new THREE.MeshBasicMaterial({ 
                map: texture, 
                side: THREE.BackSide, // 内側から見えるように
                depthWrite: false, // 深度バッファへの書き込みを無効化
                depthTest: false   // 深度テストを無効化
            });
            
            this.backgroundMesh = new THREE.Mesh(geometry, material);
            this.backgroundMesh.position.set(0, 1.5, 0);
            this.backgroundMesh.renderOrder = -1; // 最背面に描画
            
            this.scene.add(this.backgroundMesh);
            
            // scene.backgroundはクリア
            this.scene.background = null;
            
            console.log('Background loaded (180-degree):', this.settings.background);
            
        } catch (error) {
            console.error('Failed to load background:', error);
            this.scene.background = null;
        }
    }
    
    /**
     * キャラクターの読み込み
     */
    async loadCharacter() {
        try {
            this.showLoading();
            
            // 既存のVRMを削除
            if (this.vrm) {
                this.scene.remove(this.vrm.scene);
                this.vrm = null;
            }
            
            if (this.mixer) {
                this.mixer = null;
            }
            
            // GLTFローダーの設定
            const loader = new GLTFLoader();
            loader.crossOrigin = 'anonymous';
            
            loader.register((parser) => new VRMLoaderPlugin(parser));
            loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
            
            // VRMファイルの読み込み
            let modelUrl;
            
            // カスタムファイルかどうかを確認
            const characterSelect = document.getElementById('characterSelect');
            const selectedOption = characterSelect.querySelector(`option[value="${this.settings.character}"]`);
            
            if (selectedOption && selectedOption.dataset.localUrl) {
                // カスタムアップロードファイルの場合
                modelUrl = selectedOption.dataset.localUrl;
            } else {
                // デフォルトファイルの場合
                modelUrl = `./models/models/${this.settings.character}`;
            }
            
            const gltfVrm = await loader.loadAsync(modelUrl);
            this.vrm = gltfVrm.userData.vrm;
            
            // パフォーマンス最適化
            VRMUtils.removeUnnecessaryVertices(this.vrm.scene);
            VRMUtils.removeUnnecessaryJoints(this.vrm.scene);
            
            // フラスタムカリングを無効化
            this.vrm.scene.traverse((obj) => {
                obj.frustumCulled = false;
                obj.castShadow = true;
                obj.receiveShadow = true;
            });
            
            // LookAtクォータニオンプロキシを追加
            const lookAtQuatProxy = new VRMLookAtQuaternionProxy(this.vrm.lookAt);
            lookAtQuatProxy.name = 'lookAtQuaternionProxy';
            this.vrm.scene.add(lookAtQuatProxy);
            
            // haruka.vrmの場合は180度回転させる
            if (this.settings.character === 'haruka.vrm') {
                this.vrm.scene.rotation.y = Math.PI; // 180度回転
                console.log('Haruka model rotated 180 degrees');
            } else {
                this.vrm.scene.rotation.y = 0; // 他のモデルは回転なし
            }
            
            // シーンに追加（初期は非表示）
            this.scene.add(this.vrm.scene);
            this.vrm.scene.visible = false;
            this.isCharacterVisible = false;
            
            // アニメーションミキサーを作成
            this.mixer = new THREE.AnimationMixer(this.vrm.scene);
            
            // T-poseを回避するため、デフォルトポーズを設定
            if (this.vrm.humanoid) {
                this.vrm.humanoid.resetNormalizedPose();
                console.log('VRM normalized pose reset completed');
            }
            
            // 初期登場アニメーションを再生
            this.playAppearingAnimation();
            
            this.hideLoading();
            console.log('Character loaded successfully:', this.vrm);
            
        } catch (error) {
            console.error('Failed to load character:', error);
            this.showError('キャラクターの読み込みに失敗しました');
            this.hideLoading();
        }
    }
    
    /**
     * キャラクター変更時にappearing.vrmaアニメーションと共にロードする
     */
    async loadCharacterWithAppearing() {
        try {
            this.showLoading();
            
            // アニメーション関連のフラグをリセット（キャラクター切り替え用）
            this.hasPlayedAppearing = false;
            this.isCharacterInitialized = false;
            this.isCharacterVisible = false;
            
            // キャラクターを非表示にしてからロード
            if (this.vrm) {
                this.vrm.scene.visible = false;
                this.isCharacterVisible = false;
            }
            
            // 既存のVRMを削除
            if (this.vrm) {
                this.scene.remove(this.vrm.scene);
                this.vrm = null;
            }
            
            if (this.mixer) {
                this.mixer = null;
            }
            
            // GLTFローダーの設定
            const loader = new GLTFLoader();
            loader.crossOrigin = 'anonymous';
            
            loader.register((parser) => new VRMLoaderPlugin(parser));
            loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
            
            // VRMファイルの読み込み
            let modelUrl;
            
            // カスタムファイルかどうかを確認
            const characterSelect = document.getElementById('characterSelect');
            const selectedOption = characterSelect.querySelector(`option[value="${this.settings.character}"]`);
            
            if (selectedOption && selectedOption.dataset.localUrl) {
                // カスタムアップロードファイルの場合
                modelUrl = selectedOption.dataset.localUrl;
            } else {
                // デフォルトファイルの場合
                modelUrl = `./models/models/${this.settings.character}`;
            }
            
            const gltfVrm = await loader.loadAsync(modelUrl);
            this.vrm = gltfVrm.userData.vrm;
            
            // パフォーマンス最適化
            VRMUtils.removeUnnecessaryVertices(this.vrm.scene);
            VRMUtils.removeUnnecessaryJoints(this.vrm.scene);
            
            // フラスタムカリングを無効化
            this.vrm.scene.traverse((obj) => {
                obj.frustumCulled = false;
                obj.castShadow = true;
                obj.receiveShadow = true;
            });
            
            // LookAtクォータニオンプロキシを追加
            const lookAtQuatProxy = new VRMLookAtQuaternionProxy(this.vrm.lookAt);
            lookAtQuatProxy.name = 'lookAtQuaternionProxy';
            this.vrm.scene.add(lookAtQuatProxy);
            
            // haruka.vrmの場合は180度回転させる
            if (this.settings.character === 'haruka.vrm') {
                this.vrm.scene.rotation.y = Math.PI; // 180度回転
                console.log('Haruka model rotated 180 degrees');
            } else {
                this.vrm.scene.rotation.y = 0; // 他のモデルは回転なし
            }
            
            // シーンに追加（初期は非表示）
            this.scene.add(this.vrm.scene);
            this.vrm.scene.visible = false;
            this.isCharacterVisible = false;
            
            // アニメーションミキサーを作成
            this.mixer = new THREE.AnimationMixer(this.vrm.scene);
            
            // T-poseを回避するため、デフォルトポーズを設定
            if (this.vrm.humanoid) {
                this.vrm.humanoid.resetNormalizedPose();
                console.log('VRM normalized pose reset completed');
            }
            
            // 登場アニメーションを再生（キャラクター変更時）
            this.playAppearingAnimation();
            
            this.hideLoading();
            console.log('Character loaded successfully with appearing animation:', this.vrm);
            
        } catch (error) {
            console.error('Failed to load character with appearing:', error);
            this.showError('キャラクターの読み込みに失敗しました');
            this.hideLoading();
        }
    }
    
    /**
     * glTFアニメーション（VRMA形式）の読み込み
     */
    async loadGLTFAnimation(animationPath, options = {}) {
        try {
            if (!this.vrm || !this.mixer) return null;
            
            const loader = new GLTFLoader();
            // VRMAnimationLoaderPluginを使用してVRMA形式を読み込み
            loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
            
            // ファイル存在チェック（フェッチで確認）
            try {
                const response = await fetch(animationPath, { method: 'HEAD' });
                if (!response.ok) {
                    console.warn(`Animation file not found: ${animationPath}`);
                    return null;
                }
            } catch (fetchError) {
                console.warn(`Failed to check animation file: ${animationPath}`, fetchError);
                return null;
            }
            
            // glTFファイルの読み込み（VRMA拡張付き）
            const gltf = await loader.loadAsync(animationPath);
            
            // VRMAアニメーションデータを取得
            const vrmAnimation = gltf.userData.vrmAnimations?.[0];
            if (!vrmAnimation) {
                console.warn('No VRM animations found in glTF file:', animationPath);
                return null;
            }
            
            // VRMアニメーションクリップを作成
            const clip = createVRMAnimationClip(vrmAnimation, this.vrm);
            
            // アニメーションアクションを作成
            const action = this.mixer.clipAction(clip);
            
            // オプション設定
            if (options.loop !== undefined) {
                action.setLoop(options.loop ? THREE.LoopRepeat : THREE.LoopOnce);
            }
            if (options.weight !== undefined) {
                action.setEffectiveWeight(options.weight);
            }
            
            return {
                action: action,
                clip: clip,
                duration: clip.duration
            };
            
        } catch (error) {
            console.error('Failed to load glTF animation:', error);
            console.warn(`Skipping animation: ${animationPath}`);
            return null;
        }
    }

    /**
     * アニメーション再生
     */
    async playAnimation(animationType, options = {}) {
        if (!this.vrm || !this.mixer) return;

        // アニメーション種別に応じてパスを決定
        let animationPath;
        let isIdleType = false;

        switch (animationType) {
            case 'talking':
            case 'idle':
                animationPath = await this.getRandomIdleAnimation();
                isIdleType = true;
                break;
            default:
                // カスタムパスが指定された場合
                animationPath = animationType;
        }

        if (!animationPath) return;

        // アニメーション状態を更新
        this.updateAnimationState(isIdleType ? 'idle' : animationType);

        // 新しいアニメーションを読み込み
        const animationData = await this.loadGLTFAnimation(animationPath, options);
        if (!animationData) {
            // アニメーションの読み込みに失敗した場合のフォールバック
            console.warn(`Animation failed to load, trying basic idle: ${animationPath}`);
            
            // lying-sequenceが失敗した場合は通常のアイドルアニメーションのみを試行
            const basicIdleAnimations = [
                './models/animation/appearing.vrma',
                './models/animation/liked.vrma',
                './models/animation/waiting.vrma'
            ];
            
            const fallbackAnimation = basicIdleAnimations[Math.floor(Math.random() * basicIdleAnimations.length)];
            const fallbackData = await this.loadGLTFAnimation(fallbackAnimation, options);
            
            if (!fallbackData) {
                console.error('Critical: No animations could be loaded');
                return;
            }
            
            // フォールバックアニメーションを使用
            this.playAnimationDirect(fallbackData, options, true);
            return;
        }

        // 正常なアニメーション再生
        this.playAnimationDirect(animationData, options, isIdleType);
    }

    /**
     * アニメーションを直接再生する共通関数
     */
    playAnimationDirect(animationData, options = {}, isIdleType = false) {
        if (!animationData || !this.mixer) return;

        // 現在再生中のアクションを取得
        const currentActions = this.mixer._actions.filter(action => action.isRunning());
        
        // 新しいアニメーションの設定
        const newAction = animationData.action;
        newAction.reset();
        
        if (!options.loop) {
            newAction.setLoop(THREE.LoopOnce);
            newAction.clampWhenFinished = true;
        } else if (isIdleType) {
            // アイドルアニメーションは一回だけ再生して次に移行
            newAction.setLoop(THREE.LoopOnce);
            newAction.clampWhenFinished = true;
        }

        // スムーズな切り替えのためのクロスフェード
        if (currentActions.length > 0) {
            // 現在のアニメーションから新しいアニメーションにクロスフェード
            const fadeTime = 0.2; // 0.2秒でフェード
            
            currentActions.forEach(currentAction => {
                currentAction.crossFadeTo(newAction, fadeTime, false);
            });
            
            newAction.play();
        } else {
            // 最初のアニメーションまたは緊急時の直接再生
            this.mixer.stopAllAction();
            newAction.play();
        }

        console.log('Playing animation:', animationData.clip.name || 'Unknown animation');

        // アニメーション終了時の処理を統一
        const onFinished = () => {
            this.mixer.removeEventListener('finished', onFinished);
            
            if (options.onFinished) {
                options.onFinished();
                return; // カスタムコールバックがある場合はそれを優先
            }
            
            // アイドルアニメーションの場合は、少し待ってから次のアニメーションを再生
            if (isIdleType) {
                setTimeout(() => {
                    this.scheduleNextIdleAnimation();
                }, 1000); // 1秒の間隔を設ける
            } else if (!options.loop) {
                // 非ループアニメーションの場合、アイドルアニメーションに戻る
                setTimeout(() => {
                    this.playAnimation('idle', { loop: true });
                }, 500);
            }
        };

        this.mixer.addEventListener('finished', onFinished);
    }

    /**
     * ランダムアイドルアニメーション選択
     */
    async getRandomIdleAnimation() {
        // 全てのアニメーションファイルを含むアイドルローテーション
        const idleAnimations = [
            // トップレベルのVRMAファイル
            './models/animation/liked.vrma',
            './models/animation/waiting.vrma',
            
            // idleフォルダ内のVRMAファイル
            './models/animation/idle2.vrma',
            './models/animation/idle3.vrma', 
            './models/animation/idle4.vrma',
            
            // より多様性を持たせるため、一部を複数回含める
            './models/animation/liked.vrma',
            './models/animation/waiting.vrma',
            './models/animation/idle2.vrma',
            './models/animation/idle3.vrma'
        ];
        
        // 前回と同じアニメーションを避ける
        let availableAnimations = idleAnimations;
        if (this.lastPlayedAnimation) {
            availableAnimations = idleAnimations.filter(anim => anim !== this.lastPlayedAnimation);
            
            // もし前回のアニメーションを除外すると候補がなくなる場合、全候補を使用
            if (availableAnimations.length === 0) {
                availableAnimations = idleAnimations;
            }
        }
        
        // ランダム選択
        const randomIndex = Math.floor(Math.random() * availableAnimations.length);
        const selectedAnimation = availableAnimations[randomIndex];
        
        // 選択したアニメーションを記録
        this.lastPlayedAnimation = selectedAnimation;
        
        return selectedAnimation;
    }

    /**
     * 次のアイドルアニメーションをスケジュール
     */
    async scheduleNextIdleAnimation() {
        if (this.isSchedulingNextAnimation) {
            console.log('Already scheduling next animation, skipping...');
            return;
        }
        
        this.isSchedulingNextAnimation = true;
        
        try {
            console.log('Scheduling next idle animation...');
            await this.playAnimation('idle', { loop: true });
        } catch (error) {
            console.error('Error scheduling next animation:', error);
        } finally {
            this.isSchedulingNextAnimation = false;
        }
    }

    /**
     * 初期登場アニメーション（appearing）を再生
     */
    async playAppearingAnimation() {
        console.log(`[Debug] playAppearingAnimation called - hasPlayedAppearing: ${this.hasPlayedAppearing}, vrm: ${!!this.vrm}, mixer: ${!!this.mixer}`);
        
        if (this.hasPlayedAppearing || !this.vrm || !this.mixer) {
            console.log('[Debug] Skipping appearing animation due to conditions');
            return;
        }
        
        console.log('Playing appearing animation...');
        
        // appearing アニメーションを読み込み
        const animationData = await this.loadGLTFAnimation('./models/animation/appearing.vrma', { loop: false });
        if (!animationData) {
            console.error('Failed to load appearing animation');
            // フォールバック: キャラクターを表示してアイドルアニメーションを開始
            this.showCharacterAndStartIdle();
            return;
        }
        
        // アニメーション設定
        const action = animationData.action;
        action.reset();
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;
        
        // キャラクターを表示してアニメーション開始
        this.vrm.scene.visible = true;
        this.isCharacterVisible = true;
        action.play();
        
        console.log('Appearing animation started, character is now visible');
        
        // アニメーション終了時の処理
        const onAppearingFinished = () => {
            this.mixer.removeEventListener('finished', onAppearingFinished);
            this.hasPlayedAppearing = true;
            this.isCharacterInitialized = true;
            console.log('Appearing animation completed');
            
            // appearing 終了後は必ず waiting アニメーションを再生
            this.playWaitingAnimation();
        };
        
        this.mixer.addEventListener('finished', onAppearingFinished);
    }
    
    /**
     * キャラクターを表示してアイドルアニメーション開始（フォールバック用）
     */
    showCharacterAndStartIdle() {
        if (!this.vrm) return;
        
        this.vrm.scene.visible = true;
        this.isCharacterVisible = true;
        this.hasPlayedAppearing = true;
        this.isCharacterInitialized = true;
        
        // waiting アニメーションを再生
        this.playWaitingAnimation();
    }
    
    /**
     * waiting アニメーションを再生
     */
    async playWaitingAnimation() {
        if (!this.vrm || !this.mixer) return;
        
        console.log('Playing waiting animation...');
        
        const animationData = await this.loadGLTFAnimation('./models/animation/waiting.vrma', { loop: false });
        if (!animationData) {
            console.warn('Failed to load waiting animation, falling back to idle');
            this.scheduleNextIdleAnimation();
            return;
        }
        
        this.playAnimationDirect(animationData, { 
            loop: false,
            onFinished: () => {
                console.log('Waiting animation completed, starting normal idle rotation');
                setTimeout(() => {
                    this.scheduleNextIdleAnimation();
                }, 1000);
            }
        }, false);
    }

    /**
     * liked アニメーションを再生（チャット応答時・アイドル時両用）
     */
    async playLikedAnimation() {
        if (!this.vrm || !this.mixer) return;
        
        console.log('Playing liked animation...');
        
        const animationData = await this.loadGLTFAnimation('./models/animation/liked.vrma', { loop: false });
        if (!animationData) {
            console.warn('Failed to load liked animation, falling back to idle');
            this.scheduleNextIdleAnimation();
            return;
        }
        
        this.playAnimationDirect(animationData, { 
            loop: false,
            onFinished: () => {
                console.log('Liked animation completed, returning to idle rotation');
                setTimeout(() => {
                    this.scheduleNextIdleAnimation();
                }, 1000);
            }
        }, false);
    }

    /**
     * アイドル復帰タイマーを開始
     */
    startIdleTimer() {
        // 既存のタイマーをクリア
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        
        // 一定時間後にアイドルアニメーションに復帰
        this.idleTimer = setTimeout(() => {
            if (this.currentAnimationType !== 'idle') {
                console.log('[Debug] Auto-returning to idle animation');
                this.playAnimation('idle', { loop: true });
            }
        }, this.idleTimeout);
    }

    /**
     * アイドルタイマーを停止
     */
    stopIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * アニメーション状態の更新
     */
    updateAnimationState(animationType) {
        this.currentAnimationType = animationType;
        
        // アイドル以外のアニメーション時はタイマーを停止
        if (animationType !== 'idle') {
            this.stopIdleTimer();
        }
    }
    
    /**
     * 感情に基づくアニメーション再生（glTF版）
     */
    playEmotionAnimation(emotion, personality = 'friendly', isTechExcited = false) {
        if (!this.vrm || !this.mixer) return;

        let selectedEmotion = emotion;

        // レイキャラクターの技術興奮時は強制的にhappyに
        if (personality === 'rei_engineer' && isTechExcited) {
            selectedEmotion = 'happy';
            console.log('[Debug] Rei tech excitement: forcing happy emotion');
        }

        // すべての感情でアイドルアニメーションを再生
        // sad感情も他の感情と同様にアイドルアニメーションローテーションに参加
        this.playAnimation('idle', { loop: true });

        // 表情も変更（キャラクター別強度調整）
        this.setExpression(selectedEmotion, personality, isTechExcited);

        this.currentEmotion = selectedEmotion;
        console.log(`[Debug] Playing emotion animation: ${selectedEmotion} for ${personality}${isTechExcited ? ' (tech excited)' : ''}`);

        // キャラクター情報を更新
        this.updateCharacterMood(selectedEmotion);
    }
    
    /**
     * 表情の設定 - キャラクター対応版
     */
    setExpression(emotion, personality = 'friendly', isTechExcited = false) {
        if (!this.vrm || !this.vrm.expressionManager) return;
        
        // 全ての表情をリセット（blinkも含む）
        const expressionManager = this.vrm.expressionManager;
        expressionManager.setValue('happy', 0);
        expressionManager.setValue('sad', 0);
        expressionManager.setValue('surprised', 0);
        expressionManager.setValue('angry', 0);
        expressionManager.setValue('relaxed', 0);
        expressionManager.setValue('blink', 0); // ★ blinkもリセット
        
        // ブリンク状態もリセット
        this.isBlinking = false;
        
        // 対応する表情を設定
        const expressionMap = {
            happy: 'happy',
            sad: 'sad', 
            surprised: 'surprised',
            neutral: 'relaxed'
        };
        
        const expression = expressionMap[emotion] || 'relaxed';
        
        // 表情強度調整
        if (expression === 'happy') {
            // 喜び表情は「楽しい」30% + 「標準(relaxed)」100% の組み合わせ
            expressionManager.setValue('happy', 0.3);
            expressionManager.setValue('relaxed', 1.0);
        } else if (expression === 'sad') {
            // 悲しい表情は60%
            expressionManager.setValue('sad', 0.6);
        } else if (expression === 'angry') {
            // 怒り表情は65%
            expressionManager.setValue('angry', 0.65);
        } else {
            // その他の表情は100%
            expressionManager.setValue(expression, 1.0);
        }
        
        this.currentExpression = emotion;
        console.log(`[Debug] Expression set: ${expression} for ${personality}${isTechExcited ? ' (tech excited)' : ''}`);
        
        // 表情変更後、新しいブリンクをスケジュール
        this.scheduleNextBlink();
    }
    
    /**
     * 表情を完全にリセット（ニュートラル状態に戻す）
     */
    resetToNeutralExpression() {
        if (!this.vrm || !this.vrm.expressionManager) return;
        
        console.log('[Debug] Resetting all expressions to neutral state');
        
        const expressionManager = this.vrm.expressionManager;
        
        // 全ての感情表情を0にリセット
        expressionManager.setValue('happy', 0);
        expressionManager.setValue('sad', 0);
        expressionManager.setValue('surprised', 0);
        expressionManager.setValue('angry', 0);
        expressionManager.setValue('relaxed', 0);
        
        // リップシンク関連も完全リセット
        expressionManager.setValue('aa', 0);
        expressionManager.setValue('ih', 0);
        expressionManager.setValue('ou', 0);
        
        // ブリンク状態を完全リセット
        expressionManager.setValue('blink', 0);
        this.isBlinking = false;
        this.lipSyncWeight = 0.0;
        
        // 現在の表情状態を更新
        this.currentExpression = 'neutral';
        this.currentEmotion = 'neutral';
        
        // 新しいブリンクサイクルを開始
        this.scheduleNextBlink();
        
        console.log('[Debug] Expression reset completed - all values set to 0, blink cycle restarted');
    }
    
    /**
     * ブリンクの実行
     */
    performBlink() {
        if (!this.vrm || !this.vrm.expressionManager || this.isBlinking) return;
        
        this.isBlinking = true;
        const expressionManager = this.vrm.expressionManager;
        
        // 現在の感情をチェック
        const isHappyExpression = this.currentExpression === 'happy';
        
        // ブリンクアニメーション（目を閉じる→開ける）
        const blinkDuration = 150; // ミリ秒
        const startTime = Date.now();
        
        const animateBlink = () => {
            const elapsed = Date.now() - startTime;
            const progress = elapsed / blinkDuration;
            
            if (progress < 0.5) {
                // 目を閉じる
                const blinkValue = progress * 2;
                // happy表情時はブリンクの強度を抑制
                const maxBlinkValue = isHappyExpression ? 0.6 : 1.0;
                expressionManager.setValue('blink', Math.min(blinkValue, maxBlinkValue));
            } else if (progress < 1.0) {
                // 目を開ける
                const blinkValue = 1.0 - (progress - 0.5) * 2;
                const maxBlinkValue = isHappyExpression ? 0.6 : 1.0;
                expressionManager.setValue('blink', Math.min(blinkValue, maxBlinkValue));
            } else {
                // ブリンク終了 - 必ず0にリセット
                expressionManager.setValue('blink', 0);
                this.isBlinking = false;
                this.scheduleNextBlink();
                return;
            }
            
            requestAnimationFrame(animateBlink);
        };
        
        animateBlink();
    }
    
    /**
     * ブリンクの更新（レンダリングループで呼び出し）
     */
    updateBlink() {
        if (!this.isBlinking && Date.now() >= this.nextBlinkTime) {
            this.performBlink();
        }
    }
    
    /**
     * レンダリングループ
     */
    startRenderLoop() {
        const animate = () => {
            requestAnimationFrame(animate);
            
            const deltaTime = this.clock.getDelta();
            
            if (this.mixer) {
                this.mixer.update(deltaTime);
            }
            
            if (this.vrm) {
                this.vrm.update(deltaTime);
            }
            
            if (this.controls) {
                this.controls.update();
            }
            
            // ブリンクの更新
            this.updateBlink();
            
            // リップシンクの更新
            this.updateLipSync();
            
            if (this.renderer && this.scene && this.camera) {
                this.renderer.render(this.scene, this.camera);
            }
            
            // CSS3D UIのレンダリング
            if (this.css3dRenderer && this.css3dScene && this.camera) {
                this.css3dRenderer.render(this.css3dScene, this.camera);
            }
            
            // AR吹き出しの位置更新
            if (this.settings.use3DUI && this.bubbleActive) {
                this.updateARSpeechBubblePosition();
            }
        };
        
        animate();
    }
    
    /**
     * AR吹き出しの位置更新
     */
    updateARSpeechBubblePosition() {
        if (!this.speechBubble || !this.bubbleActive) return;
        
        const headPosition = this.getCharacterHeadPosition();
        if (!headPosition) return;
        
        const screenPos = this.worldToScreen(headPosition);
        
        // 画面内に収まるように調整
        const bubbleWidth = 100;
        const bubbleHeight = 30;
        const padding = 10;
        
        let x = screenPos.x + 30; // 左側に少しオフセット
        let y = screenPos.y - 20;
        
        // 画面外にはみ出さないよう調整
        if (x - bubbleWidth/2 < padding) {
            x = bubbleWidth/2 + padding;
        } else if (x + bubbleWidth/2 > window.innerWidth - padding) {
            x = window.innerWidth - bubbleWidth/2 - padding;
        }
        
        if (y < padding) {
            y = padding;
        } else if (y > window.innerHeight - bubbleHeight - padding) {
            y = window.innerHeight - bubbleHeight - padding;
        }
        
        this.speechBubble.style.left = `${x}px`;
        this.speechBubble.style.top = `${y}px`;
    }
    
    /**
     * メッセージレスポンス処理（3D UI専用）- キャラクター対応版
     */
    /**
     * ストリーミングチャンクメッセージ処理
     */
    handleMessageChunk(data) {
        console.log('[Debug] Received message chunk:', data.chunk_index, data.text);
        console.log('[Debug] Audio data present:', !!data.audio_data);
        console.log('[Debug] Audio data size:', data.audio_data ? data.audio_data.length : 0);
        
        // チャンクをマップに保存
        this.receivedChunks.set(data.chunk_index, data);
        
        // 音声データがある場合はキューに追加
        if (data.audio_data) {
            console.log('[Debug] Adding audio chunk to queue:', data.chunk_index);
            this.audioChunkQueue.push({
                index: data.chunk_index,
                audio: data.audio_data,
                text: data.text,
                emotion: data.emotion
            });
            
            console.log('[Debug] Audio queue length:', this.audioChunkQueue.length);
            console.log('[Debug] Is playing audio:', this.isPlayingAudio);
            
            // 順次再生を開始（初回のみ）
            if (!this.isPlayingAudio) {
                console.log('[Debug] Starting audio chunk playback');
                this.startAudioChunkPlayback();
            }
        } else {
            console.log('[Debug] No audio data in chunk:', data.chunk_index);
        }
        
        // テキストを蓄積
        this.fullResponseText += data.text;
        
        // AR吹き出しを更新（最新チャンクのテキストで）
        this.showARSpeechBubble(data.text);
        
        // 感情アニメーション
        if (data.emotion) {
            this.playEmotionAnimation(data.emotion, data.personality);
        }
        
        // 初回チャンクでトークアニメーション開始
        if (data.chunk_index === 1) {
            this.playAnimation('talking', { loop: true });
        }
    }
    
    /**
     * ストリーミング完了処理
     */
    handleStreamingComplete(data) {
        console.log('[Debug] Streaming complete:', data);
        console.log('[Debug] Total chunks received:', this.receivedChunks.size);
        console.log('[Debug] Audio queue length at completion:', this.audioChunkQueue.length);
        this.hideLoading();
        
        // 完全なレスポンステキストを会話履歴に追加
        this.addMessageToConversation('assistant', data.full_text);
        
        // 最終的なAR吹き出し表示
        this.showARSpeechBubble(data.full_text);
        
        // ストリーミングセッションをリセット
        this.currentStreamingSession = null;
        this.fullResponseText = '';
        
        console.log('[Debug] Streaming session completed and reset');
    }
    
    /**
     * 音声チャンクの順次再生
     */
    async startAudioChunkPlayback() {
        if (this.isPlayingAudio) return;
        
        this.isPlayingAudio = true;
        this.audioPlaybackIndex = 1; // 1から開始
        
        console.log('[Debug] Starting audio chunk playback');
        
        while (this.audioChunkQueue.length > 0 || this.shouldWaitForMoreChunks()) {
            // 次のチャンクが来るまで待機
            const chunk = this.getNextAudioChunk();
            
            if (chunk) {
                console.log(`[Debug] Playing audio chunk ${chunk.index}`);
                
                try {
                    await this.playAudioChunk(chunk);
                    this.audioPlaybackIndex++;
                } catch (error) {
                    console.error(`[Error] Failed to play audio chunk ${chunk.index}:`, error);
                    this.audioPlaybackIndex++;
                }
            } else {
                // チャンクが来るまで少し待機
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // 全ての音声再生完了
        this.isPlayingAudio = false;
        console.log('[Debug] Audio chunk playback completed');
        
        // アイドルアニメーションに戻る
        this.playAnimation('idle', { loop: true });
    }
    
    /**
     * 次の音声チャンクを取得
     */
    getNextAudioChunk() {
        // 期待するインデックスのチャンクを探す
        const chunkIndex = this.audioChunkQueue.findIndex(chunk => chunk.index === this.audioPlaybackIndex);
        
        if (chunkIndex !== -1) {
            return this.audioChunkQueue.splice(chunkIndex, 1)[0];
        }
        
        return null;
    }
    
    /**
     * より多くのチャンクを待つべきかを判定
     */
    shouldWaitForMoreChunks() {
        // ストリーミングが完了していない、または待機中のチャンクがある場合
        return this.currentStreamingSession !== null || this.audioChunkQueue.length > 0;
    }
    
    /**
     * 個別音声チャンクを再生
     */
    async playAudioChunk(chunk) {
        console.log(`[Debug] Attempting to play audio chunk ${chunk.index}`);
        console.log(`[Debug] Audio data format:`, chunk.audio.substring(0, 50));
        
        return new Promise((resolve, reject) => {
            try {
                const audio = new Audio(chunk.audio);
                audio.volume = this.settings.volume;
                audio.playbackRate = this.settings.voiceSpeed;
                
                console.log(`[Debug] Audio object created for chunk ${chunk.index}`);
                console.log(`[Debug] Volume: ${audio.volume}, PlaybackRate: ${audio.playbackRate}`);
                
                // リップシンクの設定
                this.setupLipSync(audio);
                
                audio.onloadstart = () => {
                    console.log(`[Debug] Audio chunk ${chunk.index} load started`);
                };
                
                audio.oncanplay = () => {
                    console.log(`[Debug] Audio chunk ${chunk.index} can play`);
                };
                
                audio.onended = () => {
                    console.log(`[Debug] Audio chunk ${chunk.index} ended`);
                    resolve();
                };
                
                audio.onerror = (error) => {
                    console.error(`[Debug] Audio chunk ${chunk.index} error:`, error);
                    console.error(`[Debug] Audio error details:`, audio.error);
                    reject(error);
                };
                
                console.log(`[Debug] Starting play() for chunk ${chunk.index}`);
                audio.play().then(() => {
                    console.log(`[Debug] Audio chunk ${chunk.index} started playing successfully`);
                }).catch((error) => {
                    console.error(`[Debug] Audio chunk ${chunk.index} play() failed:`, error);
                    reject(error);
                });
                
            } catch (error) {
                console.error(`[Debug] Exception in playAudioChunk ${chunk.index}:`, error);
                reject(error);
            }
        });
    }

    handleMessageResponse(data) {
        console.log('[Debug] Received message response:', data);
        console.log('[Debug] Character personality:', data.personality);
        console.log('[Debug] Audio data present:', !!data.audio_data);
        console.log('[Debug] Audio data length:', data.audio_data ? data.audio_data.length : 0);
        this.hideLoading();
        
        // AIレスポンスを会話履歴に追加
        this.addMessageToConversation('assistant', data.text);
        
        // キャラクター別の音声設定を適用
        this.applyCharacterSettings(data.personality, data.is_tech_excited);
        
        // AR吹き出しで表示
        this.showARSpeechBubble(data.text);
        
        // 感情に基づくアニメーション（キャラクター別調整）
        if (data.emotion) {
            this.playEmotionAnimation(data.emotion, data.personality, data.is_tech_excited);
        }
        
        // AI応答時は liked アニメーションを再生（より魅力的な応答）
        this.playLikedAnimation();
        
        // 音声再生
        if (data.audio_data) {
            console.log('[Debug] Starting audio playback');
            this.playAudioData(data.audio_data);
        } else {
            console.log('[Debug] No audio data to play');
        }
    }
    
    /**
     * キャラクター別設定を適用
     */
    applyCharacterSettings(personality, isTechExcited = false) {
        const originalSpeed = this.settings.voiceSpeed;
        
        switch(personality) {
            case 'rei_engineer':
                if (isTechExcited) {
                    // 技術話題で興奮時は早口
                    this.settings.voiceSpeed = 1.3;
                    console.log('[Debug] Rei excited mode: speech speed increased to 1.3');
                } else {
                    // 普段はクールで標準速度
                    this.settings.voiceSpeed = 1.0;
                    console.log('[Debug] Rei cool mode: normal speech speed');
                }
                break;
                
            case 'yui_natural':
                // 天然女の子はゆっくり話す
                this.settings.voiceSpeed = 0.9;
                console.log('[Debug] Yui mode: slow speech speed 0.9');
                break;
                
            default:
                // デフォルト設定
                this.settings.voiceSpeed = 1.0;
                break;
        }
    }
    
    /**
     * 音声レスポンス処理
     */
    handleAudioResponse(data) {
        console.log('[Debug] Received audio response:', data); // ★ デバッグログ追加
        this.hideLoading();
        
        // 認識テキストを会話履歴に追加（ユーザーメッセージ）
        if (data.transcribed_text) {
            console.log('Transcribed:', data.transcribed_text);
            this.addMessageToConversation('user', data.transcribed_text);
        }
        
        // AIレスポンスを会話履歴に追加
        if (data.response_text) {
            this.addMessageToConversation('assistant', data.response_text);
        }
        
        // AR吹き出しで応答を表示
        this.showARSpeechBubble(data.response_text);
        
        // 感情に基づくアニメーション
        if (data.emotion) {
            this.playEmotionAnimation(data.emotion);
        }
        
        // 音声再生
        if (data.audio_data) {
            this.playAudioData(data.audio_data);
        }
    }
    
    /**
     * チャットにメッセージを追加
     */
    addMessageToChat(role, text) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}-message`;
        
        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        avatarDiv.innerHTML = role === 'user' ? '<i class="fas fa-user"></i>' : '<i class="fas fa-robot"></i>';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = text;
        
        const timestampDiv = document.createElement('div');
        timestampDiv.className = 'message-timestamp';
        timestampDiv.textContent = new Date().toLocaleTimeString('ja-JP', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        contentDiv.appendChild(textDiv);
        contentDiv.appendChild(timestampDiv);
        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        
        this.elements.chatMessages.appendChild(messageDiv);
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }
    
    /**
     * 音声録音の開始/停止
     */
    async toggleVoiceRecording() {
        if (this.isRecording) {
            this.stopVoiceRecording();
        } else {
            await this.startVoiceRecording();
        }
    }
    
    /**
     * 音声録音開始
     */
    async startVoiceRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            this.mediaRecorder = new MediaRecorder(stream);
            this.audioChunks = [];
            
            this.mediaRecorder.ondataavailable = (event) => {
                this.audioChunks.push(event.data);
            };
            
            this.mediaRecorder.onstop = () => {
                const audioBlob = new Blob(this.audioChunks, { type: 'audio/wav' });
                this.sendAudioMessage(audioBlob);
            };
            
            this.mediaRecorder.start();
            this.isRecording = true;
            
            this.elements.voiceButton.classList.add('recording');
            this.elements.voiceRecording.style.display = 'flex';
            
        } catch (error) {
            console.error('Failed to start recording:', error);
            this.showError('音声録音の開始に失敗しました');
        }
    }
    
    /**
     * 音声録音停止
     */
    stopVoiceRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
            
            this.isRecording = false;
            this.elements.voiceButton.classList.remove('recording');
            this.elements.voiceRecording.style.display = 'none';
            
            this.showLoading();
        }
    }
    
    /**
     * 音声メッセージ送信
     */
    async sendAudioMessage(audioBlob) {
        try {
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioData = Array.from(new Uint8Array(arrayBuffer));
            
            this.socket.emit('send_audio', {
                session_id: this.sessionId,
                audio_data: audioData.map(b => b.toString(16).padStart(2, '0')).join(''),
                voice_id: this.settings.voiceId
            });
            
        } catch (error) {
            console.error('Failed to send audio:', error);
            this.showError('音声の送信に失敗しました');
            this.hideLoading();
        }
    }
    
    /**
     * 音声再生
     */
    playAudio(audioUrl) {
        console.log('[Debug] playAudio called with URL:', audioUrl);
        try {
            if (!audioUrl) {
                console.log('[Debug] No audio URL provided. Skipping playback.');
                return;
            }

            // プロキシURL経由で音声を取得（CORS回避）
            const proxyUrl = `http://localhost:5000/api/proxy-audio?url=${encodeURIComponent(audioUrl)}`;
            console.log('[Debug] Using proxy URL:', proxyUrl);

            const audio = new Audio(proxyUrl);
            console.log('[Debug] Created Audio object with proxy URL');

            audio.volume = this.settings.volume;
            audio.playbackRate = this.settings.voiceSpeed;

            // 音声ロード完了後にリップシンクセットアップ
            audio.addEventListener('loadeddata', () => {
                console.log('[Debug] Audio loaded successfully, setting up lip sync');
                try {
                    this.setupLipSync(audio);
                } catch (error) {
                    console.warn('Lip sync setup failed, using fallback:', error);
                    this.simulateBasicLipSync();
                }
            });

            // 音声再生開始
            audio.addEventListener('play', () => {
                console.log('[Debug] Audio playback started');
            });

            // 音声再生終了時のクリーンアップ
            audio.addEventListener('ended', () => {
                console.log('[Debug] Audio playback ended');
                this.lipSyncWeight = 0.0;
                if (this.vrm && this.vrm.expressionManager) {
                    // リップシンク関連の値をリセット
                    this.vrm.expressionManager.setValue('aa', 0);
                    this.vrm.expressionManager.setValue('ih', 0);
                    this.vrm.expressionManager.setValue('ou', 0);
                    
                    // 表情を完全リセット（新しいメソッドを使用）
                    setTimeout(() => {
                        this.resetToNeutralExpression();
                        console.log('[Debug] Expression completely reset to neutral after audio ended');
                    }, 500); // 0.5秒後に完全リセット
                }
            });

            // エラーハンドリング
            audio.addEventListener('error', (e) => {
                console.error('[Debug] Audio error:', e);
                console.log('[Debug] Falling back to basic lip sync animation');
                this.simulateBasicLipSync();
            });

            console.log('[Debug] Attempting to play audio...');
            audio.play().then(() => {
                console.log('[Debug] Audio play() promise resolved successfully');
            }).catch(error => {
                console.error('Failed to play audio:', error);
                console.log('[Debug] Using fallback lip sync animation');
                this.simulateBasicLipSync();
                this.showError('音声の再生に失敗しました。リップシンクのみ実行します。');
            });

        } catch (error) {
            console.error('Error in playAudio:', error);
            console.log('[Debug] Using fallback lip sync animation due to error');
            this.simulateBasicLipSync();
            this.showError('音声処理でエラーが発生しました。');
        }
    }
    
    /**
     * Base64エンコードされた音声データを再生
     */
    playAudioData(audioData) {
        console.log('[Debug] playAudioData called with data:', audioData ? 'Data received' : 'No data');
        console.log('[Debug] Audio data format check:', audioData ? audioData.substring(0, 50) : 'No data');
        
        try {
            if (!audioData) {
                console.log('[Debug] No audio data provided. Skipping playback.');
                // 音声データがない場合でもアイドル状態に戻る
                this.startIdleTimer();
                return;
            }

            // Base64データから音声オブジェクトを作成
            const audio = new Audio(audioData);
            console.log('[Debug] Created Audio object from base64 data');
            console.log('[Debug] Audio object created successfully:', !!audio);

            audio.volume = this.settings.volume;
            audio.playbackRate = this.settings.voiceSpeed;
            console.log('[Debug] Audio settings - Volume:', audio.volume, 'PlaybackRate:', audio.playbackRate);

            // エラーハンドリングを強化
            audio.addEventListener('error', (e) => {
                console.error('[Debug] Audio error event:', e);
                console.error('[Debug] Audio error details:', audio.error);
                console.error('[Debug] Audio error code:', audio.error ? audio.error.code : 'No error code');
                console.error('[Debug] Audio error message:', audio.error ? audio.error.message : 'No error message');
            });

            // 音声ロード開始
            audio.addEventListener('loadstart', () => {
                console.log('[Debug] Audio load started');
            });

            // 音声ロード完了後にリップシンクセットアップ
            audio.addEventListener('loadeddata', () => {
                console.log('[Debug] Audio loaded successfully, setting up lip sync');
                try {
                    this.setupLipSync(audio);
                } catch (error) {
                    console.warn('Lip sync setup failed, using fallback:', error);
                    this.simulateBasicLipSync();
                }
            });

            // 音声再生可能状態
            audio.addEventListener('canplay', () => {
                console.log('[Debug] Audio can play');
            });

            // 音声再生開始
            audio.addEventListener('play', () => {
                console.log('[Debug] Audio playback started');
            });

            // 音声再生終了時のクリーンアップ
            audio.addEventListener('ended', () => {
                console.log('[Debug] Audio playback ended');
                this.lipSyncWeight = 0.0;
                if (this.vrm && this.vrm.expressionManager) {
                    // リップシンク関連の値をリセット
                    this.vrm.expressionManager.setValue('aa', 0);
                    this.vrm.expressionManager.setValue('ih', 0);
                    this.vrm.expressionManager.setValue('ou', 0);
                    
                    // 表情をneutralに戻す
                    setTimeout(() => {
                        this.setExpression('neutral');
                        console.log('[Debug] Expression reset to neutral after audio ended');
                    }, 500); // 0.5秒後にneutralに戻す
                }
                
                // 音声終了後、少し待ってからアイドルアニメーションに復帰
                setTimeout(() => {
                    this.startIdleTimer();
                }, 1000);
            });

            // エラーハンドリング
            audio.addEventListener('error', (e) => {
                console.error('[Debug] Audio error:', e);
                console.log('[Debug] Falling back to basic lip sync animation');
                this.simulateBasicLipSync();
                this.startIdleTimer();
            });

            console.log('[Debug] Attempting to play audio...');
            
            // 音声再生の実行
            const playPromise = audio.play();
            
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    console.log('[Debug] Audio play() promise resolved successfully');
                }).catch((error) => {
                    console.error('[Debug] Audio play() promise rejected:', error);
                    console.error('[Debug] Error name:', error.name);
                    console.error('[Debug] Error message:', error.message);
                    
                    // 自動再生がブロックされた場合の処理
                    if (error.name === 'NotAllowedError') {
                        console.log('[Debug] Autoplay was prevented. User interaction required.');
                        // ユーザーに音声再生の許可を求める（必要に応じて）
                    }
                    
                    console.log('[Debug] Using fallback lip sync animation');
                    this.simulateBasicLipSync();
                    this.startIdleTimer();
                });
            } else {
                console.log('[Debug] Audio play() returned undefined (older browser)');
            }

        } catch (error) {
            console.error('Error in playAudioData:', error);
            console.log('[Debug] Using fallback lip sync animation due to error');
            this.simulateBasicLipSync();
            this.showError('音声処理でエラーが発生しました。');
            this.startIdleTimer();
        }
    }
    
    /**
     * リップシンクのセットアップ
     */
    setupLipSync(audio) {
        try {
            // AudioContextの初期化（ユーザーインタラクション後に実行される）
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            // AudioContextの状態確認
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
            
            // 既存のaudioSourceがあれば切断
            if (this.audioSource) {
                try {
                    this.audioSource.disconnect();
                } catch (e) {
                    console.warn('Previous audio source disconnect failed:', e);
                }
            }
            
            // アナライザーの作成
            this.audioAnalyser = this.audioContext.createAnalyser();
            this.audioAnalyser.fftSize = 256;
            this.audioAnalyser.smoothingTimeConstant = 0.8;
            
            // 周波数データ配列の初期化
            this.frequencyData = new Uint8Array(this.audioAnalyser.frequencyBinCount);
            
            // オーディオソースの作成（CORSエラー可能性あり）
            this.audioSource = this.audioContext.createMediaElementSource(audio);
            this.audioSource.connect(this.audioAnalyser);
            this.audioAnalyser.connect(this.audioContext.destination);
            
            this.currentAudio = audio;
            console.log('Lip sync setup completed successfully');
            
        } catch (error) {
            console.warn('Lip sync setup failed, likely due to CORS restrictions. Audio will play without lip sync:', error);
            
            // CORSエラーでリップシンクが失敗した場合のフォールバック
            this.audioSource = null;
            this.audioAnalyser = null;
            this.frequencyData = null;
            this.currentAudio = audio;
            
            // 簡易的な口の動きシミュレーション（オプション）
            this.simulateBasicLipSync(audio);
        }
    }
    
    /**
     * CORS制限時の簡易リップシンクシミュレーション
     */
    simulateBasicLipSync(audio) {
        if (!audio || !this.vrm || !this.vrm.expressionManager) return;
        
        let lipSyncInterval;
        
        const startSimulation = () => {
            lipSyncInterval = setInterval(() => {
                if (audio.paused || audio.ended) {
                    clearInterval(lipSyncInterval);
                    this.lipSyncWeight = 0.0;
                    this.updateMouthExpression();
                    return;
                }
                
                // ランダムな口の動きをシミュレート
                this.lipSyncWeight = Math.random() * 0.6 + 0.2; // 0.2-0.8の範囲
                this.updateMouthExpression();
            }, 150); // 150msごとに更新
        };
        
        const stopSimulation = () => {
            if (lipSyncInterval) {
                clearInterval(lipSyncInterval);
                this.lipSyncWeight = 0.0;
                this.updateMouthExpression();
                
                // 表情を完全リセット（新しいメソッドを使用）
                setTimeout(() => {
                    this.resetToNeutralExpression();
                    console.log('[Debug] Expression completely reset to neutral after lip sync simulation ended');
                }, 500); // 0.5秒後に完全リセット
            }
        };
        
        audio.addEventListener('play', startSimulation);
        audio.addEventListener('pause', stopSimulation);
        audio.addEventListener('ended', stopSimulation);
    }
    
    /**
     * 音声レベルを解析してリップシンクの重みを計算
     */
    updateLipSync() {
        try {
            if (!this.audioAnalyser || !this.frequencyData || !this.currentAudio || this.currentAudio.paused) {
                this.lipSyncWeight = 0.0;
                return;
            }
            
            // 周波数データを取得
            this.audioAnalyser.getByteFrequencyData(this.frequencyData);
            
            // 音声レベルを計算（低域〜中域を重視）
            let sum = 0;
            const relevantBins = Math.min(64, this.frequencyData.length); // 低域〜中域のみ
            for (let i = 0; i < relevantBins; i++) {
                sum += this.frequencyData[i];
            }
            
            const average = sum / relevantBins;
            
            // 正規化と感度調整（大きめの重みで視認性向上）
            this.lipSyncWeight = Math.min(1.0, (average / 255.0) * this.lipSyncSensitivity);
            
            // 口の表情を更新
            this.updateMouthExpression();
        } catch (error) {
            // リップシンク処理でエラーが発生した場合はスキップ
            console.warn('Lip sync update failed:', error);
            this.lipSyncWeight = 0.0;
        }
    }
    
    /**
     * 口の表情を更新（リップシンク + 感情表現）
     */
    updateMouthExpression() {
        if (!this.vrm || !this.vrm.expressionManager) return;
        
        try {
            // 基本の感情表現
            const expressions = {
                'aa': this.lipSyncWeight, // 口を開ける（あ音）
                'ih': this.lipSyncWeight * 0.7, // 口を少し開ける（い音）
                'ou': this.lipSyncWeight * 0.8, // 口を丸める（お音）
            };
            
            // 感情に応じた基本表情と組み合わせ
            if (this.currentExpression === 'happy') {
                this.vrm.expressionManager.setValue('happy', 0.8 - this.lipSyncWeight * 0.3);
            } else if (this.currentExpression === 'sad') {
                this.vrm.expressionManager.setValue('sad', 0.6 - this.lipSyncWeight * 0.2);
            }
            
            // リップシンクの適用
            Object.entries(expressions).forEach(([expression, weight]) => {
                this.vrm.expressionManager.setValue(expression, weight);
            });
            
        } catch (error) {
            console.error('Failed to update mouth expression:', error);
        }
    }
    

    /**
     * キャラクター別のデフォルト設定（音声・モデル）を適用
     */
    setCharacterDefaultVoice(personality) {
        const characterSettings = {
            'rei_engineer': {
                voiceId: 'gARvXPexe5VF3cKZBian', //mitsuki
                model: 'avatar.vrm' // レイのモデル
            },
            'yui_natural': {
                voiceId: 'vGQNBgLaiM3EdZtxIiuY', // kawaiiairlicita
                model: 'yui.vrm' // ユイのモデル
            }
        };
        
        const characterConfig = characterSettings[personality];
        if (characterConfig) {
            // 音声ID設定
            this.settings.voiceId = characterConfig.voiceId;
            console.log(`[Debug] Character voice set to: ${this.settings.voiceId} for ${personality}`);
            
            // モデル設定（設定のみ、実際のロードは呼び出し元で行う）
            this.settings.character = characterConfig.model;
            console.log(`[Debug] Character model set to: ${this.settings.character} for ${personality}`);
        }
    }
    
    /**
     * サイドバーの開閉
     */
    toggleSidebar() {
        this.elements.sidebar.classList.toggle('open');
    }
    
    closeSidebar() {
        this.elements.sidebar.classList.remove('open');
    }
    
    /**
     * 接続ステータス更新
     */
    updateConnectionStatus(status) {
        const statusElement = this.elements.connectionStatus;
        const icon = statusElement.querySelector('i');
        const text = statusElement.querySelector('span');
        
        switch (status) {
            case 'connected':
                icon.className = 'fas fa-circle text-green';
                text.textContent = '接続済み';
                break;
            case 'disconnected':
                icon.className = 'fas fa-circle text-red';
                text.textContent = '切断';
                break;
            default:
                icon.className = 'fas fa-circle text-gray';
                text.textContent = '接続中...';
        }
    }
    
    /**
     * キャラクター気分更新
     */
    updateCharacterMood(emotion) {
        const moodElement = this.elements.characterMood;
        const icon = moodElement.querySelector('i');
        const text = moodElement.querySelector('span');
        
        const moods = {
            happy: { icon: 'fas fa-smile', text: '嬉しい' },
            sad: { icon: 'fas fa-frown', text: '悲しい' },
            surprised: { icon: 'fas fa-surprise', text: 'びっくり' },
            neutral: { icon: 'fas fa-meh', text: '普通' }
        };
        
        const mood = moods[emotion] || moods.neutral;
        icon.className = mood.icon;
        text.textContent = mood.text;
    }
    
    /**
     * ローディング表示
     */
    showLoading() {
        this.elements.loadingOverlay.style.display = 'flex';
    }
    
    hideLoading() {
        this.elements.loadingOverlay.style.display = 'none';
    }
    
    /**
     * エラー表示（高速化版）
     */
    showError(message) {
        this.elements.errorMessage.textContent = message;
        this.elements.errorToast.style.display = 'flex';
        
        // エラートーストの表示時間を短縮（5秒 → 3秒）
        setTimeout(() => {
            this.hideErrorToast();
        }, 3000);
    }
    
    /**
     * エラートースト表示（showErrorToast関数の追加）
     */
    showErrorToast(message) {
        this.showError(message);
    }
    
    hideErrorToast() {
        this.elements.errorToast.style.display = 'none';
    }
    
    /**
     * ウィンドウリサイズ処理
     */
    onWindowResize() {
        if (this.camera && this.renderer) {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        }
        
        // CSS3DRendererのリサイズ
        if (this.css3dRenderer) {
            this.css3dRenderer.setSize(window.innerWidth, window.innerHeight);
        }
    }
    
    /**
     * 3D UIモードの切り替え
     */
    toggle3DUIMode(enabled) {
        if (enabled) {
            document.body.classList.add('ui-3d-mode');
            if (!this.glassPanel) {
                this.init3DUISystem();
            }
        } else {
            document.body.classList.remove('ui-3d-mode');
            this.hideARSpeechBubble();
        }
        console.log('3D UI Mode:', enabled ? 'Enabled' : 'Disabled');
    }
    
    /**
     * 記憶リセット
     */
    resetMemory() {
        if (confirm('記憶をリセットしますか？この操作は元に戻せません。')) {
            // IndexedDBからデータを削除
            if ('indexedDB' in window) {
                const deleteReq = indexedDB.deleteDatabase('AIWifeMemory');
                deleteReq.onsuccess = () => {
                    console.log('Memory reset successfully');
                    this.showErrorToast('記憶をリセットしました');
                };
                deleteReq.onerror = () => {
                    console.error('Failed to reset memory');
                    this.showErrorToast('記憶のリセットに失敗しました');
                };
            }
            
            // 会話履歴をクリア
            this.conversationMessages = [];
            
            // 新しいセッションIDを生成
            this.sessionId = this.generateSessionId();
            console.log('New session started after memory reset:', this.sessionId);
            
            // 成功メッセージ
            this.showErrorToast('記憶をリセットしました');
        }
    }

    /**
     * チャット履歴サイドバーを開閉
     */
    toggleChatHistory() {
        this.elements.chatHistorySidebar.classList.toggle('open');
        if (this.elements.chatHistorySidebar.classList.contains('open')) {
            this.loadChatHistory();
        }
    }

    /**
     * チャット履歴サイドバーを閉じる
     */
    closeChatHistory() {
        this.elements.chatHistorySidebar.classList.remove('open');
    }

    /**
     * IndexedDBからチャット履歴を読み込み
     */
    async loadChatHistory() {
        try {
            const history = await this.getChatHistoryFromDB();
            this.displayChatHistory(history);
        } catch (error) {
            console.error('Error loading chat history:', error);
            this.showErrorToast('チャット履歴の読み込みに失敗しました');
        }
    }

    /**
     * IndexedDBからチャット履歴を取得
     */
    getChatHistoryFromDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('AIWifeMemory', 2); // バージョンを2に統一
            
            request.onerror = () => reject(request.error);
            
            request.onsuccess = () => {
                const db = request.result;
                
                if (!db.objectStoreNames.contains('conversations')) {
                    resolve([]);
                    return;
                }
                
                const transaction = db.transaction(['conversations'], 'readonly');
                const store = transaction.objectStore('conversations');
                const getAllRequest = store.getAll();
                
                getAllRequest.onsuccess = () => {
                    const conversations = getAllRequest.result || [];
                    // 日付順でソート（新しい順）
                    conversations.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                    resolve(conversations);
                };
                
                getAllRequest.onerror = () => reject(getAllRequest.error);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // 既存のストアを削除して再作成
                if (db.objectStoreNames.contains('conversations')) {
                    db.deleteObjectStore('conversations');
                }
                
                // 新しいストアを作成
                const store = db.createObjectStore('conversations', { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('personality', 'personality', { unique: false });
                store.createIndex('sessionId', 'sessionId', { unique: false });
                
                console.log('IndexedDB schema updated for getChatHistoryFromDB');
            };
        });
    }

    /**
     * チャット履歴を表示
     */
    displayChatHistory(conversations) {
        const historyList = this.elements.historyList;
        historyList.innerHTML = '';

        if (conversations.length === 0) {
            historyList.innerHTML = `
                <div class="no-history">
                    <i class="fas fa-comments"></i>
                    <p>まだチャット履歴がありません</p>
                </div>
            `;
            return;
        }

        conversations.forEach(conversation => {
            const historyItem = this.createHistoryItem(conversation);
            historyList.appendChild(historyItem);
        });
    }

    /**
     * 履歴アイテムを作成
     */
    createHistoryItem(conversation) {
        const item = document.createElement('div');
        item.className = 'history-item';
        
        const characterName = this.getCharacterDisplayName(conversation.personality);
        const date = new Date(conversation.timestamp).toLocaleDateString('ja-JP', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        const messageCount = conversation.messages ? conversation.messages.length : 0;
        const preview = this.getConversationPreview(conversation);
        
        item.innerHTML = `
            <div class="history-item-header">
                <div class="character-name">${characterName}</div>
                <div class="chat-date">${date}</div>
            </div>
            <div class="chat-preview">${preview}</div>
            <div class="message-count">${messageCount}件</div>
        `;
        
        item.addEventListener('click', () => this.loadConversation(conversation));
        
        return item;
    }

    /**
     * キャラクター表示名を取得
     */
    getCharacterDisplayName(personality) {
        const names = {
            'rei_engineer': 'レイ (AIエンジニア)',
            'yui_natural': 'ユイ (天然な癒し系)',
            'friendly': '汎用 - 親しみやすい',
            'shy': '汎用 - 内気',
            'energetic': '汎用 - 元気',
            'calm': '汎用 - 落ち着いた'
        };
        return names[personality] || personality;
    }

    /**
     * 会話のプレビューを取得
     */
    getConversationPreview(conversation) {
        if (!conversation.messages || conversation.messages.length === 0) {
            return '会話が開始されていません';
        }
        
        const lastMessage = conversation.messages[conversation.messages.length - 1];
        return lastMessage.text.length > 50 
            ? lastMessage.text.substring(0, 50) + '...'
            : lastMessage.text;
    }

    /**
     * 会話を読み込んで詳細表示
     */
    loadConversation(conversation) {
        console.log('Loading conversation:', conversation);
        
        // 会話詳細をモーダルで表示
        this.showConversationDetail(conversation);
    }

    /**
     * 会話詳細をモーダルで表示
     */
    showConversationDetail(conversation) {
        // 既存のモーダルがあれば削除
        const existingModal = document.getElementById('conversationModal');
        if (existingModal) {
            existingModal.remove();
        }

        // モーダルHTML作成
        const modal = document.createElement('div');
        modal.id = 'conversationModal';
        modal.className = 'conversation-modal';
        
        const characterName = this.getCharacterDisplayName(conversation.personality);
        const date = new Date(conversation.timestamp).toLocaleString('ja-JP', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        let messagesHtml = '';
        if (conversation.messages && conversation.messages.length > 0) {
            messagesHtml = conversation.messages.map(msg => {
                const msgDate = new Date(msg.timestamp).toLocaleTimeString('ja-JP', {
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const roleClass = msg.role === 'user' ? 'user-message' : 'assistant-message';
                const roleIcon = msg.role === 'user' ? 'fas fa-user' : 'fas fa-robot';
                
                return `
                    <div class="conversation-message ${roleClass}">
                        <div class="message-avatar">
                            <i class="${roleIcon}"></i>
                        </div>
                        <div class="message-content">
                            <div class="message-text">${msg.text}</div>
                            <div class="message-timestamp">${msgDate}</div>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            messagesHtml = '<div class="no-messages">メッセージがありません</div>';
        }

        modal.innerHTML = `
            <div class="modal-overlay" onclick="this.parentElement.remove()">
                <div class="modal-content" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <h3>${characterName}との会話</h3>
                        <div class="modal-date">${date}</div>
                        <button class="modal-close" onclick="this.closest('.conversation-modal').remove()">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="modal-body">
                        <div class="conversation-messages">
                            ${messagesHtml}
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="modal-button" onclick="this.closest('.conversation-modal').remove()">
                            閉じる
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
    }

    /**
     * チャット履歴を検索
     */
    searchChatHistory(searchTerm) {
        const historyItems = this.elements.historyList.querySelectorAll('.history-item');
        
        historyItems.forEach(item => {
            const text = item.textContent.toLowerCase();
            const isVisible = text.includes(searchTerm.toLowerCase());
            item.style.display = isVisible ? 'block' : 'none';
        });
    }

    /**
     * チャット履歴をクリア
     */
    async clearChatHistory() {
        if (!confirm('すべてのチャット履歴を削除しますか？この操作は取り消せません。')) {
            return;
        }
        
        try {
            await this.clearChatHistoryFromDB();
            this.loadChatHistory();
            this.showErrorToast('チャット履歴をクリアしました');
        } catch (error) {
            console.error('Error clearing chat history:', error);
            this.showErrorToast('チャット履歴のクリアに失敗しました');
        }
    }

    /**
     * IndexedDBからチャット履歴を削除
     */
    clearChatHistoryFromDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('AIWifeMemory', 2); // バージョンを2に統一
            
            request.onerror = () => reject(request.error);
            
            request.onsuccess = () => {
                const db = request.result;
                
                if (!db.objectStoreNames.contains('conversations')) {
                    resolve();
                    return;
                }
                
                const transaction = db.transaction(['conversations'], 'readwrite');
                const store = transaction.objectStore('conversations');
                const clearRequest = store.clear();
                
                clearRequest.onsuccess = () => {
                    console.log('Chat history cleared from IndexedDB');
                    resolve();
                };
                clearRequest.onerror = () => reject(clearRequest.error);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // 既存のストアを削除して再作成
                if (db.objectStoreNames.contains('conversations')) {
                    db.deleteObjectStore('conversations');
                }
                
                // 新しいストアを作成
                const store = db.createObjectStore('conversations', { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('personality', 'personality', { unique: false });
                store.createIndex('sessionId', 'sessionId', { unique: false });
                
                console.log('IndexedDB schema updated for clearChatHistoryFromDB');
            };
        });
    }

    /**
     * 会話にメッセージを追加してIndexedDBに保存
     */
    addMessageToConversation(role, text) {
        if (!this.settings.memoryEnabled) {
            return; // 記憶機能が無効の場合は保存しない
        }

        const message = {
            role: role,
            text: text,
            timestamp: new Date().toISOString()
        };

        this.conversationMessages.push(message);
        console.log('Added message to conversation:', message);

        // 定期的に会話をIndexedDBに保存（5メッセージごと、または1分間隔）
        this.scheduleConversationSave();
    }

    /**
     * 会話保存のスケジューリング
     */
    scheduleConversationSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        // 1秒後に保存（連続する操作をバッチ処理）
        this.saveTimeout = setTimeout(() => {
            this.saveConversationToDB();
        }, 1000);
    }

    /**
     * 現在の会話をIndexedDBに保存
     */
    async saveConversationToDB() {
        if (this.conversationMessages.length === 0) {
            console.log('No messages to save');
            return;
        }

        try {
            const conversation = {
                personality: this.settings.personality,
                messages: [...this.conversationMessages],
                timestamp: new Date().toISOString(),
                sessionId: this.sessionId
            };

            console.log('Saving conversation to IndexedDB:', conversation);
            await this.storeConversationInDB(conversation);
            console.log('Conversation successfully saved to IndexedDB');
        } catch (error) {
            console.error('Failed to save conversation:', error);
        }
    }

    /**
     * 会話をIndexedDBに保存
     */
    storeConversationInDB(conversation) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('AIWifeMemory', 2); // バージョンを2に上げる
            
            request.onerror = () => reject(request.error);
            
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction(['conversations'], 'readwrite');
                const store = transaction.objectStore('conversations');
                
                // セッションIDで既存の会話を検索（インデックスを使わずに全件取得して検索）
                const getAllRequest = store.getAll();
                
                getAllRequest.onsuccess = () => {
                    const allConversations = getAllRequest.result;
                    const existingConversation = allConversations.find(conv => 
                        conv.sessionId === conversation.sessionId && 
                        conv.personality === conversation.personality
                    );
                    
                    if (existingConversation) {
                        // 既存の会話を更新（同一セッション・同一キャラクターのみ）
                        existingConversation.messages = conversation.messages;
                        existingConversation.timestamp = conversation.timestamp;
                        const updateRequest = store.put(existingConversation);
                        updateRequest.onsuccess = () => {
                            console.log('Conversation updated in IndexedDB');
                            resolve(updateRequest.result);
                        };
                        updateRequest.onerror = () => reject(updateRequest.error);
                    } else {
                        // 新しい会話を追加
                        const addRequest = store.add(conversation);
                        addRequest.onsuccess = () => {
                            console.log('New conversation added to IndexedDB');
                            resolve(addRequest.result);
                        };
                        addRequest.onerror = () => reject(addRequest.error);
                    }
                };
                
                getAllRequest.onerror = () => reject(getAllRequest.error);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // 既存のストアを削除して再作成
                if (db.objectStoreNames.contains('conversations')) {
                    db.deleteObjectStore('conversations');
                }
                
                // 新しいストアを作成
                const store = db.createObjectStore('conversations', { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('personality', 'personality', { unique: false });
                store.createIndex('sessionId', 'sessionId', { unique: false });
                
                console.log('IndexedDB schema updated with sessionId index');
            };
        });
    }

    /**
     * 新しい会話セッションを開始
     */
    startNewConversation() {
        // 現在の会話を保存（まだ保存されていない場合）
        if (this.conversationMessages.length > 0) {
            this.saveConversationToDB();
        }

        // 新しいセッションを開始
        this.sessionId = this.generateSessionId();
        this.conversationMessages = [];
        
        // 保存タイムアウトをクリア
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        
        console.log('Started new conversation session:', this.sessionId);
    }
    
    /**
     * 設定の読み込み
     */
    loadSettings() {
        const savedSettings = localStorage.getItem('aiWifeSettings');
        if (savedSettings) {
            const settings = JSON.parse(savedSettings);
            Object.assign(this.settings, settings);
            
            // UI要素に反映
            document.getElementById('characterSelect').value = this.settings.character;
            document.getElementById('backgroundSelect').value = this.settings.background;
            document.getElementById('volumeSlider').value = Math.round(this.settings.volume * 100);
            document.getElementById('volumeValue').textContent = Math.round(this.settings.volume * 100) + '%';
            document.getElementById('voiceSpeed').value = this.settings.voiceSpeed;
            document.getElementById('voiceSpeedValue').textContent = this.settings.voiceSpeed + 'x';
        }
    }
    
    /**
     * キャラクターファイルアップロード処理
     */
    async handleCharacterUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        // ファイル形式チェック
        if (!file.name.toLowerCase().endsWith('.vrm')) {
            this.showError('VRMファイルのみアップロード可能です。');
            return;
        }
        
        try {
            const statusElement = document.getElementById('characterUploadStatus');
            statusElement.textContent = 'アップロード中...';
            statusElement.className = 'upload-status';
            
            // ファイルをmodelsフォルダに保存（実際の実装では、サーバーへのアップロード処理が必要）
            const fileName = `custom_${Date.now()}_${file.name}`;
            
            // URL.createObjectURLを使用してローカルファイルを読み込み
            const fileUrl = URL.createObjectURL(file);
            
            // キャラクター選択ドロップダウンにオプションを追加
            const characterSelect = document.getElementById('characterSelect');
            const option = document.createElement('option');
            option.value = fileName;
            option.textContent = `カスタム: ${file.name}`;
            option.dataset.localUrl = fileUrl;
            characterSelect.appendChild(option);
            
            // アップロードされたファイルを選択
            characterSelect.value = fileName;
            this.settings.character = fileName;
            
            // キャラクターを読み込み
            await this.loadCustomCharacter(fileUrl);
            
            statusElement.textContent = `${file.name} をアップロードしました`;
            statusElement.className = 'upload-status success';
            
        } catch (error) {
            console.error('Character upload failed:', error);
            const statusElement = document.getElementById('characterUploadStatus');
            statusElement.textContent = 'アップロードに失敗しました';
            statusElement.className = 'upload-status error';
            this.showError('キャラクターファイルのアップロードに失敗しました。');
        }
    }
    
    /**
     * 背景ファイルアップロード処理
     */
    async handleBackgroundUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        // ファイル形式チェック
        if (!file.type.startsWith('image/jpeg') && !file.type.startsWith('image/jpg')) {
            this.showError('JPEGファイルのみアップロード可能です。');
            return;
        }
        
        try {
            const statusElement = document.getElementById('backgroundUploadStatus');
            statusElement.textContent = 'アップロード中...';
            statusElement.className = 'upload-status';
            
            const fileName = `custom_${Date.now()}_${file.name}`;
            const fileUrl = URL.createObjectURL(file);
            
            // 背景選択ドロップダウンにオプションを追加
            const backgroundSelect = document.getElementById('backgroundSelect');
            const option = document.createElement('option');
            option.value = fileName;
            option.textContent = `カスタム: ${file.name}`;
            option.dataset.localUrl = fileUrl;
            backgroundSelect.appendChild(option);
            
            // アップロードされたファイルを選択
            backgroundSelect.value = fileName;
            this.settings.background = fileName;
            
            // 背景を読み込み
            await this.loadCustomBackground(fileUrl);
            
            statusElement.textContent = `${file.name} をアップロードしました`;
            statusElement.className = 'upload-status success';
            
        } catch (error) {
            console.error('Background upload failed:', error);
            const statusElement = document.getElementById('backgroundUploadStatus');
            statusElement.textContent = 'アップロードに失敗しました';
            statusElement.className = 'upload-status error';
            this.showError('背景ファイルのアップロードに失敗しました。');
        }
    }
    
    /**
     * カスタムキャラクターの読み込み
     */
    async loadCustomCharacter(fileUrl) {
        if (!this.scene) return;
        
        try {
            this.showLoading();
            
            // アニメーション関連のフラグをリセット
            this.hasPlayedAppearing = false;
            this.isCharacterInitialized = false;
            this.isCharacterVisible = false;
            
            // 既存のキャラクターを削除
            if (this.vrm) {
                this.scene.remove(this.vrm.scene);
                this.vrm = null;
            }
            
            // ミキサーをクリア
            if (this.mixer) {
                this.mixer.stopAllAction();
                this.mixer = null;
            }
            
            // GLTFローダーの設定
            const loader = new GLTFLoader();
            loader.crossOrigin = 'anonymous';
            
            // VRMLoaderPlugin と VRMAnimationLoaderPlugin を登録
            loader.register((parser) => new VRMLoaderPlugin(parser));
            loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
            
            // VRMファイルの読み込み
            const gltfVrm = await loader.loadAsync(fileUrl);
            this.vrm = gltfVrm.userData.vrm;
            
            // パフォーマンス最適化
            VRMUtils.removeUnnecessaryVertices(this.vrm.scene);
            VRMUtils.removeUnnecessaryJoints(this.vrm.scene);
            
            // フラスタムカリングを無効化
            this.vrm.scene.traverse((obj) => {
                obj.frustumCulled = false;
                obj.castShadow = true;
                obj.receiveShadow = true;
            });
            
            // LookAtクォータニオンプロキシを追加
            const lookAtQuatProxy = new VRMLookAtQuaternionProxy(this.vrm.lookAt);
            lookAtQuatProxy.name = 'lookAtQuaternionProxy';
            this.vrm.scene.add(lookAtQuatProxy);
            
            // シーンに追加（初期は非表示）
            this.scene.add(this.vrm.scene);
            this.vrm.scene.visible = false;
            this.isCharacterVisible = false;
            
            // アニメーションミキサーを再作成
            this.mixer = new THREE.AnimationMixer(this.vrm.scene);
            
            // T-poseを回避するため、デフォルトポーズを設定
            if (this.vrm.humanoid) {
                this.vrm.humanoid.resetNormalizedPose();
                console.log('VRM normalized pose reset completed');
            }
            
            // 登場アニメーションを再生
            this.playAppearingAnimation();
            
            this.hideLoading();
            console.log('Custom character loaded successfully with animations');
            
        } catch (error) {
            console.error('Failed to load custom character:', error);
            this.hideLoading();
            throw error;
        }
    }
    
    /**
     * カスタム背景の読み込み
     */
    async loadCustomBackground(fileUrl) {
        try {
            if (!this.scene) return;
            
            // 既存の背景を削除
            if (this.backgroundMesh) {
                this.scene.remove(this.backgroundMesh);
                this.backgroundMesh = null;
            }
            
            // テクスチャの読み込み
            const textureLoader = new THREE.TextureLoader();
            const texture = await new Promise((resolve, reject) => {
                textureLoader.load(fileUrl, resolve, undefined, reject);
            });
            
            // 180度のスフィア背景を作成
            const geometry = new THREE.SphereGeometry(50, 32, 16, Math.PI, Math.PI);
            const material = new THREE.MeshBasicMaterial({
                map: texture,
                side: THREE.BackSide
            });
            
            this.backgroundMesh = new THREE.Mesh(geometry, material);
            this.scene.add(this.backgroundMesh);
            
            console.log('Custom background loaded successfully');
            
        } catch (error) {
            console.error('Failed to load custom background:', error);
            throw error;
        }
    }
    
    /**
     * 設定の保存
     */
    saveSettings() {
        localStorage.setItem('aiWifeSettings', JSON.stringify(this.settings));
    }
}

// グローバル関数
window.hideErrorToast = () => {
    document.getElementById('errorToast').style.display = 'none';
};

// アプリケーション起動
document.addEventListener('DOMContentLoaded', () => {
    console.log('[Debug] DOMContentLoaded event fired');
    console.log('[Debug] Creating new AIWifeApp instance...');
    window.aiWifeApp = new AIWifeApp();
    console.log('[Debug] AIWifeApp instance created');
});
