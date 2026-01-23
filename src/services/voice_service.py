"""
Voice Service - Multi-Server VITS TTS with Robust Failover
Uses direct HTTP requests with automatic server switching for high availability
Supports both JSON-based and binary-direct response formats
"""

import requests
import logging
import base64
from typing import Optional, Dict, List

# Configure logging
logger = logging.getLogger(__name__)


class VoiceService:
    """
    Multi-server VITS-based Text-to-Speech service with automatic failover
    
    Features:
    - Multiple Hugging Face Spaces for redundancy
    - Automatic server switching on failure
    - Support for both JSON and binary response formats
    - No WebSocket dependency (pure HTTP)
    """
    
    # VITS Server endpoints in priority order (verified working servers only)
    VITS_SPACES = [
        # 1. SkyTNT (Most stable and fast) - CRITICAL: Use /api/predict
        {
            "url": "https://skytnt-moe-tts.hf.space/api/predict",
            "name": "skytnt-moe-tts",
            "type": "gradio_post",
            "fn_index": 0
        },
        # 2. Universal VITS (High quality but can be busy)
        {
            "url": "https://zomehwh-vits-models.hf.space/api/predict",
            "name": "zomehwh-vits-models",
            "type": "gradio_post",
            "fn_index": 1  # Japanese is index 1
        },
        # 3. K2-FSA (Backup)
        {
            "url": "https://k2-fsa-text-to-speech.hf.space/api/predict",
            "name": "k2-fsa-tts",
            "type": "gradio_post",
            "fn_index": 0
        },
    ]
    
    def __init__(self):
        """Initialize the Voice Service with multi-server support"""
        
        # Speaker mapping for character personalities
        self.speaker_map = {
            "default": "神里綾華",  # Kamisato Ayaka (Japanese)
            "shiro": "神里綾華",
        }
        
        # Default TTS parameters (optimized for Japanese)
        self.default_noise = 0.6
        self.default_noise_w = 0.668
        self.default_speed = 1.0
        self.default_length = 1.0
        self.default_language = "Japanese"
        
        # Request settings
        self.timeout = 10  # 10 seconds per request
        
        logger.info(f"VoiceService initialized with {len(self.VITS_SPACES)} backup servers")
    
    def generate_audio(
        self, 
        text: str, 
        character_id: str = "shiro",
        noise: Optional[float] = None,
        noise_w: Optional[float] = None,
        speed: Optional[float] = None,
        length: Optional[float] = None,
        language: Optional[str] = None
    ) -> Optional[str]:
        """
        Generate audio from text using VITS with automatic server failover
        
        Args:
            text: Text to synthesize
            character_id: Character personality ID (maps to speaker)
            noise: Noise parameter (default: 0.6)
            noise_w: Noise W parameter (default: 0.668)
            speed: Speed parameter (default: 1.0)
            length: Length parameter (default: 1.0)
            language: Language (default: "Japanese")
        
        Returns:
            Base64-encoded audio data URI (data:audio/wav;base64,...) or None on failure
        """
        # Validate input
        if not text or not text.strip():
            logger.warning("Empty text provided for TTS")
            return None
        
        # Get speaker name
        speaker_name = self.speaker_map.get(character_id, self.speaker_map["default"])
        
        # Use provided parameters or defaults
        noise = noise if noise is not None else self.default_noise
        noise_w = noise_w if noise_w is not None else self.default_noise_w
        speed = speed if speed is not None else self.default_speed
        length = length if length is not None else self.default_length
        language = language if language is not None else self.default_language
        
        logger.info(f"Generating audio for '{text[:50]}...' with speaker: {speaker_name}")
        
        # Try each Gradio server in order until one succeeds
        for idx, server in enumerate(self.VITS_SPACES):
            server_url = server["url"]
            server_name = server["name"]
            server_type = server["type"]
            fn_index = server.get("fn_index", 1)
            
            # Prepare payload for Gradio POST API
            payload = {
                "data": [
                    text,
                    speaker_name,
                    noise,
                    noise_w,
                    speed,
                    length,
                    language
                ],
                "fn_index": fn_index
            }
            
            try:
                logger.info(f"[Attempt {idx + 1}/{len(self.VITS_SPACES)}] Trying server: {server_name}")
                
                # Send POST request
                response = requests.post(
                    server_url,
                    json=payload,
                    timeout=self.timeout,
                    headers={"Content-Type": "application/json"}
                )
                
                # Check response status
                response.raise_for_status()
                
                # Parse response based on Content-Type
                audio_data = self._extract_audio_from_response(response, server_url, server_name, server_type)
                
                if audio_data:
                    logger.info(f"✓ Successfully generated audio from {server_name}: {len(audio_data)} bytes")
                    
                    # Encode to base64
                    audio_b64 = base64.b64encode(audio_data).decode('utf-8')
                    result_uri = f"data:audio/wav;base64,{audio_b64}"
                    
                    logger.info(f"Audio successfully encoded: {len(result_uri)} characters")
                    return result_uri
                else:
                    logger.warning(f"✗ Server {server_name} returned empty audio data")
                    continue
                    
            except requests.exceptions.Timeout:
                logger.warning(f"✗ Server {server_name} timed out after {self.timeout}s")
                continue
                
            except requests.exceptions.HTTPError as e:
                status_code = e.response.status_code
                logger.warning(f"✗ Server {server_name} returned HTTP {status_code}: {str(e)}")
                continue
                
            except requests.exceptions.ConnectionError as e:
                logger.warning(f"✗ Connection failed to {server_name}: {str(e)}")
                continue
                
            except Exception as e:
                logger.error(f"✗ Unexpected error with {server_name}: {str(e)}")
                import traceback
                logger.debug(traceback.format_exc())
                continue
        
        # All Gradio servers failed - try Artrajz Simple API as final fallback
        logger.warning(f"✗ All {len(self.VITS_SPACES)} Gradio servers failed")
        logger.info("[Final Fallback] Trying Artrajz Simple API (HTTP GET)...")
        
        try:
            # Artrajz Simple API uses HTTP GET with query parameters
            artrajz_url = "https://artrajz-vits-simple-api.hf.space/say"
            params = {
                "text": text,
                "lang": "jp",
                "speaker": speaker_name,
                "format": "wav",
                "noise": str(noise),
                "noisew": str(noise_w),
                "length": str(length)
            }
            
            logger.info(f"[Artrajz] GET {artrajz_url}")
            logger.debug(f"[Artrajz] Params: {params}")
            
            response = requests.get(
                artrajz_url,
                params=params,
                timeout=20  # Longer timeout for GET API
            )
            response.raise_for_status()
            
            # Artrajz returns audio binary directly
            if response.content and len(response.content) > 0:
                logger.info(f"✓ Artrajz Simple API succeeded: {len(response.content)} bytes")
                
                # Encode to base64
                audio_b64 = base64.b64encode(response.content).decode('utf-8')
                result_uri = f"data:audio/wav;base64,{audio_b64}"
                
                logger.info(f"Audio successfully encoded from Artrajz: {len(result_uri)} characters")
                return result_uri
            else:
                logger.error("✗ Artrajz returned empty content")
                
        except requests.exceptions.Timeout:
            logger.error("✗ Artrajz Simple API timed out")
        except requests.exceptions.HTTPError as e:
            logger.error(f"✗ Artrajz returned HTTP {e.response.status_code}: {str(e)}")
        except requests.exceptions.ConnectionError as e:
            logger.error(f"✗ Artrajz connection failed: {str(e)}")
        except Exception as e:
            logger.error(f"✗ Artrajz unexpected error: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
        
        # Absolutely all servers failed
        logger.error("✗ ALL TTS servers (Gradio + Artrajz) failed. TTS unavailable.")
        return None
    
    def _extract_audio_from_response(
        self, 
        response: requests.Response,
        server_url: str, 
        server_name: str,
        server_type: str
    ) -> Optional[bytes]:
        """
        Extract audio data from server response
        
        Handles two response formats:
        1. Binary direct: Content-Type is audio/* - return response.content
        2. JSON with file path: Parse JSON and download file
        
        Args:
            response: HTTP response object
            server_url: Server URL (for constructing file paths)
            server_name: Name of the server (for logging)
            server_type: Expected server type ("gradio_json" or "gradio_binary")
        
        Returns:
            Audio data as bytes, or None on failure
        """
        content_type = response.headers.get('Content-Type', '').lower()
        
        # Case 1: Binary audio response (direct)
        if 'audio/' in content_type:
            logger.info(f"[{server_name}] Received binary audio response ({content_type})")
            return response.content
        
        # Case 2: JSON response with file path
        try:
            result_data = response.json()
            logger.debug(f"[{server_name}] JSON response: {result_data}")
            
            # Gradio typically returns: {"data": [...]}
            if "data" in result_data and isinstance(result_data["data"], list):
                data_list = result_data["data"]
                
                # Audio info is usually in the second element
                if len(data_list) > 1:
                    audio_info = data_list[1]
                    logger.debug(f"[{server_name}] Audio info: {type(audio_info)} = {audio_info}")
                    
                    # Case 2A: Dictionary with file path
                    if isinstance(audio_info, dict):
                        download_url = None
                        
                        if "name" in audio_info:
                            # Construct full URL
                            base_url = '/'.join(server_url.split('/')[:3])  # Get https://domain.hf.space
                            file_path = audio_info["name"]
                            download_url = f"{base_url}/file={file_path}"
                        elif "url" in audio_info:
                            download_url = audio_info["url"]
                        
                        if download_url:
                            logger.info(f"[{server_name}] Downloading from: {download_url}")
                            audio_response = requests.get(download_url, timeout=self.timeout)
                            audio_response.raise_for_status()
                            return audio_response.content
                    
                    # Case 2B: Direct URL string
                    elif isinstance(audio_info, str):
                        if audio_info.startswith("http"):
                            logger.info(f"[{server_name}] Downloading from URL: {audio_info}")
                            audio_response = requests.get(audio_info, timeout=self.timeout)
                            audio_response.raise_for_status()
                            return audio_response.content
                        else:
                            # Relative path - construct URL
                            base_url = '/'.join(server_url.split('/')[:3])
                            download_url = f"{base_url}/file={audio_info}"
                            logger.info(f"[{server_name}] Downloading from: {download_url}")
                            audio_response = requests.get(download_url, timeout=self.timeout)
                            audio_response.raise_for_status()
                            return audio_response.content
                
                logger.warning(f"[{server_name}] Response data list too short: {len(data_list)}")
            else:
                logger.warning(f"[{server_name}] Unexpected JSON structure: {result_data}")
                
        except ValueError:
            # Not JSON - might be plain text or other format
            logger.warning(f"[{server_name}] Response is not JSON (Content-Type: {content_type})")
        
        return None
    
    def get_available_speakers(self) -> Dict[str, str]:
        """
        Get the available speaker mappings
        
        Returns:
            Dictionary mapping character IDs to speaker names
        """
        return self.speaker_map.copy()
    
    def set_speaker_for_character(self, character_id: str, speaker_name: str):
        """
        Map a character ID to a specific VITS speaker
        
        Args:
            character_id: Internal character identifier
            speaker_name: VITS model speaker name
        """
        self.speaker_map[character_id] = speaker_name
        logger.info(f"Mapped character '{character_id}' to speaker '{speaker_name}'")


# Singleton instance for global use
_voice_service_instance = None


def get_voice_service(force_reinit: bool = False) -> VoiceService:
    """
    Get or create the global VoiceService instance
    
    Args:
        force_reinit: Force recreation of the singleton instance
    
    Returns:
        VoiceService singleton instance
    """
    global _voice_service_instance
    if _voice_service_instance is None or force_reinit:
        logger.info("Creating new VoiceService instance")
        _voice_service_instance = VoiceService()
    return _voice_service_instance
