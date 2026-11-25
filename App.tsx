import React, { useState, useRef, useMemo, useEffect } from 'react';
import { TranscriptionResult, TranscriptSegment } from './types';
import { geminiService } from './services/geminiService';
import { AudioPlayerBar } from './components/AudioPlayerBar';

const SUPPORTED_AUDIO_REGEX = /\.(mp3|wav|wave|m4a|aac|ogg|webm|flac|wma|opus)$/i;

function parseTimeToSeconds(timeStr: string): number {
  const clean = String(timeStr || '00:00').trim().replace(',', '.');
  const parts = clean.split(':').map((p) => parseFloat(p) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

function toSrtTimestamp(t: string): string {
  const clean = t.trim().replace('.', ',');
  const [timePart, msPart] = clean.split(',');
  const parts = timePart.split(':').map((p) => p.trim().padStart(2, '0'));
  const ms = msPart ? msPart.padEnd(3, '0').slice(0, 3) : '000';
  if (parts.length === 2) {
    return `00:${parts[0]}:${parts[1]},${ms}`;
  }
  if (parts.length === 3) {
    return `${parts[0]}:${parts[1]}:${parts[2]},${ms}`;
  }
  return '00:00:00,000';
}

function formatMMSS(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function stripTimestampsFromText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.replace(
        /^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:(?:-|–|—|-->|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?))?\]?\)?\s*[:-]?\s*/i,
        ''
      )
    )
    .join('\n')
    .trim();
}

function parseSegmentsFromText(text: string): TranscriptSegment[] {
  if (!text.trim()) return [];
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rangeRegex =
    /^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:-|–|—|-->|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\)?\s*[:-]?\s*(.+)$/i;

  const matched: TranscriptSegment[] = [];
  for (const line of rawLines) {
    const m = line.match(rangeRegex);
    if (m) {
      matched.push({
        startTime: m[1].trim(),
        endTime: m[2].trim(),
        text: m[3].trim(),
      });
    }
  }

  if (matched.length > 0 && matched.length >= Math.ceil(rawLines.length / 2)) {
    return matched;
  }

  const sentences: string[] = [];
  rawLines.forEach((line) => {
    const cleaned = line.replace(/^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/, '');
    cleaned.split(/(?<=[.?!।])\s+/).forEach((s) => {
      const trimmed = s.trim();
      if (trimmed) sentences.push(trimmed);
    });
  });

  let currentSec = 0;
  return sentences.map((seg) => {
    const wordsCount = seg.split(/\s+/).length;
    const durationSec = Math.max(2, Math.min(7, Math.ceil(wordsCount * 0.4)));
    const startTime = formatMMSS(currentSec);
    const endTime = formatMMSS(currentSec + durationSec);
    currentSec += durationSec;
    return { startTime, endTime, text: seg };
  });
}

function convertToTimestampedText(text: string): string {
  if (!text.trim()) return '';
  if (/^\[\d{1,2}:\d{2}/.test(text.trim())) return text;
  const segments = parseSegmentsFromText(text);
  return segments.map((s) => `[${s.startTime} - ${s.endTime}] ${s.text}`).join('\n');
}

function convertToSRT(text: string): string {
  if (!text.trim()) return '';
  const segments = parseSegmentsFromText(text);
  return segments
    .map(
      (seg, idx) =>
        `${idx + 1}\n${toSrtTimestamp(seg.startTime)} --> ${toSrtTimestamp(seg.endTime)}\n${seg.text}`
    )
    .join('\n\n')
    .trim();
}

const App: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [isAudioDragging, setIsAudioDragging] = useState(false);

  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeMode, setTranscribeMode] = useState<'plain' | 'timestamps' | null>(null);
  const [streamingTranscript, setStreamingTranscript] = useState('');
  const [lastTranscription, setLastTranscription] = useState<TranscriptionResult | null>(null);
  const [transcriptText, setTranscriptText] = useState('');
  const [viewMode, setViewMode] = useState<'timestamps' | 'plain' | 'srt'>('timestamps');
  const [isEditingRaw, setIsEditingRaw] = useState(false);

  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [copiedState, setCopiedState] = useState(false);

  // Audio playback synchronization
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<{ time: number; id: number } | null>(null);

  useEffect(() => {
    return () => {
      if (audioPreviewUrl) {
        URL.revokeObjectURL(audioPreviewUrl);
      }
    };
  }, [audioPreviewUrl]);

  const handleAudioChange = (file: File) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !SUPPORTED_AUDIO_REGEX.test(file.name)) {
      setTranscribeError('Please select a valid audio file (MP3, WAV, M4A, AAC, OGG, WEBM, or FLAC).');
      return;
    }
    if (audioPreviewUrl) {
      URL.revokeObjectURL(audioPreviewUrl);
    }
    setAudioFile(file);
    setAudioPreviewUrl(URL.createObjectURL(file));
    setTranscribeError(null);
    setLastTranscription(null);
    setStreamingTranscript('');
    setCurrentPlaybackTime(0);
    setSeekRequest(null);
  };

  const handleClearAudio = () => {
    if (audioPreviewUrl) {
      URL.revokeObjectURL(audioPreviewUrl);
    }
    setAudioFile(null);
    setAudioPreviewUrl(null);
    setTranscribeError(null);
    setCurrentPlaybackTime(0);
    setSeekRequest(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleResetAll = () => {
    handleClearAudio();
    setTranscriptText('');
    setStreamingTranscript('');
    setLastTranscription(null);
    setIsEditingRaw(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsAudioDragging(true);
  };

  const handleDragLeave = () => {
    setIsAudioDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsAudioDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleAudioChange(e.dataTransfer.files[0]);
    }
  };

  const handleTranscribe = async (includeTimestamps: boolean) => {
    if (!audioFile) return;
    setIsTranscribing(true);
    setTranscribeMode(includeTimestamps ? 'timestamps' : 'plain');
    setViewMode(includeTimestamps ? 'timestamps' : 'plain');
    setIsEditingRaw(false);
    setTranscribeError(null);
    setStreamingTranscript('');
    setLastTranscription(null);

    try {
      const result = await geminiService.transcribeAudioFile(
        audioFile,
        includeTimestamps,
        (liveText) => {
          setStreamingTranscript(liveText);
          setTranscriptText(liveText);
        }
      );
      setLastTranscription(result);
      setStreamingTranscript('');
      if (includeTimestamps && result.timestampedTranscript) {
        setTranscriptText(result.timestampedTranscript);
        setViewMode('timestamps');
      } else {
        setTranscriptText(result.transcript);
        setViewMode('plain');
      }
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'Failed to transcribe audio. Please try again.';
      setTranscribeError(message);
    } finally {
      setIsTranscribing(false);
      setTranscribeMode(null);
    }
  };

  const derivedPlainText = useMemo(() => {
    if (
      lastTranscription &&
      (transcriptText === lastTranscription.timestampedTranscript ||
        transcriptText === lastTranscription.transcript)
    ) {
      return lastTranscription.transcript;
    }
    return stripTimestampsFromText(transcriptText);
  }, [transcriptText, lastTranscription]);

  const derivedTimestampedText = useMemo(() => {
    if (
      lastTranscription?.timestampedTranscript &&
      (transcriptText === lastTranscription.timestampedTranscript ||
        transcriptText === lastTranscription.transcript)
    ) {
      return lastTranscription.timestampedTranscript;
    }
    return convertToTimestampedText(transcriptText);
  }, [transcriptText, lastTranscription]);

  const derivedSrtText = useMemo(() => {
    if (
      lastTranscription?.srt &&
      (transcriptText === lastTranscription.timestampedTranscript ||
        transcriptText === lastTranscription.transcript)
    ) {
      return lastTranscription.srt;
    }
    return convertToSRT(transcriptText);
  }, [transcriptText, lastTranscription]);

  const parsedSegments = useMemo(() => {
    if (
      lastTranscription?.segments &&
      lastTranscription.segments.length > 0 &&
      (transcriptText === lastTranscription.timestampedTranscript ||
        transcriptText === lastTranscription.transcript)
    ) {
      return lastTranscription.segments;
    }
    return parseSegmentsFromText(derivedTimestampedText);
  }, [lastTranscription, transcriptText, derivedTimestampedText]);

  const activeOutputText = useMemo(() => {
    if (isTranscribing) {
      return streamingTranscript || 'Optimizing audio and starting transcription...';
    }
    if (viewMode === 'srt') return derivedSrtText;
    if (viewMode === 'timestamps') return derivedTimestampedText;
    return derivedPlainText;
  }, [
    isTranscribing,
    streamingTranscript,
    viewMode,
    derivedSrtText,
    derivedTimestampedText,
    derivedPlainText,
  ]);

  const wordCount = useMemo(() => {
    const clean = derivedPlainText.trim();
    if (!clean) return 0;
    return clean.split(/\s+/).filter(Boolean).length;
  }, [derivedPlainText]);

  const handleCopy = async () => {
    if (!activeOutputText.trim()) return;
    try {
      await navigator.clipboard.writeText(activeOutputText);
      setCopiedState(true);
      setTimeout(() => setCopiedState(false), 1800);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const triggerDownload = (content: string, filename: string) => {
    if (!content.trim()) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getBaseFilename = () => {
    if (audioFile?.name) {
      return audioFile.name.replace(/\.[^/.]+$/, '');
    }
    return `transcript-${Date.now()}`;
  };

  const handleDownloadTxt = () => {
    const content = viewMode === 'timestamps' ? derivedTimestampedText : derivedPlainText;
    triggerDownload(content, `${getBaseFilename()}.txt`);
  };

  const handleDownloadSrt = () => {
    triggerDownload(derivedSrtText, `${getBaseFilename()}.srt`);
  };

  const handleJumpToSegment = (startTime: string) => {
    if (!audioPreviewUrl) return;
    const seconds = parseTimeToSeconds(startTime);
    setSeekRequest({ time: seconds, id: Date.now() });
  };

  const hasContent = Boolean(transcriptText.trim() || streamingTranscript.trim());

  return (
    <div className="min-h-screen flex flex-col bg-[#0b1120] text-slate-100">
      {/* Clean 3-Zone Top Bar */}
      <header className="border-b border-slate-800/90 bg-[#0b1120]/90 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          <span className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
            Miraclesmastery Transcript
          </span>

          <div className="hidden md:flex items-center gap-2 text-xs text-slate-400">
            <span>Audio Transcription</span>
            <span aria-hidden="true">·</span>
            <span>Timestamps</span>
            <span aria-hidden="true">·</span>
            <span>SRT Subtitles</span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {audioFile || hasContent ? (
              <button
                type="button"
                onClick={handleResetAll}
                className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                New Session
              </button>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Upload Audio
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-50 [text-wrap:balance]">
            Audio Transcription Studio
          </h1>
          <p className="text-sm text-slate-400 mt-1.5 max-w-2xl">
            Upload speech or voice recordings in Marathi, Hindi, English, or any spoken language to generate verbatim transcripts, synchronized timestamps, and SRT subtitles.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column: Audio Input & Playback */}
          <section className="lg:col-span-5 space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-200">Audio Source</h2>
                {audioFile && (
                  <button
                    type="button"
                    onClick={handleClearAudio}
                    disabled={isTranscribing}
                    className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40 transition-colors"
                  >
                    Remove file
                  </button>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={(e) => e.target.files && handleAudioChange(e.target.files[0])}
                className="hidden"
              />

              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className={`border border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer flex flex-col items-center justify-center min-h-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  isAudioDragging
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : audioFile
                    ? 'border-slate-700 bg-slate-950/60 hover:border-slate-600'
                    : 'border-slate-700/80 bg-slate-950/40 hover:border-slate-600 hover:bg-slate-950/60'
                }`}
              >
                {audioFile ? (
                  <div className="w-full space-y-3">
                    <div className="w-11 h-11 mx-auto rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                      </svg>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-100 truncate max-w-full px-2">
                        {audioFile.name}
                      </p>
                      <p className="text-xs mono tabular-nums text-slate-400">
                        {(audioFile.size / 1024 / 1024).toFixed(2)} MB · {audioFile.type || 'Audio file'}
                      </p>
                    </div>
                    <p className="text-xs text-slate-500 pt-1">
                      Click or drop another file to replace
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="w-12 h-12 mx-auto rounded-full bg-slate-800/80 border border-slate-700 flex items-center justify-center text-emerald-400">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-200">
                        Drop audio file here or browse
                      </p>
                      <p className="text-xs text-slate-400">
                        Supports MP3, WAV, M4A, AAC, OGG, WEBM, FLAC
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {transcribeError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 text-xs text-red-300 bg-red-950/40 border border-red-500/30 p-3.5 rounded-lg leading-relaxed"
                >
                  <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{transcribeError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => handleTranscribe(true)}
                  disabled={isTranscribing || !audioFile}
                  className="py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 text-xs whitespace-nowrap"
                >
                  {isTranscribing && transcribeMode === 'timestamps' ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Timestamping...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>With Timestamps</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleTranscribe(false)}
                  disabled={isTranscribing || !audioFile}
                  className="py-2.5 px-4 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/60 disabled:text-slate-500 text-slate-100 border border-slate-700 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 text-xs whitespace-nowrap"
                >
                  {isTranscribing && transcribeMode === 'plain' ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-slate-400/30 border-t-slate-100 rounded-full animate-spin" />
                      <span>Transcribing...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span>Plain Transcript</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {(audioPreviewUrl || hasContent) && (
              <AudioPlayerBar
                transcript={derivedPlainText}
                uploadedAudioUrl={audioPreviewUrl}
                uploadedAudioName={audioFile?.name}
                seekRequest={seekRequest}
                onPlayingChange={setIsAudioPlaying}
                onTimeUpdate={setCurrentPlaybackTime}
              />
            )}
          </section>

          {/* Right Column: Transcript Output & Subtitle Export */}
          <section className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl flex flex-col min-h-[560px]">
            {/* Toolbar */}
            <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800">
                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={() => {
                    setViewMode('timestamps');
                    setIsEditingRaw(false);
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    viewMode === 'timestamps'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Timestamps
                </button>
                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={() => setViewMode('plain')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    viewMode === 'plain'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Plain Text
                </button>
                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={() => setViewMode('srt')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    viewMode === 'srt'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  SRT Subtitles
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!hasContent || isTranscribing}
                  onClick={handleCopy}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap"
                >
                  {copiedState ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  disabled={!hasContent || isTranscribing}
                  onClick={handleDownloadTxt}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap"
                >
                  Export TXT
                </button>
                <button
                  type="button"
                  disabled={!hasContent || isTranscribing}
                  onClick={handleDownloadSrt}
                  className="px-3 py-1.5 text-xs font-semibold bg-emerald-600/15 hover:bg-emerald-600/25 disabled:opacity-40 text-emerald-300 border border-emerald-500/30 rounded-lg transition-colors whitespace-nowrap"
                >
                  Export SRT
                </button>
              </div>
            </div>

            {/* Quiet Metadata Bar */}
            <div className="px-5 py-2.5 border-b border-slate-800/70 flex items-center justify-between gap-4 text-xs text-slate-400">
              <div className="flex items-center gap-2 mono tabular-nums">
                {isTranscribing ? (
                  <span className="flex items-center gap-2 text-emerald-400 font-sans font-medium">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                    Live transcribing audio stream...
                  </span>
                ) : hasContent ? (
                  <>
                    <span>{wordCount} words</span>
                    <span aria-hidden="true">·</span>
                    <span>{parsedSegments.length} segments</span>
                  </>
                ) : (
                  <span className="font-sans">No transcript generated yet</span>
                )}
              </div>

              {viewMode === 'timestamps' && hasContent && !isTranscribing && (
                <button
                  type="button"
                  onClick={() => setIsEditingRaw((prev) => !prev)}
                  className="text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors whitespace-nowrap"
                >
                  {isEditingRaw ? 'View Timeline' : 'Edit Raw'}
                </button>
              )}
            </div>

            {/* Transcript Body */}
            <div className="flex-1 flex flex-col p-5">
              {isTranscribing ? (
                <textarea
                  value={activeOutputText}
                  readOnly
                  aria-label="Live transcription output"
                  className="flex-1 w-full min-h-[420px] bg-slate-950/60 border border-slate-800 rounded-lg p-4 text-sm text-slate-200 leading-relaxed mono resize-none focus:outline-none"
                />
              ) : !hasContent ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-16 px-4">
                  <div className="w-12 h-12 rounded-full bg-slate-800/70 border border-slate-700/80 flex items-center justify-center text-slate-400 mb-4">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <h3 className="text-base font-semibold text-slate-200">Ready to Transcribe</h3>
                  <p className="text-sm text-slate-400 max-w-sm mt-1.5">
                    Upload an audio file on the left and select With Timestamps or Plain Transcript. You can edit the result and export TXT or SRT subtitles.
                  </p>
                  {!audioFile && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
                    >
                      Choose Audio File
                    </button>
                  )}
                </div>
              ) : viewMode === 'timestamps' && !isEditingRaw && parsedSegments.length > 0 ? (
                <div className="flex-1 overflow-y-auto max-h-[520px] divide-y divide-slate-800/80 pr-1">
                  {parsedSegments.map((seg, idx) => {
                    const startSec = parseTimeToSeconds(seg.startTime);
                    const endSec = parseTimeToSeconds(seg.endTime);
                    const isActive =
                      isAudioPlaying &&
                      currentPlaybackTime >= startSec &&
                      currentPlaybackTime < endSec;

                    return (
                      <div
                        key={`${seg.startTime}-${idx}`}
                        className={`py-3 px-2.5 flex items-start gap-4 transition-colors rounded-md ${
                          isActive ? 'bg-emerald-500/10' : 'hover:bg-slate-800/40'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleJumpToSegment(seg.startTime)}
                          disabled={!audioPreviewUrl}
                          title={audioPreviewUrl ? `Play from ${seg.startTime}` : undefined}
                          className={`mono tabular-nums text-xs shrink-0 pt-0.5 transition-colors whitespace-nowrap ${
                            isActive
                              ? 'text-emerald-400 font-semibold'
                              : audioPreviewUrl
                              ? 'text-slate-400 hover:text-emerald-400 cursor-pointer'
                              : 'text-slate-500 cursor-default'
                          }`}
                        >
                          {seg.startTime} – {seg.endTime}
                        </button>
                        <p className="text-sm text-slate-200 leading-relaxed flex-1">
                          {seg.text}
                        </p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  value={activeOutputText}
                  onChange={(e) => {
                    if (viewMode !== 'srt') {
                      setTranscriptText(e.target.value);
                      setLastTranscription(null);
                    }
                  }}
                  readOnly={viewMode === 'srt'}
                  aria-label="Transcript text editor"
                  placeholder="Your transcript will appear here..."
                  className={`flex-1 w-full min-h-[420px] bg-slate-950/60 border border-slate-800 rounded-lg p-4 text-sm text-slate-200 leading-relaxed resize-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none ${
                    viewMode === 'srt' || viewMode === 'timestamps' ? 'mono text-xs' : ''
                  }`}
                />
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="py-6 border-t border-slate-800/80 text-center text-xs text-slate-500">
        <p>© {new Date().getFullYear()} Miraclesmastery Transcript</p>
      </footer>
    </div>
  );
};

export default App;