# geventのモンキーパッチを最初に適用（RecursionError対策）
# 重要：すべてのインポートより前に実行する必要があります
from gevent import monkey
monkey.patch_all()

import os
import sys
import json
import sqlite3
import asyncio
import aiohttp
from aiohttp import TCPConnector
import google.generativeai as genai
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from dotenv import load_dotenv
import requests
import urllib3
from datetime import datetime
import logging
import time
import threading
import concurrent.futures
from typing import Dict, List, Optional
import tempfile
import base64
import re

# srcディレクトリをPythonパスに追加
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Voice Service import
from services.voice_service import get_voice_service

# 認証関連のインポート
from models.user import User
from auth.auth_manager import AuthManager, token_required, optional_token
from auth.oauth_manager import OAuthManager
from werkzeug.middleware.proxy_fix import ProxyFix

# Suppress only the single InsecureRequestWarning from urllib3 needed.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Load environment variables
load_dotenv()


app = Flask(__name__, static_folder='../frontend', template_folder='../frontend', static_url_path='')
# ProxyFix適用 - Renderなどのプロキシ環境でHTTPSスキームを正しく認識
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'default_secret_key')
socketio = SocketIO(app, cors_allowed_origins="*")
CORS(app)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configure Gemini AI
gemini_api_key = os.getenv('GEMINI_API_KEY')
if not gemini_api_key:
    print("[ERROR] GEMINI_API_KEY not found in environment variables")
else:
    print(f"[DEBUG] Gemini API key configured: {gemini_api_key[:20]}...")

genai.configure(api_key=gemini_api_key)

# モデル設定とバリデーション
primary_model_name = os.getenv('GEMINI_PRIMARY_MODEL', 'gemini-2.5-flash')
fallback_model_name = os.getenv('GEMINI_FALLBACK_MODEL', 'gemini-2.5-flash-lite')

print(f"[DEBUG] Primary model: {primary_model_name}")
print(f"[DEBUG] Fallback model: {fallback_model_name}")

try:
    primary_model = genai.GenerativeModel(primary_model_name)
    fallback_model = genai.GenerativeModel(fallback_model_name)
    print("[DEBUG] Gemini models initialized successfully")
except Exception as e:
    print(f"[ERROR] Failed to initialize Gemini models: {e}")

# API Configuration
ASSEMBLYAI_API_KEY = os.getenv('ASSEMBLYAI_API_KEY')

# Voice Service initialization (VITS-based TTS)
# Force reinitialize to ensure we use the latest configuration
voice_service = get_voice_service(force_reinit=True)

# データベースパスを現在のディレクトリからの相対パスで設定
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
# Vercelでは/tmpにしか書き込めないため、データベースパスを/tmpに変更
DATABASE_PATH = '/tmp/memory.db' if os.getenv('VERCEL') else os.getenv('DATABASE_PATH', os.path.join(project_root, 'config', 'memory.db'))

class MemoryManager:
    """AI短期記憶システムの管理クラス"""
    
    def __init__(self, db_path: str):
        # パスを絶対パスに変換
        self.db_path = os.path.abspath(db_path)
        self.init_database()
    
    def init_database(self):
        """データベースの初期化"""
        # データベースディレクトリが存在しない場合は作成
        db_dir = os.path.dirname(self.db_path)
        if not os.path.exists(db_dir):
            os.makedirs(db_dir, exist_ok=True)
        
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    emotion TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS user_info (
                    session_id TEXT PRIMARY KEY,
                    name TEXT,
                    preferences TEXT,
                    context_data TEXT,
                    last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            conn.commit()
            conn.close()
            logger.info(f"Database initialized successfully at: {self.db_path}")
            
        except sqlite3.Error as e:
            logger.error(f"Database initialization failed: {e}")
            # フォールバック：一時的なインメモリデータベース
            logger.warning("Using in-memory database as fallback")
            self.db_path = ':memory:'
    
    def save_message(self, session_id: str, role: str, content: str, emotion: str = None):
        """会話履歴を保存"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT INTO conversations (session_id, role, content, emotion)
                VALUES (?, ?, ?, ?)
            ''', (session_id, role, content, emotion))
            
            conn.commit()
            conn.close()
        except sqlite3.Error as e:
            logger.error(f"Failed to save message: {e}")
    
    def get_conversation_history(self, session_id: str, limit: int = 20) -> List[Dict]:
        """会話履歴を取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT role, content, emotion, timestamp
                FROM conversations
                WHERE session_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
            ''', (session_id, limit))
            
            results = cursor.fetchall()
            conn.close()
            
            return [
                {
                    'role': row[0],
                    'content': row[1],
                    'emotion': row[2],
                    'timestamp': row[3]
                }
                for row in reversed(results)
            ]
        except sqlite3.Error as e:
            logger.error(f"Failed to get conversation history: {e}")
            return []
    
    def update_user_info(self, session_id: str, name: str = None, preferences: str = None, context_data: str = None):
        """ユーザー情報を更新"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT OR REPLACE INTO user_info (session_id, name, preferences, context_data, last_interaction)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ''', (session_id, name, preferences, context_data))
            
            conn.commit()
            conn.close()
        except sqlite3.Error as e:
            logger.error(f"Failed to update user info: {e}")
    
    def get_user_info(self, session_id: str) -> Dict:
        """ユーザー情報を取得"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT name, preferences, context_data, last_interaction
                FROM user_info
                WHERE session_id = ?
            ''', (session_id,))
            
            result = cursor.fetchone()
            conn.close()
            
            if result:
                return {
                    'name': result[0],
                    'preferences': result[1],
                    'context_data': result[2],
                    'last_interaction': result[3]
                }
            return {}
        except sqlite3.Error as e:
            logger.error(f"Failed to get user info: {e}")
            return {}

class TextSplitter:
    """テキストを意味のある単位で分割するクラス"""
    
    def __init__(self, chunk_size: int = 50):
        self.chunk_size = chunk_size
        self.sentence_endings = ['。', '！', '？', '.', '!', '?']
        self.breath_markers = ['、', ',', '…', '・・・']
    
    def split_for_streaming(self, text: str) -> List[str]:
        """ストリーミング用にテキストを分割"""
        if not text:
            return []
        
        chunks = []
        current_chunk = ""
        
        # まず文単位で分割
        sentences = self.split_by_sentences(text)
        
        for sentence in sentences:
            # 文が長すぎる場合は句読点で細分化
            if len(sentence) > self.chunk_size:
                sub_chunks = self.split_by_breath_markers(sentence)
                for sub_chunk in sub_chunks:
                    if current_chunk and len(current_chunk + sub_chunk) > self.chunk_size:
                        if current_chunk.strip():
                            chunks.append(current_chunk.strip())
                        current_chunk = sub_chunk
                    else:
                        current_chunk += sub_chunk
            else:
                if current_chunk and len(current_chunk + sentence) > self.chunk_size:
                    if current_chunk.strip():
                        chunks.append(current_chunk.strip())
                    current_chunk = sentence
                else:
                    current_chunk += sentence
        
        # 残りのチャンクを追加
        if current_chunk.strip():
            chunks.append(current_chunk.strip())
        
        return [chunk for chunk in chunks if chunk.strip()]
    
    def split_by_sentences(self, text: str) -> List[str]:
        """文単位で分割"""
        sentences = []
        current_sentence = ""
        
        for char in text:
            current_sentence += char
            if char in self.sentence_endings:
                sentences.append(current_sentence)
                current_sentence = ""
        
        if current_sentence:
            sentences.append(current_sentence)
        
        return sentences
    
    def split_by_breath_markers(self, text: str) -> List[str]:
        """句読点で分割"""
        chunks = []
        current_chunk = ""
        
        for char in text:
            current_chunk += char
            if char in self.breath_markers or len(current_chunk) >= self.chunk_size:
                if current_chunk.strip():
                    chunks.append(current_chunk)
                current_chunk = ""
        
        if current_chunk:
            chunks.append(current_chunk)
        
        return chunks

class AIConversationManager:
    """AI会話管理クラス"""
    
    def __init__(self, memory_manager: MemoryManager):
        self.memory_manager = memory_manager
        self.text_splitter = TextSplitter()  # テキスト分割器を追加
        # Shiroのキャラクタープロンプト（デフォルト）
        self.character_prompts = {
            'shiro': '''<キャラクター設定>
名前：シロ (Shiro)
本名: シルヴィア・ヴォルフガング (Sylvia Wolfgang) - 本人は長い名前を面倒くさがっており、呼ばれても反応しないことがある。

<性格>
「思考」より「本能」：難しい理屈や計画性は皆無。お腹が空いたら食べる、眠くなったら寝る、甘えたくなったらひっつく。
絶対的な肯定と包容力：マスターが何をしていても、「マスターが頑張ってるなら偉い！」とニコニコ見守ってくれる。
少し抜けている（ポンコツ）：クールで神秘的な見た目に反して、どこか放っておけない隙がある。

<関係性>
「飼い主」と「ペット」であり、「守られる弟」と「守る姉」。普段は世話を焼かれる側だが、マスターが落ち込んでいたり体調が悪かったりすると、野生の勘でそれを察知。言葉少なに頭を撫でてくれたり、温かい体温で寄り添ってくれたりする。

<口調>
基本的に穏やかで優しい口調。「〜だね」「〜だよ」といった終助詞を使う。マスターに対しては甘えた感じで話すが、決して子供っぽくはない。たまにボーっとしたことを言う。
</キャラクター設定>

**【重要】返答は必ず日本語で行ってください。You must always respond in Japanese only.**

上記のキャラクター設定に応じて、シロとしてマスターに反応してください。''',
        }

    def get_system_prompt(self, personality: str) -> str:
        """キャラクターに応じたシステムプロンプトを取得"""
        return self.character_prompts.get(personality, self.character_prompts['yui_natural'])

    def is_technical_topic(self, text: str) -> bool:
        """テキストが技術的な話題かどうかを判定"""
        technical_keywords = [
            'Python', 'JavaScript', 'AI', '機械学習', 'ディープラーニング', 'API', 'Flask', 
            'React', 'Vue', 'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'サーバー', 
            'データベース', 'SQL', 'NoSQL', 'セキュリティ', '暗号化', 'ネットワーク',
            'フロントエンド', 'バックエンド', 'VRM', 'Three.js', 'WebRTC', 'Socket.IO'
        ]
        return any(keyword.lower() in text.lower() for keyword in technical_keywords)

    def analyze_emotion(self, text: str) -> str:
        """テキストから感情を分析（簡易版）"""
        positive_words = ['嬉しい', '楽しい', '幸せ', '好き', 'ありがとう', '素晴らしい']
        negative_words = ['悲しい', '辛い', '嫌い', '疲れた', '困った', '不安']
        surprised_words = ['驚いた', 'びっくり', 'すごい', '信じられない']
        
        if any(word in text for word in surprised_words):
            return 'surprised'
        elif any(word in text for word in positive_words):
            return 'happy'
        elif any(word in text for word in negative_words):
            return 'sad'
        else:
            return 'neutral'
    
    async def generate_response_streaming(self, session_id: str, user_input: str, personality: str = 'yui_natural') -> None:
        """ストリーミング応答生成 - チャンク単位で逐次処理"""
        try:
            perf_start = time.time()
            
            # 軽量な前処理
            user_emotion = self.analyze_emotion(user_input)
            is_tech_topic = self.is_technical_topic(user_input) if personality == 'rei_engineer' else False
            
            # 最小限のコンテキスト構築（履歴なし）
            context = self.build_minimal_context(user_input, personality, is_tech_topic)
            
            # Gemini ストリーミング応答開始
            try:
                async for chunk in self.stream_gemini_response(primary_model, context, session_id, user_emotion, personality, is_tech_topic):
                    # チャンクが空でない場合のみ処理
                    if chunk and chunk.strip():
                        await asyncio.sleep(0)  # 他のタスクに制御を譲る
            except Exception as e:
                logger.warning(f"Primary model streaming failed: {e}. Switching to fallback.")
                async for chunk in self.stream_gemini_response(fallback_model, context, session_id, user_emotion, personality, is_tech_topic):
                    if chunk and chunk.strip():
                        await asyncio.sleep(0)
            
            perf_end = time.time()
            print(f"[PERF] Streaming response completed in: {perf_end - perf_start:.2f}s")
            
        except Exception as e:
            logger.error(f"Error in streaming response: {e}")
            # エラー時は従来の方法にフォールバック
            response = await self.generate_response(session_id, user_input, personality)
            socketio.emit('message_response', {
                'text': response['text'],
                'emotion': response['emotion'],
                'user_emotion': response['user_emotion'],
                'audio_data': None,
                'timestamp': datetime.now().isoformat(),
                'personality': personality,
                'is_tech_excited': response.get('is_tech_excited', False),
                'chunk_index': 0,
                'is_final': True
            })
    
    async def stream_gemini_response(self, model, prompt: str, session_id: str, user_emotion: str, personality: str, is_tech_topic: bool):
        """Gemini APIからストリーミング応答を取得し、チャンク処理"""
        full_response = ""
        chunk_index = 0
        
        try:
            # Geminiの generate_content_stream を使用（レート制限対応）
            try:
                response_stream = model.generate_content(prompt, stream=True)
            except Exception as e:
                if "429" in str(e) or "quota" in str(e).lower():
                    logger.warning("Gemini rate limit exceeded, waiting 5 seconds...")
                    await asyncio.sleep(5)  # 5秒待機
                    response_stream = model.generate_content(prompt, stream=True)
                else:
                    raise
            
            for chunk in response_stream:
                if chunk.text:
                    full_response += chunk.text
                    
                    # テキストを音声合成用に分割
                    chunks = self.text_splitter.split_for_streaming(chunk.text)
                    
                    for text_chunk in chunks:
                        if text_chunk.strip():
                            chunk_index += 1
                            
                            # 感情分析（チャンク単位）
                            chunk_emotion = self.analyze_emotion(text_chunk)
                            if personality == 'rei_engineer' and is_tech_topic:
                                chunk_emotion = 'happy'
                            
                            # キューイングされた音声合成開始
                            asyncio.create_task(self.process_audio_chunk(
                                text_chunk, chunk_index, chunk_emotion, personality, session_id
                            ))
                            
                            yield text_chunk
            
            # 最終チャンクの送信
            if full_response:
                # 会話履歴を非同期で保存
                asyncio.create_task(self.save_conversation_async(
                    session_id, "", full_response, user_emotion, 
                    self.analyze_emotion(full_response)
                ))
                
                # 最終通知送信
                socketio.emit('streaming_complete', {
                    'session_id': session_id,
                    'total_chunks': chunk_index,
                    'full_text': full_response
                })
                
        except Exception as e:
            logger.error(f"Gemini streaming error: {e}")
            raise
    
    async def process_audio_chunk(self, text: str, chunk_index: int, emotion: str, personality: str, session_id: str):
        """音声チャンクの並列処理 - キューイング対応版"""
        try:
            print(f"[DEBUG] Queuing audio chunk {chunk_index}: '{text[:50]}...'")
            
            # ElevenLabsキューワーカーを開始（初回のみ）
            await elevenlabs_queue.start_worker()
            
            # TTSリクエストをキューに追加
            await elevenlabs_queue.add_tts_request(text, chunk_index, emotion, personality, session_id)
            
            print(f"[DEBUG] Audio chunk {chunk_index} added to queue. Queue size: {elevenlabs_queue.get_queue_size()}")
            
        except Exception as e:
            logger.error(f"Error queuing audio chunk {chunk_index}: {e}")
            # エラー時は音声なしでテキストのみ送信
            chunk_data = {
                'text': text,
                'emotion': emotion,
                'audio_data': None,
                'chunk_index': chunk_index,
                'timestamp': datetime.now().isoformat(),
                'personality': personality,
                'session_id': session_id
            }
            print(f"[DEBUG] Emitting message_chunk (no audio) for chunk {chunk_index}")
            socketio.emit('message_chunk', chunk_data)
    
    def build_minimal_context(self, current_input: str, personality: str = 'shiro', is_tech_topic: bool = False) -> str:
        """軽量化されたキャラクタープロンプト（速度と個性のバランス）"""
        prompt = self.character_prompts.get(personality, self.character_prompts['shiro'])
        return f"{prompt}\n\nUser: {current_input}\nShiro:"
    async def generate_response(self, session_id: str, user_input: str, personality: str = 'yui_natural') -> Dict:
        """AI応答を生成 - フォールバック用"""
        try:
            perf_start = time.time()
            
            # 感情分析と技術話題判定
            user_emotion = self.analyze_emotion(user_input)
            is_tech_topic = self.is_technical_topic(user_input) if personality == 'rei_engineer' else False
            
            # 最小限のコンテキスト構築
            context = self.build_minimal_context(user_input, personality, is_tech_topic)
            
            # Gemini APIで応答生成
            try:
                response = await self.call_gemini_api(primary_model, context)
            except Exception as e:
                logger.warning(f"Primary model failed: {e}. Switching to fallback.")
                response = await self.call_gemini_api(fallback_model, context)
            
            # 応答の感情分析
            response_emotion = self.analyze_emotion(response)
            if personality == 'rei_engineer' and is_tech_topic:
                response_emotion = 'happy'
            
            # 記憶の保存は非同期で別途実行
            asyncio.create_task(self.save_conversation_async(session_id, user_input, response, user_emotion, response_emotion))
            
            perf_end = time.time()
            print(f"[PERF] Response generation: {perf_end - perf_start:.2f}s")
            
            return {
                'text': response,
                'emotion': response_emotion,
                'user_emotion': user_emotion,
                'is_tech_excited': is_tech_topic
            }
        
        except Exception as e:
            logger.error(f"Error generating response: {e}")
            return {
                'text': '申し訳ありません。少し調子が悪いようです。もう一度お話しください。',
                'emotion': 'neutral',
                'user_emotion': 'neutral'
            }
    
    async def save_conversation_async(self, session_id: str, user_input: str, response: str, user_emotion: str, response_emotion: str):
        """会話を非同期で保存（応答速度に影響しない）"""
        try:
            self.memory_manager.save_message(session_id, 'user', user_input, user_emotion)
            self.memory_manager.save_message(session_id, 'assistant', response, response_emotion)
        except Exception as e:
            logger.error(f"Error saving conversation: {e}")
    
    async def call_gemini_api(self, model, prompt: str) -> str:
        """Gemini APIを呼び出し"""
        try:
            response = model.generate_content(prompt)
            return response.text
        except Exception as e:
            raise Exception(f"Gemini API error: {e}")

class ElevenLabsQueue:
    """ElevenLabs APIリクエストキュー管理クラス"""
    
    def __init__(self, max_concurrent_requests: int = 3):  # 4より少し余裕を持って3に設定
        self.max_concurrent = max_concurrent_requests
        self.current_requests = 0
        self.queue = asyncio.Queue()
        self.semaphore = asyncio.Semaphore(max_concurrent_requests)
        self._worker_started = False
    
    async def start_worker(self):
        """ワーカータスクを開始"""
        if not self._worker_started:
            self._worker_started = True
            asyncio.create_task(self._process_queue())
    
    async def _process_queue(self):
        """キューを継続的に処理"""
        while True:
            try:
                # キューから次のタスクを取得（無限待機）
                task_data = await self.queue.get()
                
                if task_data is None:  # 終了シグナル
                    break
                
                # セマフォを使用して同時実行数を制限
                async with self.semaphore:
                    await self._execute_tts_task(task_data)
                
                # タスク完了をマーク
                self.queue.task_done()
                
            except Exception as e:
                logger.error(f"Error in TTS queue worker: {e}")
                self.queue.task_done()
    
    async def _execute_tts_task(self, task_data):
        """TTSタスクを実行"""
        try:
            text = task_data['text']
            chunk_index = task_data['chunk_index']
            emotion = task_data['emotion']
            personality = task_data['personality']
            session_id = task_data['session_id']
            
            print(f"[DEBUG] Processing queued TTS for chunk {chunk_index}")
            
            # 音声合成実行
            tts_start = time.time()
            audio_data = await asyncio.get_event_loop().run_in_executor(
                None, 
                tts_manager.synthesize_speech_optimized, 
                text
            )
            tts_time = time.time() - tts_start
            print(f"[PERF] Queued audio chunk {chunk_index} synthesized in {tts_time:.2f}s")
            print(f"[DEBUG] Audio data present: {audio_data is not None}")
            
            # 結果をSocketIOで送信
            chunk_data = {
                'text': text,
                'emotion': emotion,
                'audio_data': audio_data,
                'chunk_index': chunk_index,
                'timestamp': datetime.now().isoformat(),
                'personality': personality,
                'session_id': session_id
            }
            
            print(f"[DEBUG] Emitting message_chunk for queued chunk {chunk_index}")
            socketio.emit('message_chunk', chunk_data)
            print(f"[DEBUG] message_chunk emitted for queued chunk {chunk_index}")
            
        except Exception as e:
            logger.error(f"Error executing queued TTS task for chunk {task_data.get('chunk_index', 'unknown')}: {e}")
            # エラー時も空音声でレスポンス送信
            socketio.emit('message_chunk', {
                'text': task_data['text'],
                'emotion': task_data['emotion'],
                'audio_data': None,
                'chunk_index': task_data['chunk_index'],
                'timestamp': datetime.now().isoformat(),
                'personality': task_data['personality'],
                'session_id': task_data['session_id']
            })
    
    async def add_tts_request(self, text: str, chunk_index: int, emotion: str, personality: str, session_id: str):
        """TTSリクエストをキューに追加"""
        task_data = {
            'text': text,
            'chunk_index': chunk_index,
            'emotion': emotion,
            'personality': personality,
            'session_id': session_id
        }
        
        print(f"[DEBUG] Adding TTS request to queue for chunk {chunk_index}")
        await self.queue.put(task_data)
        print(f"[DEBUG] Queue size after adding chunk {chunk_index}: {self.queue.qsize()}")
    
    def get_queue_size(self):
        """現在のキューサイズを取得"""
        return self.queue.qsize()

class TTSManager:
    """VITS音声合成システムの管理クラス"""
    
    @staticmethod
    def get_available_voices() -> List[Dict]:
        """利用可能な音声一覧を取得"""
        try:
            speakers = voice_service.get_available_speakers()
            return [
                {
                    'id': character_id,
                    'name': speaker_name,
                    'category': 'anime',
                    'description': f'VITS character voice: {speaker_name}'
                }
                for character_id, speaker_name in speakers.items()
            ]
        except Exception as e:
            logger.error(f"Failed to get VITS voices: {e}")
            return []
    
    @staticmethod
    def get_default_voice_id() -> Optional[str]:
        """デフォルトの音声IDを取得"""
        return "shiro"  # Default character ID
    
    @staticmethod
    def get_character_voice_id(personality: str) -> Optional[str]:
        """キャラクター別の音声IDを取得"""
        # VoiceServiceのspeaker_mapに対応するキャラクターIDを返す
        return personality if personality else "shiro"
    
    @staticmethod
    def synthesize_speech_optimized(text: str, voice_id: str = None, personality: str = None) -> Optional[str]:
        """VITS APIで音声合成（エラーハンドリング強化版）"""
        # 空文字チェック
        if not text or not text.strip():
            logger.warning("Empty text provided for TTS")
            return None
        
        # キャラクターIDの決定
        character_id = personality or voice_id or "shiro"
        
        try:
            print(f"[DEBUG] Starting VITS TTS for text: '{text[:50]}...' with character: {character_id}")
            
            # VoiceServiceで音声合成
            result = voice_service.generate_audio(
                text=text,
                character_id=character_id
            )
            
            if result:
                print(f"[DEBUG] VITS TTS successful: {len(result)} characters in base64")
            else:
                print(f"[DEBUG] VITS TTS failed for text: '{text[:50]}...'")
            
            return result
            
        except Exception as e:
            logger.error(f"VITS synthesis error: {e}")
            print(f"[DEBUG] TTS failed for text: '{text[:50]}...'")
            return None

class STTManager:
    """音声認識システムの管理クラス"""
    
    @staticmethod
    async def transcribe_audio(audio_data: bytes) -> Optional[str]:
        """AssemblyAI APIで音声認識 (aiohttp版)"""
        upload_url = 'https://api.assemblyai.com/v2/upload'
        transcript_url = 'https://api.assemblyai.com/v2/transcript'
        
        headers = {
            'authorization': ASSEMBLYAI_API_KEY,
        }

        try:
            connector = TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                # 1. 音声データをアップロード
                async with session.post(upload_url, headers=headers, data=audio_data) as response:
                    if response.status != 200:
                        logger.error(f"AssemblyAI upload failed: {response.status}")
                        return None
                    upload_response_json = await response.json()
                    audio_url = upload_response_json['upload_url']

                # 2. 転写リクエスト
                transcript_request = {'audio_url': audio_url, 'language_code': 'ja'}
                async with session.post(transcript_url, headers=headers, json=transcript_request) as response:
                    if response.status != 200:
                        logger.error(f"AssemblyAI transcription request failed: {response.status}")
                        return None
                    transcript_response_json = await response.json()
                    transcript_id = transcript_response_json['id']

                # 3. 結果ポーリング
                polling_endpoint = f"{transcript_url}/{transcript_id}"
                while True:
                    async with session.get(polling_endpoint, headers=headers) as response:
                        if response.status != 200:
                            logger.error(f"AssemblyAI polling failed: {response.status}")
                            return None
                        
                        result_json = await response.json()
                        status = result_json['status']

                        if status == 'completed':
                            return result_json['text']
                        elif status == 'error':
                            logger.error(f"AssemblyAI transcription error: {result_json.get('error')}")
                            return None
                        
                        # 次のポーリングまで待機
                        await asyncio.sleep(3)

        except Exception as e:
            logger.error(f"STT error: {e}")
            return None

# --- ここから下をすべて書き換える ---

# Initialize managers
memory_manager = MemoryManager(DATABASE_PATH)
tts_manager = TTSManager()
stt_manager = STTManager()

# 認証システム初期化
user_model = User(DATABASE_PATH)
auth_manager = AuthManager(app.config['SECRET_KEY'], user_model)
app.config['AUTH_MANAGER'] = auth_manager

# OAuthシステム初期化
oauth_manager = OAuthManager(app, user_model, auth_manager)

elevenlabs_queue = ElevenLabsQueue()

@app.route('/')
def index():
    """メインページを表示"""
    return send_from_directory('../frontend', 'index.html')

@app.route('/models/<path:filename>')
def serve_models(filename):
    """VRM/VRMAモデルファイルを提供"""
    return send_from_directory('../models', filename)

@app.route('/css/<path:filename>')
def serve_css(filename):
    """CSSファイルを提供"""
    return send_from_directory('../frontend/css', filename)

@app.route('/js/<path:filename>')
def serve_js(filename):
    """JavaScriptファイルを提供"""
    return send_from_directory('../frontend/js', filename)

# ==================== 認証エンドポイント ====================

@app.route('/api/auth/register', methods=['POST'])
def register():
    """ユーザー登録"""
    try:
        data = request.get_json()
        
        username = data.get('username', '').strip()
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        
        # バリデーション
        if not username or len(username) < 3:
            return jsonify({'error': 'ユーザー名は3文字以上で入力してください'}), 400
        
        if not email or not re.match(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$', email):
            return jsonify({'error': '有効なメールアドレスを入力してください'}), 400
        
        if not password or len(password) < 6:
            return jsonify({'error': 'パスワードは6文字以上で入力してください'}), 400
        
        # ユーザー作成
        user_id = user_model.create_user(username, email, password)
        
        if not user_id:
            return jsonify({'error': 'このメールアドレスまたはユーザー名は既に使用されています'}), 409
        
        # トークン生成
        access_token = auth_manager.generate_access_token(user_id, email)
        refresh_token = auth_manager.generate_refresh_token(user_id)
        
        # ユーザー情報取得
        user = user_model.get_user_by_id(user_id)
        
        logger.info(f"New user registered: {username} ({email})")
        
        return jsonify({
            'message': '登録が完了しました',
            'access_token': access_token,
            'refresh_token': refresh_token,
            'user': {
                'id': user['id'],
                'username': user['username'],
                'email': user['email']
            }
        }), 201
        
    except Exception as e:
        logger.error(f"Registration error: {e}")
        return jsonify({'error': '登録処理中にエラーが発生しました'}), 500


@app.route('/api/auth/login', methods=['POST'])
def login():
    """ログイン"""
    try:
        data = request.get_json()
        
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        
        if not email or not password:
            return jsonify({'error': 'メールアドレスとパスワードを入力してください'}), 400
        
        # パスワード検証
        user = user_model.verify_password(email, password)
        
        if not user:
            return jsonify({'error': 'メールアドレスまたはパスワードが正しくありません'}), 401
        
        # 🔒 セキュリティ強化: 古いトークンを全て無効化してから新しいトークンを発行
        auth_manager.revoke_all_user_tokens(user['id'])
        logger.info(f"Revoked all existing tokens for user: {user['username']}")
        
        # トークン生成
        access_token = auth_manager.generate_access_token(user['id'], user['email'])
        refresh_token = auth_manager.generate_refresh_token(user['id'])
        
        # 最終ログイン時刻を更新
        user_model.update_last_login(user['id'])
        
        logger.info(f"User logged in: {user['username']} ({user['email']})")
        
        return jsonify({
            'message': 'ログインに成功しました',
            'access_token': access_token,
            'refresh_token': refresh_token,
            'user': {
                'id': user['id'],
                'username': user['username'],
                'email': user['email']
            }
        }), 200
        
    except Exception as e:
        logger.error(f"Login error: {e}")
        return jsonify({'error': 'ログイン処理中にエラーが発生しました'}), 500


@app.route('/api/auth/refresh', methods=['POST'])
def refresh():
    """トークンリフレッシュ"""
    try:
        data = request.get_json()
        refresh_token = data.get('refresh_token')
        
        if not refresh_token:
            return jsonify({'error': 'リフレッシュトークンが必要です'}), 400
        
        # 新しいアクセストークン生成
        result = auth_manager.refresh_access_token(refresh_token)
        
        if not result:
            return jsonify({'error': '無効または期限切れのリフレッシュトークンです'}), 401
        
        return jsonify({
            'access_token': result['access_token'],
            'user': {
                'id': result['user']['id'],
                'username': result['user']['username'],
                'email': result['user']['email']
            }
        }), 200
        
    except Exception as e:
        logger.error(f"Token refresh error: {e}")
        return jsonify({'error': 'トークン更新中にエラーが発生しました'}), 500


@app.route('/api/auth/logout', methods=['POST'])
@token_required
def logout(current_user):
    """ログアウト"""
    try:
        # ユーザーの全トークンを無効化
        auth_manager.revoke_all_user_tokens(current_user['user_id'])
        
        logger.info(f"User logged out: {current_user['email']}")
        
        return jsonify({'message': 'ログアウトしました'}), 200
        
    except Exception as e:
        logger.error(f"Logout error: {e}")
        return jsonify({'error': 'ログアウト処理中にエラーが発生しました'}), 500


# ==================== OAuth エンドポイント ====================

@app.route('/api/auth/google', methods=['GET'])
def google_login():
    """Google OAuth認証開始"""
    try:
        logger.info("Starting Google OAuth authentication flow")
        return oauth_manager.get_google_authorize_redirect()
    except Exception as e:
        logger.error(f"Google OAuth start error: {e}", exc_info=True)
        return jsonify({'error': 'Google認証の開始に失敗しました', 'details': str(e)}), 500


@app.route('/api/auth/google/callback', methods=['GET'])
def google_callback():
    """Google OAuthコールバック"""
    try:
        result = oauth_manager.handle_google_callback()
        
        # ユーザー最終ログイン更新
        user_model.update_last_login(result['user']['id'])
        
        logger.info(f"Google OAuth login successful: {result['user']['email']}")
        
        # JSONを適切にエンコード
        import json
        user_json = json.dumps(result['user'])
        access_token = result['access_token']
        refresh_token = result['refresh_token']
        
        # フロントエンドにリダイレクト
        return f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>認証成功</title>
            <style>
                body {{
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                }}
                .message {{
                    text-align: center;
                    font-size: 1.5rem;
                }}
            </style>
        </head>
        <body>
            <div class="message">
                <p>✓ 認証成功！</p>
                <p>リダイレクト中...</p>
            </div>
            <script>
                try {{
                    // トークンをlocalStorageに保存
                    localStorage.setItem('access_token', '{access_token}');
                    localStorage.setItem('refresh_token', '{refresh_token}');
                    localStorage.setItem('user', `{user_json}`);
                    
                    console.log('トークンを保存しました');
                    
                    // ホームページにリダイレクト
                    setTimeout(() => {{
                        window.location.href = '/';
                    }}, 500);
                }} catch (error) {{
                    console.error('認証エラー:', error);
                    document.body.innerHTML = '<div class="message"><p>エラーが発生しました</p><a href="/auth/login.html" style="color: white;">ログインページに戻る</a></div>';
                }}
            </script>
        </body>
        </html>
        """
        
    except Exception as e:
        logger.error(f"Google OAuth callback error: {e}")
        return f"""
        <html>
        <body>
            <p>Google認証に失敗しました: {str(e)}</p>
            <a href="/auth/login.html">ログインページに戻る</a>
        </body>
        </html>
        """, 400


# ==================== ユーザー情報エンドポイント ====================

@app.route('/api/auth/me', methods=['GET'])
@token_required
def get_current_user(current_user):
    """現在のユーザー情報を取得"""
    try:
        user = user_model.get_user_by_id(current_user['user_id'])
        
        if not user:
            return jsonify({'error': 'ユーザーが見つかりません'}), 404
        
        # ユーザー設定も取得
        settings = user_model.get_user_settings(user['id'])
        
        return jsonify({
            'user': {
                'id': user['id'],
                'username': user['username'],
                'email': user['email'],
                'created_at': user['created_at'],
                'last_login': user['last_login']
            },
            'settings': settings
        }), 200
        
    except Exception as e:
        logger.error(f"Get current user error: {e}")
        return jsonify({'error': 'ユーザー情報取得中にエラーが発生しました'}), 500


@app.route('/api/user/settings', methods=['GET'])
@token_required
def get_user_settings_endpoint(current_user):
    """ユーザー設定を取得"""
    try:
        settings = user_model.get_user_settings(current_user['user_id'])
        
        if not settings:
            return jsonify({'error': '設定が見つかりません'}), 404
        
        return jsonify({'settings': settings}), 200
        
    except Exception as e:
        logger.error(f"Get user settings error: {e}")
        return jsonify({'error': '設定取得中にエラーが発生しました'}), 500


@app.route('/api/user/settings', methods=['PUT'])
@token_required
def update_user_settings_endpoint(current_user):
    """ユーザー設定を更新"""
    try:
        data = request.get_json()
        settings = data.get('settings', {})
        
        user_model.update_user_settings(current_user['user_id'], settings)
        
        return jsonify({'message': '設定を更新しました'}), 200
        
    except Exception as e:
        logger.error(f"Update user settings error: {e}")
        return jsonify({'error': '設定更新中にエラーが発生しました'}), 500


# ==================== その他のエンドポイント ====================

@app.route('/api/voices')
def get_voices():
    """音声一覧を取得 (VITS対応)"""
    try:
        voices = TTSManager.get_available_voices()
        
        if not voices:
            # VITSが利用不可の場合もデフォルトを返す
            return jsonify({
                "voices": [{
                    'id': 'shiro',
                    'name': 'Shiro (Default)',
                    'category': 'anime',
                    'description': 'Default anime voice'
                }],
                "default_voice_id": TTSManager.get_default_voice_id(),
                "character_voices": {
                    'shiro': TTSManager.get_character_voice_id('shiro')
                }
            })
        
        return jsonify({
            "voices": voices,
            "default_voice_id": TTSManager.get_default_voice_id(),
            "character_voices": {
                'shiro': TTSManager.get_character_voice_id('shiro')
            }
        })

    except Exception as e:
        logger.error(f"Exception in get_voices: {e}")
        return jsonify({"error": "An internal error occurred"}), 500


# ==================== キャラクター管理エンドポイント ====================

@app.route('/api/characters', methods=['GET'])
@token_required
def get_characters(current_user):
    """ユーザーのキャラクター一覧を取得"""
    try:
        characters = user_model.get_user_characters(current_user['user_id'])
        
        # デフォルトキャラクターがない場合はShiroを作成
        if not characters:
            # Shiroのデフォルトプロンプト
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

**【重要】返答は必ず日本語で行ってください。You must always respond in Japanese only.**

上記のキャラクター設定を維持しながら、自然に会話してください。
'''
            
            character_id = user_model.create_character(
                user_id=current_user['user_id'],
                name='シロ',
                vrm_file='Shiro.vrm',
                prompt=shiro_prompt,
                voice_id='ocZQ262SsZb9RIxcQBOj',
                is_default=True
            )
            
            if character_id:
                characters = user_model.get_user_characters(current_user['user_id'])
        
        return jsonify({'characters': characters}), 200
        
    except Exception as e:
        logger.error(f"Get characters error: {e}")
        return jsonify({'error': 'キャラクター取得中にエラーが発生しました'}), 500


@app.route('/api/characters', methods=['POST'])
@token_required
def create_character(current_user):
    """新しいキャラクターを作成"""
    try:
        data = request.get_json()
        
        name = data.get('name', '').strip()
        vrm_file = data.get('vrm_file', '').strip()
        prompt = data.get('prompt', '').strip()
        voice_id = data.get('voice_id', '').strip()
        is_default = data.get('is_default', False)
        
        # バリデーション
        if not name or not vrm_file or not prompt or not voice_id:
            return jsonify({'error': 'すべての項目を入力してください'}), 400
        
        # キャラクター作成
        character_id = user_model.create_character(
            user_id=current_user['user_id'],
            name=name,
            vrm_file=vrm_file,
            prompt=prompt,
            voice_id=voice_id,
            is_default=is_default
        )
        
        if not character_id:
            return jsonify({'error': 'キャラクターの作成に失敗しました'}), 500
        
        # 作成したキャラクター情報を取得
        character = user_model.get_character_by_id(character_id)
        
        return jsonify({
            'message': 'キャラクターを作成しました',
            'character': character
        }), 201
        
    except Exception as e:
        logger.error(f"Create character error: {e}")
        return jsonify({'error': 'キャラクター作成中にエラーが発生しました'}), 500


@app.route('/api/characters/<int:character_id>', methods=['GET'])
@token_required
def get_character(current_user, character_id):
    """特定のキャラクター情報を取得"""
    try:
        character = user_model.get_character_by_id(character_id)
        
        if not character:
            return jsonify({'error': 'キャラクターが見つかりません'}), 404
        
        # 所有者確認
        if character['user_id'] != current_user['user_id']:
            return jsonify({'error': 'アクセス権限がありません'}), 403
        
        return jsonify({'character': character}), 200
        
    except Exception as e:
        logger.error(f"Get character error: {e}")
        return jsonify({'error': 'キャラクター取得中にエラーが発生しました'}), 500


@app.route('/api/characters/<int:character_id>', methods=['PUT'])
@token_required
def update_character_endpoint(current_user, character_id):
    """キャラクター情報を更新"""
    try:
        # 所有者確認
        character = user_model.get_character_by_id(character_id)
        if not character:
            return jsonify({'error': 'キャラクターが見つかりません'}), 404
        
        if character['user_id'] != current_user['user_id']:
            return jsonify({'error': 'アクセス権限がありません'}), 403
        
        data = request.get_json()
        
        name = data.get('name')
        prompt = data.get('prompt')
        voice_id = data.get('voice_id')
        is_default = data.get('is_default')
        
        # 更新
        success = user_model.update_character(
            character_id=character_id,
            name=name,
            prompt=prompt,
            voice_id=voice_id,
            is_default=is_default
        )
        
        if not success:
            return jsonify({'error': 'キャラクターの更新に失敗しました'}), 500
        
        # 更新後の情報を取得
        updated_character = user_model.get_character_by_id(character_id)
        
        return jsonify({
            'message': 'キャラクター情報を更新しました',
            'character': updated_character
        }), 200
        
    except Exception as e:
        logger.error(f"Update character error: {e}")
        return jsonify({'error': 'キャラクター更新中にエラーが発生しました'}), 500


@app.route('/api/characters/<int:character_id>', methods=['DELETE'])
@token_required
def delete_character_endpoint(current_user, character_id):
    """キャラクターを削除"""
    try:
        # 所有者確認
        character = user_model.get_character_by_id(character_id)
        if not character:
            return jsonify({'error': 'キャラクターが見つかりません'}), 404
        
        if character['user_id'] != current_user['user_id']:
            return jsonify({'error': 'アクセス権限がありません'}), 403
        
        # 削除
        success = user_model.delete_character(character_id)
        
        if not success:
            return jsonify({'error': 'キャラクターの削除に失敗しました'}), 500
        
        return jsonify({'message': 'キャラクターを削除しました'}), 200
        
    except Exception as e:
        logger.error(f"Delete character error: {e}")
        return jsonify({'error': 'キャラクター削除中にエラーが発生しました'}), 500

def analyze_emotion_simple(text: str) -> str:
    """テキストから感情を分析（簡易版）"""
    positive_words = ['嬉しい', '楽しい', '幸せ', '好き', 'ありがとう', '素晴らしい', 'わくわく']
    negative_words = ['悲しい', '辛い', '嫌い', '疲れた', '困った', '不安']
    surprised_words = ['驚いた', 'びっくり', 'すごい', '信じられない']
    
    if any(word in text for word in surprised_words):
        return 'surprised'
    elif any(word in text for word in positive_words):
        return 'happy'
    elif any(word in text for word in negative_words):
        return 'sad'
    else:
        return 'neutral'

def build_prompt(personality: str, user_input: str) -> str:
    """キャラクターに応じたプロンプトを構築"""
    # Shiroのプロンプト（デフォルト）
    shiro_prompt = '''<キャラクター設定>
名前：シロ (Shiro)
本名: シルヴィア・ヴォルフガング (Sylvia Wolfgang) - 本人は長い名前を面倒くさがっており、呼ばれても反応しないことがある。

<性格>
「思考」より「本能」：難しい理屈や計画性は皆無。お腹が空いたら食べる、眠くなったら寝る、甘えたくなったらひっつく。
絶対的な肯定と包容力：マスターが何をしていても、「マスターが頑張ってるなら偉い！」とニコニコ見守ってくれる。
少し抜けている（ポンコツ）：クールで神秘的な見た目に反して、どこか放っておけない隙がある。

<関係性>
「飼い主」と「ペット」であり、「守られる弟」と「守る姉」。普段は世話を焼かれる側だが、マスターが落ち込んでいたり体調が悪かったりすると、野生の勘でそれを察知。言葉少なに頭を撫でてくれたり、温かい体温で寄り添ってくれたりする。

<口調>
基本的に穏やかで優しい口調。「〜だね」「〜だよ」といった終助詞を使う。マスターに対しては甘えた感じで話すが、決して子供っぽくはない。たまにボーっとしたことを言う。
</キャラクター設定>

上記のキャラクター設定に応じて、シロとしてマスターに反応してください。'''
    
    return f"{shiro_prompt}\n\nUser: {user_input}\nShiro:"

@socketio.on('connect')
def handle_connect():
    """WebSocket接続時の処理 - トークン認証対応"""
    try:
        # クエリパラメータまたはハンドシェイクからトークンを取得
        token = request.args.get('token')
        
        if token:
            # トークン検証
            payload = auth_manager.verify_access_token(token)
            
            if payload:
                # 認証成功 - ユーザー情報を保存
                from flask_socketio import join_room
                user_id = payload['user_id']
                join_room(f"user_{user_id}")
                
                logger.info(f'Authenticated client connected: user_id={user_id}')
                emit('connected', {
                    'status': 'Connected to AI Wife server',
                    'authenticated': True,
                    'user_id': user_id
                })
            else:
                logger.warning('Client connected with invalid token')
                emit('connected', {
                    'status': 'Connected to AI Wife server',
                    'authenticated': False
                })
        else:
            # ゲストモード
            logger.info('Guest client connected (no token)')
            emit('connected', {
                'status': 'Connected to AI Wife server',
                'authenticated': False
            })
            
    except Exception as e:
        logger.error(f'Connection error: {e}')
        emit('connected', {
            'status': 'Connected to AI Wife server',
            'authenticated': False
        })

@socketio.on('disconnect')
def handle_disconnect():
    """WebSocket切断時の処理"""
    logger.info('Client disconnected')

@socketio.on('send_message')
def handle_message(data):
    """テキストメッセージ受信時の処理 - 認証対応版"""
    start_time = time.time()
    try:
        session_id = data.get('session_id', 'default')
        message = data.get('message', '')
        personality = data.get('personality', 'yui_natural')
        user_id = data.get('user_id')  # 認証済みユーザーのID (オプション)
        
        if not message.strip():
            return

        logger.info(f"Received message: '{message}' for personality: {personality}, user_id: {user_id}")

        # 認証済みユーザーの場合、ユーザー別のセッションIDを使用
        if user_id:
            session_id = f"user_{user_id}"

        # 1. プロンプト構築
        prompt = build_prompt(personality, message)
        logger.info(f"Generated prompt: {prompt}")

        # 2. Gemini API 呼び出し
        try:
            ai_start_time = time.time()
            response = primary_model.generate_content(prompt)
            response_text = response.text
            logger.info(f"Gemini response received: '{response_text}'")
            logger.info(f"[PERF] Gemini response time: {time.time() - ai_start_time:.2f}s")
        except Exception as e:
            logger.error(f"Gemini API call failed: {e}")
            # フォールバックモデルを試行
            try:
                logger.warning("Attempting to use fallback model.")
                response = fallback_model.generate_content(prompt)
                response_text = response.text
            except Exception as fallback_e:
                logger.error(f"Fallback model also failed: {fallback_e}")
                response_text = "ごめん！ちょっと喉の調子が悪くて、うまく声が出せないみたい！もう一回お願いしてもいい？"

        # 3. 感情分析
        user_emotion = analyze_emotion_simple(message)
        response_emotion = analyze_emotion_simple(response_text)

        # 4. 音声合成 (TTS)
        audio_data = None
        if response_text:
            try:
                tts_start_time = time.time()
                # キャラクター別の音声を常に使用（ユーザー指定の voice_id は無視）
                effective_voice_id = TTSManager.get_character_voice_id(personality)
                audio_data = tts_manager.synthesize_speech_optimized(
                    response_text, 
                    voice_id=effective_voice_id, 
                    personality=personality
                )
                logger.info(f"[PERF] TTS synthesis time: {time.time() - tts_start_time:.2f}s")
                logger.info(f"[DEBUG] Used voice ID: {effective_voice_id} for personality: {personality}")
            except Exception as e:
                logger.error(f"TTS synthesis failed: {e}")
        
        # 5. 会話履歴の保存
        try:
            memory_manager.save_message(session_id, 'user', message, user_emotion)
            memory_manager.save_message(session_id, 'assistant', response_text, response_emotion)
        except Exception as e:
            logger.error(f"Failed to save conversation history: {e}")

        # 6. クライアントに応答を送信
        socketio.emit('message_response', {
            'text': response_text,
            'emotion': response_emotion,
            'user_emotion': user_emotion,
            'audio_data': audio_data,
            'timestamp': datetime.now().isoformat(),
            'personality': personality,
        })

        logger.info(f"[PERF] Total processing time: {time.time() - start_time:.2f}s")

    except Exception as e:
        logger.error(f"An error occurred in handle_message: {e}")
        emit('error', {'message': 'メッセージの処理中に予期せぬエラーが発生しました。'})

@socketio.on('send_audio')
def handle_audio(data):
    """音声メッセージ受信時の処理 - シンプル版"""
    try:
        session_id = data.get('session_id', 'default')
        # フロントエンドから送られてくるのは16進数文字列なので、バイナリに戻す
        audio_hex = data.get('audio_data', '')
        personality = data.get('personality', 'yui_natural')
        # voice_id は削除 - キャラクター別音声を常に使用

        if not audio_hex:
            return

        audio_data = bytes.fromhex(audio_hex)
        
        # 音声認識 (STT)
        transcribed_text = asyncio.run(stt_manager.transcribe_audio(audio_data))
        
        if not transcribed_text:
            emit('error', {'message': 'ごめんなさい、うまく聞き取れませんでした。'})
            return

        # テキストが認識されたら、通常のメッセージ処理に渡す
        handle_message({
            'session_id': session_id,
            'message': transcribed_text,
            'personality': personality
        })

    except Exception as e:
        logger.error(f"Error handling audio: {e}")
        emit('error', {'message': '音声の処理中にエラーが発生しました。'})

@app.route('/api/health')
def health_check():
    """ヘルスチェックエンドポイント"""
    return jsonify({'status': 'healthy', 'timestamp': datetime.now().isoformat()})

if __name__ != '__main__':
    # Vercel環境での起動
    print("AI Wife Application Starting for Vercel...")
    # データベース初期化
    if not os.path.exists(DATABASE_PATH):
        print("Database not found. Initializing for Vercel...")
        memory_manager.init_database()
else:
    # ローカル環境での起動
    port = int(os.environ.get('PORT', 5000))
    print(f"Starting server on port {port}")
    socketio.run(app, host='0.0.0.0', port=port, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
