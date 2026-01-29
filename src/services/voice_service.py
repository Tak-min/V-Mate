"""
Voice Service - ElevenLabs TTS Integration
High-quality text-to-speech using ElevenLabs API
"""

import os
import logging
import requests
import hashlib
import time
from typing import Optional
from pathlib import Path

# Configure logging
logger = logging.getLogger(__name__)


class VoiceService:
    """
    ElevenLabs-based Text-to-Speech service
    
    Features:
    - High-quality multilingual voice synthesis
    - Low latency with turbo model
    - File-based caching for generated audio
    """
    
    def __init__(self):
        """Initialize the ElevenLabs Voice Service"""
        
        # Get API key from environment
        self.api_key = os.getenv('ELEVENLABS_API_KEY')
        if not self.api_key:
            logger.error("ELEVENLABS_API_KEY not found in environment variables")
            raise ValueError("ElevenLabs API key is required")
        
        # ElevenLabs API endpoint
        self.base_url = "https://api.elevenlabs.io/v1"
        
        # Voice ID mapping for different characters
        self.voice_map = {
            "default": "21m00Tcm4TlvDq8ikWAM",  # Rachel - default voice
            "shiro": "21m00Tcm4TlvDq8ikWAM",    # Rachel - calm and clear
            "yui_natural": "EXAVITQu4vr4xnSDxMaL",  # Bella - warm and friendly
            "rei_engineer": "ErXwobaYiN019PkySvjV",  # Antoni - professional
        }
        
        # Model selection
        self.model = "eleven_turbo_v2_5"  # Low latency model
        # Alternative: "eleven_multilingual_v2" for higher quality
        
        # Output format
        self.output_format = "mp3_22050_32"  # Optimized for web playback
        
        # Audio output directory
        project_root = Path(__file__).parent.parent.parent
        self.audio_dir = project_root / "frontend" / "audio"
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"ElevenLabs VoiceService initialized")
        logger.info(f"Audio output directory: {self.audio_dir}")
        logger.info(f"Model: {self.model}")
    
    def generate_audio(
        self, 
        text: str, 
        character_id: str = "shiro",
        voice_id: Optional[str] = None,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
        use_speaker_boost: bool = True
    ) -> Optional[str]:
        """
        Generate audio from text using ElevenLabs API
        
        Args:
            text: Text to synthesize
            character_id: Character personality ID (maps to voice)
            voice_id: Optional explicit voice ID (overrides character_id)
            stability: Voice stability (0.0-1.0)
            similarity_boost: Voice similarity (0.0-1.0)
            style: Style exaggeration (0.0-1.0)
            use_speaker_boost: Enable speaker boost
        
        Returns:
            Relative URL path to the generated audio file (e.g., "/audio/abc123.mp3")
            or None on failure
        """
        # Validate input
        if not text or not text.strip():
            logger.warning("Empty text provided for TTS")
            return None
        
        # Determine voice ID
        if voice_id is None:
            voice_id = self.voice_map.get(character_id, self.voice_map["default"])
        
        logger.info(f"Generating audio for '{text[:50]}...' with voice: {voice_id}")
        
        # Generate unique filename based on text hash
        text_hash = hashlib.md5(text.encode()).hexdigest()
        filename = f"{text_hash}_{int(time.time())}.mp3"
        file_path = self.audio_dir / filename
        
        # Construct API URL
        url = f"{self.base_url}/text-to-speech/{voice_id}"
        
        # Request headers
        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": self.api_key
        }
        
        # Request payload
        payload = {
            "text": text,
            "model_id": self.model,
            "voice_settings": {
                "stability": stability,
                "similarity_boost": similarity_boost,
                "style": style,
                "use_speaker_boost": use_speaker_boost
            }
        }
        
        try:
            # Make API request
            response = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=30  # 30 seconds timeout
            )
            
            # Check response status
            response.raise_for_status()
            
            # Save audio file
            with open(file_path, 'wb') as f:
                f.write(response.content)
            
            logger.info(f"✓ Audio generated successfully: {filename} ({len(response.content)} bytes)")
            
            # Return relative URL path
            return f"/audio/{filename}"
            
        except requests.exceptions.Timeout:
            logger.error("ElevenLabs API request timed out")
            return None
            
        except requests.exceptions.HTTPError as e:
            status_code = e.response.status_code
            logger.error(f"ElevenLabs API returned HTTP {status_code}: {str(e)}")
            
            # Log response body for debugging
            try:
                error_detail = e.response.json()
                logger.error(f"Error details: {error_detail}")
            except:
                logger.error(f"Error response: {e.response.text}")
            
            return None
            
        except requests.exceptions.ConnectionError as e:
            logger.error(f"Connection failed to ElevenLabs API: {str(e)}")
            return None
            
        except Exception as e:
            logger.error(f"Unexpected error in TTS generation: {str(e)}")
            import traceback
            logger.debug(traceback.format_exc())
            return None
    
    def get_available_speakers(self) -> dict:
        """
        Get available character voice mappings
        
        Returns:
            Dictionary of character_id -> voice_name
        """
        return {
            "default": "Rachel (Default)",
            "shiro": "Rachel (Shiro)",
            "yui_natural": "Bella (Yui)",
            "rei_engineer": "Antoni (Rei)"
        }
    
    def cleanup_old_files(self, max_age_hours: int = 24):
        """
        Clean up old audio files to save disk space
        
        Args:
            max_age_hours: Maximum age of files to keep (in hours)
        """
        try:
            current_time = time.time()
            max_age_seconds = max_age_hours * 3600
            
            deleted_count = 0
            for file_path in self.audio_dir.glob("*.mp3"):
                file_age = current_time - file_path.stat().st_mtime
                
                if file_age > max_age_seconds:
                    file_path.unlink()
                    deleted_count += 1
            
            if deleted_count > 0:
                logger.info(f"Cleaned up {deleted_count} old audio files")
                
        except Exception as e:
            logger.error(f"Error during audio cleanup: {str(e)}")


# Singleton instance
_voice_service_instance = None


def get_voice_service(force_reinit: bool = False) -> VoiceService:
    """
    Get or create VoiceService singleton instance
    
    Args:
        force_reinit: Force recreation of the instance
    
    Returns:
        VoiceService instance
    """
    global _voice_service_instance
    
    if _voice_service_instance is None or force_reinit:
        _voice_service_instance = VoiceService()
    
    return _voice_service_instance
