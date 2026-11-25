import React, { useState, useEffect, useRef } from 'react';

interface AudioPlayerBarProps {
  transcript: string;
  uploadedAudioUrl?: string | null;
  uploadedAudioName?: string;
  seekRequest?: { time: number; id: number } | null;
  onPlayingChange?: (isPlaying: boolean) => void;
  onTimeUpdate?: (seconds: number) => void;
}

export const AudioPlayerBar: React.FC<AudioPlayerBarProps> = ({
  transcript,
  uploadedAudioUrl,
  uploadedAudioName,
  seekRequest,
  onPlayingChange,
  onTimeUpdate,
}) => {
  const [sourceMode, setSourceMode] = useState<'original' | 'speech'>(
    uploadedAudioUrl ? 'original' : 'speech'
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [originalCurrentTime, setOriginalCurrentTime] = useState(0);
  const [originalDuration, setOriginalDuration] = useState(0);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string>('');
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(0);
  const [speechSentences, setSpeechSentences] = useState<string[]>([]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const isSpeechPausedRef = useRef(false);

  useEffect(() => {
    onPlayingChange?.(isPlaying);
  }, [isPlaying, onPlayingChange]);

  useEffect(() => {
    if (uploadedAudioUrl) {
      setSourceMode('original');
    } else if (transcript.trim()) {
      setSourceMode('speech');
    }
  }, [uploadedAudioUrl]);

  useEffect(() => {
    if (!seekRequest || !uploadedAudioUrl) return;
    setSourceMode('original');
    if (audioRef.current) {
      audioRef.current.currentTime = seekRequest.time;
      audioRef.current.playbackRate = playbackRate;
      setOriginalCurrentTime(seekRequest.time);
      onTimeUpdate?.(seekRequest.time);
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    }
  }, [seekRequest, uploadedAudioUrl]);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const updateVoices = () => {
        const available = window.speechSynthesis.getVoices();
        setVoices(available);
        if (available.length > 0 && !selectedVoiceURI) {
          const preferred =
            available.find(
              (v) =>
                (v.name.includes('Natural') ||
                  v.name.includes('Google') ||
                  v.name.includes('Samantha') ||
                  v.lang.startsWith('en')) &&
                v.lang.includes('en')
            ) || available[0];
          setSelectedVoiceURI(preferred.voiceURI);
        }
      };

      updateVoices();
      window.speechSynthesis.onvoiceschanged = updateVoices;
      return () => {
        window.speechSynthesis.onvoiceschanged = null;
      };
    }
  }, [selectedVoiceURI]);

  useEffect(() => {
    const cleaned = transcript.trim();
    if (!cleaned) {
      setSpeechSentences([]);
      return;
    }

    const rawSentences = cleaned
      .split(/(?<=[.?!।])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    setSpeechSentences(rawSentences.length > 0 ? rawSentences : [cleaned]);
    setCurrentSentenceIndex(0);
  }, [transcript]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setOriginalCurrentTime(audio.currentTime);
      onTimeUpdate?.(audio.currentTime);
    };
    const handleLoadedMetadata = () => {
      setOriginalDuration(audio.duration || 0);
    };
    const handleEnded = () => {
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [uploadedAudioUrl, onTimeUpdate]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speakSentence = (index: number) => {
    if (!('speechSynthesis' in window)) return;
    if (index >= speechSentences.length) {
      setIsPlaying(false);
      setCurrentSentenceIndex(0);
      return;
    }

    window.speechSynthesis.cancel();
    const sentence = speechSentences[index];
    const utterance = new SpeechSynthesisUtterance(sentence);
    utteranceRef.current = utterance;

    if (selectedVoiceURI) {
      const voice = voices.find((v) => v.voiceURI === selectedVoiceURI);
      if (voice) utterance.voice = voice;
    }

    utterance.rate = playbackRate;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      if (isSpeechPausedRef.current) return;
      if (index + 1 < speechSentences.length) {
        setCurrentSentenceIndex(index + 1);
        speakSentence(index + 1);
      } else {
        setIsPlaying(false);
        setCurrentSentenceIndex(0);
      }
    };

    utterance.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        console.error('Speech synthesis error:', e);
      }
      setIsPlaying(false);
    };

    setCurrentSentenceIndex(index);
    setIsPlaying(true);
    isSpeechPausedRef.current = false;
    window.speechSynthesis.speak(utterance);
  };

  const startPlayback = () => {
    if (sourceMode === 'original') {
      if (audioRef.current) {
        audioRef.current.playbackRate = playbackRate;
        audioRef.current
          .play()
          .then(() => setIsPlaying(true))
          .catch(console.error);
      }
    } else {
      if (speechSentences.length === 0) return;
      if (isSpeechPausedRef.current && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        isSpeechPausedRef.current = false;
        setIsPlaying(true);
      } else {
        speakSentence(currentSentenceIndex);
      }
    }
  };

  const pausePlayback = () => {
    if (sourceMode === 'original') {
      if (audioRef.current) {
        audioRef.current.pause();
        setIsPlaying(false);
      }
    } else if ('speechSynthesis' in window) {
      window.speechSynthesis.pause();
      isSpeechPausedRef.current = true;
      setIsPlaying(false);
    }
  };

  const stopPlayback = () => {
    if (sourceMode === 'original') {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        setOriginalCurrentTime(0);
        onTimeUpdate?.(0);
      }
    } else {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        isSpeechPausedRef.current = false;
      }
      setCurrentSentenceIndex(0);
    }
    setIsPlaying(false);
  };

  const togglePlayPause = () => {
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  };

  const handleSeekOriginal = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setOriginalCurrentTime(time);
    onTimeUpdate?.(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const handleSwitchMode = (mode: 'original' | 'speech') => {
    stopPlayback();
    setSourceMode(mode);
  };

  const formatSeconds = (sec: number): string => {
    if (isNaN(sec) || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const currentSentenceText = speechSentences[currentSentenceIndex] || speechSentences[0] || '';
  const speechProgressPercent =
    speechSentences.length > 0
      ? Math.round(((currentSentenceIndex + 1) / speechSentences.length) * 100)
      : 0;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
      {uploadedAudioUrl && (
        <audio ref={audioRef} src={uploadedAudioUrl} preload="metadata" />
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-100">Audio Playback</h3>
          <p className="text-xs text-slate-400 truncate mt-0.5">
            {sourceMode === 'original'
              ? uploadedAudioName || 'Uploaded audio track'
              : 'Text-to-speech transcript playback'}
          </p>
        </div>

        {uploadedAudioUrl && transcript.trim() && (
          <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 shrink-0">
            <button
              type="button"
              onClick={() => handleSwitchMode('original')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'original'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Original
            </button>
            <button
              type="button"
              onClick={() => handleSwitchMode('speech')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'speech'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Read Aloud
            </button>
          </div>
        )}
      </div>

      {sourceMode === 'original' ? (
        <div className="space-y-1.5">
          <input
            type="range"
            min={0}
            max={originalDuration || 100}
            step={0.1}
            value={originalCurrentTime}
            onChange={handleSeekOriginal}
            aria-label="Audio seek position"
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
          <div className="flex justify-between text-xs mono tabular-nums text-slate-400">
            <span>{formatSeconds(originalCurrentTime)}</span>
            <span>{formatSeconds(originalDuration)}</span>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs mono tabular-nums text-slate-400">
            <span>
              Line {speechSentences.length > 0 ? currentSentenceIndex + 1 : 0} / {speechSentences.length}
            </span>
            <span>{speechProgressPercent}%</span>
          </div>
          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="bg-emerald-500 h-full transition-all duration-200"
              style={{ width: `${speechProgressPercent}%` }}
            />
          </div>
          {currentSentenceText && (
            <p className="text-xs text-slate-300 leading-relaxed line-clamp-2 pt-1">
              {currentSentenceText}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlayPause}
            disabled={sourceMode === 'speech' ? speechSentences.length === 0 : !uploadedAudioUrl}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-medium rounded-lg transition-colors flex items-center gap-2 text-xs whitespace-nowrap"
          >
            {isPlaying ? (
              <>
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
                <span>Pause</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Play</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={stopPlayback}
            disabled={!isPlaying && originalCurrentTime === 0 && currentSentenceIndex === 0}
            className="p-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg border border-slate-700 transition-colors"
            title="Stop"
            aria-label="Stop playback"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h12v12H6z" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5">
            {[0.75, 1.0, 1.25, 1.5].map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => setPlaybackRate(rate)}
                className={`px-2 py-1 text-[11px] mono tabular-nums font-medium rounded-md transition-colors ${
                  playbackRate === rate
                    ? 'bg-slate-800 text-emerald-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>

          {sourceMode === 'speech' && voices.length > 0 && (
            <select
              value={selectedVoiceURI}
              onChange={(e) => {
                setSelectedVoiceURI(e.target.value);
                if (isPlaying) stopPlayback();
              }}
              className="bg-slate-950 border border-slate-800 text-xs text-slate-300 rounded-lg px-2 py-1.5 outline-none focus:ring-1 focus:ring-emerald-500 max-w-[140px] truncate"
              title="Select Voice"
            >
              {voices.slice(0, 15).map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
};
