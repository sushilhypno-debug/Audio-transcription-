import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = parsePositiveInt(process.env.PORT, 3000);
const MAX_AUDIO_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB hard limit
const RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 15);
const MAX_CONCURRENT_PER_IP = parsePositiveInt(process.env.MAX_CONCURRENT_PER_IP, 2);
const MAX_CONCURRENT_GLOBAL = parsePositiveInt(process.env.MAX_CONCURRENT_GLOBAL, 10);
const TRANSCRIPTION_TIMEOUT_MS = parsePositiveInt(process.env.TRANSCRIPTION_TIMEOUT_MS, 120 * 1000);

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  if (!raw) return allowed;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        allowed.add(parsed.origin.toLowerCase());
      }
    } catch {
      console.warn(`[Security] Ignoring invalid ALLOWED_ORIGINS entry: ${trimmed}`);
    }
  }
  return allowed;
}

const CONFIGURED_ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/aacp',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
  'audio/x-ms-wma',
]);

class TranscriptionTimeoutError extends Error {
  constructor() {
    super('Transcription timed out');
    this.name = 'TranscriptionTimeoutError';
  }
}

class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected');
    this.name = 'ClientDisconnectedError';
  }
}

function getConfiguredApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function getAI(apiKey: string) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableError(err: unknown): boolean {
  if (err instanceof TranscriptionTimeoutError || err instanceof ClientDisconnectedError) {
    return false;
  }
  const anyErr = err as { message?: string; status?: number; code?: number; error?: { code?: number } };
  const msg = String(anyErr?.message || err || '').toLowerCase();
  const status = anyErr?.status || anyErr?.code || anyErr?.error?.code;
  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 504 ||
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('temporarily') ||
    msg.includes('fetch failed') ||
    msg.includes('internal')
  );
}

function toSafeClientError(error: unknown): string {
  if (error instanceof TranscriptionTimeoutError) {
    return 'Transcription timed out. Please try a shorter audio file or try again.';
  }
  const anyErr = error as { message?: string; status?: number; code?: number; error?: { code?: number } };
  const msg = String(anyErr?.message || error || '').toLowerCase();
  const status = anyErr?.status || anyErr?.code || anyErr?.error?.code;

  if (status === 401 || status === 403 || msg.includes('api_key_invalid') || msg.includes('permission_denied')) {
    return 'Transcription service authentication failed. Please verify the server configuration.';
  }
  if (status === 429 || msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('rate limit')) {
    return 'The transcription service is temporarily busy. Please try again in a moment.';
  }
  if (status === 503 || msg.includes('unavailable') || msg.includes('overloaded')) {
    return 'The transcription service is temporarily unavailable. Please try again shortly.';
  }
  return 'Unable to transcribe audio right now. Please try again.';
}

function getFastModelConfig(model: string): Record<string, unknown> {
  if (model === 'gemini-3.1-flash-lite') {
    return { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } };
  }
  return {};
}

function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function normalizeMimeType(rawMime: string | undefined): string {
  if (!rawMime || typeof rawMime !== 'string') return '';
  return rawMime.split(';')[0].trim().toLowerCase();
}

function hasDisallowedFileSignature(buf: Buffer): boolean {
  if (buf.length < 4) return true;
  const ascii4 = buf.subarray(0, 4).toString('ascii');
  // Block obvious non-audio file headers (PDF, PNG, JPEG, GIF, ZIP, ELF, PE/MZ, HTML/XML/SVG/JSON)
  if (ascii4 === '%PDF') return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (ascii4 === 'GIF8') return true; // GIF
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return true; // ZIP
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true; // ELF
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // MZ/EXE
  const trimmedPrefix = buf.subarray(0, Math.min(buf.length, 64)).toString('utf8').trimStart().toLowerCase();
  if (
    trimmedPrefix.startsWith('<!doctype') ||
    trimmedPrefix.startsWith('<html') ||
    trimmedPrefix.startsWith('<svg') ||
    trimmedPrefix.startsWith('<?xml') ||
    trimmedPrefix.startsWith('{"') ||
    trimmedPrefix.startsWith('[')
  ) {
    return true;
  }
  return false;
}

function hasMpegFrameSync(buf: Buffer): boolean {
  const limit = Math.min(buf.length - 1, 4096);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const mpegVersion = (buf[i + 1] & 0x18) >> 3;
      const layer = (buf[i + 1] & 0x06) >> 1;
      // Version 1 (01) and Layer 0 (00) are reserved/invalid in MPEG audio headers
      if (mpegVersion !== 1 && layer !== 0) {
        return true;
      }
    }
  }
  return false;
}

function hasIsoBmffBox(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  const boxType = buf.subarray(4, 8).toString('ascii');
  return (
    boxType === 'ftyp' ||
    boxType === 'moov' ||
    boxType === 'mdat' ||
    boxType === 'free' ||
    boxType === 'wide'
  );
}

function hasValidAudioSignature(buf: Buffer, mimeType: string): boolean {
  if (buf.length < 4 || hasDisallowedFileSignature(buf)) {
    return false;
  }

  const head4 = buf.subarray(0, 4).toString('ascii');
  const head3 = buf.subarray(0, 3).toString('ascii');

  switch (mimeType) {
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
    case 'audio/vnd.wave':
      return (
        buf.length >= 12 &&
        (head4 === 'RIFF' || head4 === 'RF64') &&
        buf.subarray(8, 12).toString('ascii') === 'WAVE'
      );

    case 'audio/mpeg':
    case 'audio/mp3':
      return head3 === 'ID3' || hasMpegFrameSync(buf);

    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return hasIsoBmffBox(buf);

    case 'audio/aac':
    case 'audio/aacp':
      return (
        (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) || // ADTS sync
        head4 === 'ADIF' ||
        head3 === 'ID3' ||
        hasIsoBmffBox(buf)
      );

    case 'audio/ogg':
    case 'audio/opus':
      return (
        head4 === 'OggS' ||
        (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
      );

    case 'audio/webm':
      return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;

    case 'audio/flac':
    case 'audio/x-flac':
      return head4 === 'fLaC' || head3 === 'ID3';

    case 'audio/x-ms-wma':
      return buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xb2 && buf[3] === 0x75;

    default:
      return false;
  }
}

function isOriginAllowed(originHeader: string, req: Request): boolean {
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const reqHost = (forwardedHost || req.header('host') || '').toLowerCase();

  if (reqHost && parsed.host.toLowerCase() === reqHost) {
    return true;
  }

  if (CONFIGURED_ALLOWED_ORIGINS.has(parsed.origin.toLowerCase())) {
    return true;
  }

  if (process.env.NODE_ENV !== 'production') {
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return true;
    }
  }

  return false;
}

function originProtectionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');

  if (origin) {
    if (!isOriginAllowed(origin, req)) {
      res.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
    res.setHeader('Vary', 'Origin');

    const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim();
    const reqHost = (forwardedHost || req.header('host') || '').toLowerCase();
    const parsedOrigin = new URL(origin);
    if (reqHost && parsedOrigin.host.toLowerCase() !== reqHost) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Audio-Mime-Type, X-Include-Timestamps'
      );
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
    return;
  }

  // No Origin header: block cross-site browser requests and mismatched Referer headers
  const secFetchSite = req.header('sec-fetch-site')?.toLowerCase();
  if (secFetchSite === 'cross-site') {
    res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    return;
  }

  const referer = req.header('referer');
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (!isOriginAllowed(refOrigin, req)) {
        res.status(403).json({ error: 'Request origin is not allowed.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}

// Per-IP fixed-window rate limiter with automatic stale entry cleanup
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (record.resetAt <= now) {
      rateLimitStore.delete(ip);
    }
  }
}, Math.max(60_000, Math.min(RATE_LIMIT_WINDOW_MS, 5 * 60_000)));
rateLimitCleanupTimer.unref?.();

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') {
    next();
    return;
  }

  const ip = getClientIp(req);
  const now = Date.now();
  let entry = rateLimitStore.get(ip);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    res.status(429).json({
      error: 'Too many transcription requests. Please wait before trying again.',
    });
    return;
  }

  entry.count += 1;
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX_REQUESTS - entry.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
  next();
}

// Per-IP and global concurrency limiter
let activeGlobalTranscriptions = 0;
const activeIpTranscriptions = new Map<string, number>();

function concurrencyLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') {
    next();
    return;
  }

  const ip = getClientIp(req);
  const ipActive = activeIpTranscriptions.get(ip) || 0;

  if (activeGlobalTranscriptions >= MAX_CONCURRENT_GLOBAL) {
    res.status(503).json({
      error: 'The server is currently busy processing other audio files. Please try again shortly.',
    });
    return;
  }

  if (ipActive >= MAX_CONCURRENT_PER_IP) {
    res.status(429).json({
      error: 'Too many simultaneous transcription requests from your connection. Please wait for an active transcription to finish.',
    });
    return;
  }

  activeGlobalTranscriptions += 1;
  activeIpTranscriptions.set(ip, ipActive + 1);

  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    activeGlobalTranscriptions = Math.max(0, activeGlobalTranscriptions - 1);
    const current = activeIpTranscriptions.get(ip) || 0;
    if (current <= 1) {
      activeIpTranscriptions.delete(ip);
    } else {
      activeIpTranscriptions.set(ip, current - 1);
    }
  };

  res.on('finish', releaseSlot);
  res.on('close', releaseSlot);
  next();
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason || new TranscriptionTimeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason || new TranscriptionTimeoutError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

async function streamWithFallback(
  apiKey: string,
  models: string[],
  buildRequest: (model: string) => Parameters<GoogleGenAI['models']['generateContentStream']>[0],
  onChunk: (chunkText: string) => void,
  signal: AbortSignal,
  maxPasses: number = 2
): Promise<string> {
  const ai = getAI(apiKey);
  let lastError: unknown = null;

  for (let pass = 0; pass < maxPasses; pass++) {
    let sawRetryable = false;

    for (const model of models) {
      if (signal.aborted) {
        throw signal.reason || new TranscriptionTimeoutError();
      }

      let accumulated = '';
      let emittedAny = false;
      try {
        const reqParams = buildRequest(model);
        const stream = await raceWithSignal(ai.models.generateContentStream(reqParams), signal);
        const iterator = stream[Symbol.asyncIterator]();

        while (true) {
          const nextStep = await raceWithSignal(iterator.next(), signal);
          if (nextStep.done) break;
          const text = nextStep.value.text || '';
          if (text) {
            emittedAny = true;
            accumulated += text;
            onChunk(text);
          }
        }

        if (accumulated.trim()) {
          return accumulated.trim();
        }
        throw new Error(`Model ${model} returned empty transcript stream`);
      } catch (err) {
        if (err instanceof TranscriptionTimeoutError || err instanceof ClientDisconnectedError) {
          throw err;
        }
        lastError = err;
        if (emittedAny && accumulated.trim()) {
          return accumulated.trim();
        }
        if (isRetryableError(err)) {
          sawRetryable = true;
        }
        console.warn(
          `[Gemini API Stream] Model ${model} failed (pass ${pass + 1}/${maxPasses}):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    if (!sawRetryable || pass === maxPasses - 1 || signal.aborted) {
      break;
    }

    const delayMs = 700 * (pass + 1) + Math.random() * 300;
    await raceWithSignal(sleep(delayMs), signal);
  }

  throw lastError || new Error('All Gemini models failed to stream transcription');
}

const PLAIN_TRANSCRIBE_MODELS = [
  'gemini-3.5-transcribe',
  'gemini-3.1-flash-lite',
];

const TIMESTAMP_TRANSCRIBE_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-transcribe',
];

function toSrtTime(t: string): string {
  const clean = String(t || '00:00').trim().replace('.', ',');
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
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildSegmentsFromPlainText(text: string) {
  const rawLines = String(text || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const sentences: string[] = [];
  rawLines.forEach((line) => {
    const cleaned = line.replace(
      /^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:(?:-|–|-->|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?))?\]?\)?\s*[:-]?\s*/i,
      ''
    );
    const parts = cleaned.split(/(?<=[.?!।])\s+/);
    parts.forEach((p) => {
      const trimmed = p.trim();
      if (trimmed) sentences.push(trimmed);
    });
  });

  let currentSec = 0;
  return sentences.map((sentence) => {
    const words = sentence.split(/\s+/).length;
    const duration = Math.max(2, Math.min(7, Math.ceil(words * 0.4)));
    const startTime = formatMMSS(currentSec);
    const endTime = formatMMSS(currentSec + duration);
    currentSec += duration;
    return { startTime, endTime, text: sentence };
  });
}

function parseTimestampedLines(rawText: string) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rangeRegex =
    /^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:-|–|—|-->|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\)?\s*[:-]?\s*(.+)$/i;
  const singleRegex = /^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\)?\s*[:-]?\s*(.+)$/i;

  const rangeMatches: Array<{ startTime: string; endTime: string; text: string }> = [];
  const singleMatches: Array<{ startTime: string; text: string }> = [];

  for (const line of lines) {
    const rm = line.match(rangeRegex);
    if (rm) {
      rangeMatches.push({
        startTime: rm[1].trim(),
        endTime: rm[2].trim(),
        text: rm[3].trim(),
      });
      continue;
    }
    const sm = line.match(singleRegex);
    if (sm) {
      singleMatches.push({
        startTime: sm[1].trim(),
        text: sm[2].trim(),
      });
    }
  }

  if (rangeMatches.length > 0) {
    return rangeMatches;
  }

  if (singleMatches.length > 0) {
    return singleMatches.map((item, idx) => {
      const next = singleMatches[idx + 1];
      let endTime = next ? next.startTime : '';
      if (!endTime) {
        const parts = item.startTime.split(':').map((n) => parseInt(n, 10) || 0);
        const startSec =
          parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        const words = item.text.split(/\s+/).length;
        const duration = Math.max(2, Math.min(7, Math.ceil(words * 0.4)));
        endTime = formatMMSS(startSec + duration);
      }
      return {
        startTime: item.startTime,
        endTime,
        text: item.text,
      };
    });
  }

  return buildSegmentsFromPlainText(rawText);
}

function formatTranscriptionResult(rawText: string, includeTimestamps: boolean) {
  const segments = includeTimestamps
    ? parseTimestampedLines(rawText)
    : buildSegmentsFromPlainText(rawText);

  const plainTranscript = includeTimestamps
    ? segments.map((s) => s.text.trim()).filter(Boolean).join('\n')
    : rawText.trim();

  const timestampedTranscript = segments
    .map((s) => `[${s.startTime} - ${s.endTime}] ${s.text.trim()}`)
    .join('\n');

  const srt = segments
    .map(
      (s, idx) =>
        `${idx + 1}\n${toSrtTime(s.startTime)} --> ${toSrtTime(s.endTime)}\n${s.text.trim()}`
    )
    .join('\n\n');

  return {
    transcript: plainTranscript,
    timestampedTranscript,
    srt,
    segments,
  };
}

function buildTranscribePrompt(includeTimestamps: boolean): string {
  if (includeTimestamps) {
    return 'Transcribe this audio verbatim with timestamps in its original spoken language. Output ONLY lines in this exact format: [MM:SS - MM:SS] spoken text. One natural sentence or phrase per line. No intro, no markdown, no commentary.';
  }
  return 'Transcribe this audio verbatim in its original spoken language. Output ONLY the spoken text as clean paragraphs or sentences without headers, timestamps, notes, or commentary.';
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Basic security headers on API responses
  app.use('/api', (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use('/api', originProtectionMiddleware);

  // Streaming binary audio transcription endpoint
  app.post(
    '/api/transcribe-audio-stream',
    rateLimitMiddleware,
    concurrencyLimitMiddleware,
    express.raw({ type: '*/*', limit: MAX_AUDIO_UPLOAD_BYTES }),
    async (req, res) => {
      const audioBuffer = req.body as Buffer;
      if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        res.status(400).json({ error: 'Audio data is required.' });
        return;
      }

      if (audioBuffer.length > MAX_AUDIO_UPLOAD_BYTES) {
        res.status(413).json({ error: 'Audio file exceeds the 20 MB maximum upload limit.' });
        return;
      }

      const rawMime =
        (typeof req.query.mimeType === 'string' && req.query.mimeType) ||
        req.header('x-audio-mime-type') ||
        '';
      const mimeType = normalizeMimeType(rawMime);

      if (!mimeType || !ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) {
        res.status(415).json({
          error: 'Unsupported audio format. Allowed formats: MP3, WAV, M4A, AAC, OGG, OPUS, WEBM, FLAC, WMA.',
        });
        return;
      }

      if (!hasValidAudioSignature(audioBuffer, mimeType)) {
        res.status(415).json({
          error: 'Uploaded file does not match a valid supported audio format.',
        });
        return;
      }

      const apiKey = getConfiguredApiKey();
      if (!apiKey) {
        console.error('[Server Config] GEMINI_API_KEY is not configured in server environment.');
        res.status(503).json({
          error: 'Audio transcription service is not configured on the server. Missing GEMINI_API_KEY.',
        });
        return;
      }

      const includeTimestamps =
        req.query.includeTimestamps === 'true' ||
        req.header('x-include-timestamps') === 'true';

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        abortController.abort(new TranscriptionTimeoutError());
      }, TRANSCRIPTION_TIMEOUT_MS);

      const onClientClose = () => {
        if (!res.writableEnded && !res.writableFinished) {
          abortController.abort(new ClientDisconnectedError());
        }
      };
      res.on('close', onClientClose);

      const sendEvent = (payload: Record<string, unknown>) => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      try {
        const base64Audio = audioBuffer.toString('base64');
        const models = includeTimestamps ? TIMESTAMP_TRANSCRIBE_MODELS : PLAIN_TRANSCRIBE_MODELS;
        const prompt = buildTranscribePrompt(includeTimestamps);

        const rawText = await streamWithFallback(
          apiKey,
          models,
          (model) => ({
            model,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Audio,
                  },
                },
                { text: prompt },
              ],
            },
            config: getFastModelConfig(model),
          }),
          (chunkText) => {
            sendEvent({ type: 'chunk', text: chunkText });
          },
          abortController.signal
        );

        const result = formatTranscriptionResult(rawText, includeTimestamps);
        sendEvent({ type: 'done', result });
        if (!res.writableEnded) {
          res.end();
        }
      } catch (error) {
        if (!(error instanceof ClientDisconnectedError)) {
          console.error('Failed to stream audio transcription:', error);
          sendEvent({
            type: 'error',
            error: toSafeClientError(error),
          });
        }
        if (!res.writableEnded) {
          res.end();
        }
      } finally {
        clearTimeout(timeoutHandle);
        res.off('close', onClientClose);
      }
    }
  );

  // Express error handler for payload-too-large and malformed requests on /api
  app.use('/api', (err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      res.status(413).json({ error: 'Audio file exceeds the 20 MB maximum upload limit.' });
      return;
    }
    console.error('Unhandled API middleware error:', err);
    res.status(500).json({ error: 'Unable to process request right now. Please try again.' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
