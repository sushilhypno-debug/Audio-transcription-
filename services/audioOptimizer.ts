/**
 * Optimizes an audio File for fast speech transcription by downsampling large
 * or uncompressed audio (e.g. stereo 48kHz WAV/FLAC) to 16kHz mono 16-bit WAV.
 * If the original file is already compact/compressed (e.g. small MP3/M4A/OGG)
 * or downsampling does not reduce file size, returns the original file untouched.
 */

const UNCOMPRESSED_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/aiff',
  'audio/x-aiff',
  'audio/flac',
  'audio/x-flac',
]);

const UNCOMPRESSED_EXT_REGEX = /\.(wav|wave|aiff|aif|flac|pcm)$/i;
const OPTIMIZE_SIZE_THRESHOLD_BYTES = 1.5 * 1024 * 1024; // 1.5 MB
const TARGET_SAMPLE_RATE = 16000;

function encodeMonoWav16Bit(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate (sampleRate * channels * bytesPerSample)
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export async function optimizeAudioForTranscription(
  file: File
): Promise<{ blob: Blob; mimeType: string }> {
  const originalMime = file.type || 'audio/mpeg';
  const isUncompressed =
    UNCOMPRESSED_TYPES.has(originalMime.toLowerCase()) ||
    UNCOMPRESSED_EXT_REGEX.test(file.name);

  // Skip decoding small already-compressed files (instant upload)
  if (!isUncompressed && file.size < OPTIMIZE_SIZE_THRESHOLD_BYTES) {
    return { blob: file, mimeType: originalMime };
  }

  // Only attempt Web Audio downsampling in browser environments with OfflineAudioContext
  if (
    typeof window === 'undefined' ||
    (!window.AudioContext && !(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) ||
    typeof OfflineAudioContext === 'undefined'
  ) {
    return { blob: file, mimeType: originalMime };
  }

  let audioCtx: AudioContext | null = null;
  try {
    const AudioCtxClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AudioCtxClass();

    const arrayBuffer = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    const estimatedWavBytes = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE) * 2 + 44;
    // Only resample if the resulting 16kHz mono WAV will actually be smaller
    if (estimatedWavBytes >= file.size * 0.92) {
      return { blob: file, mimeType: originalMime };
    }

    const frameCount = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
    const offlineCtx = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    const monoSamples = renderedBuffer.getChannelData(0);
    const wavBlob = encodeMonoWav16Bit(monoSamples, TARGET_SAMPLE_RATE);

    if (wavBlob.size < file.size) {
      return { blob: wavBlob, mimeType: 'audio/wav' };
    }
    return { blob: file, mimeType: originalMime };
  } catch {
    // Fallback to original file if browser cannot decode format
    return { blob: file, mimeType: originalMime };
  } finally {
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => {});
    }
  }
}
