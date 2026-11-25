import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

function getAI() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableError(err: unknown): boolean {
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

function formatGeminiError(error: unknown, fallbackMessage: string): string {
  if (!error) return fallbackMessage;
  const rawMessage = error instanceof Error ? error.message : String(error);
  try {
    const jsonMatch = rawMessage.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed?.error?.message) {
        return parsed.error.message;
      }
      if (parsed?.message) {
        return parsed.message;
      }
    }
  } catch {
    // Ignore JSON parse errors and return raw message
  }
  return rawMessage || fallbackMessage;
}

function getFastModelConfig(model: string): Record<string, unknown> {
  if (model === 'gemini-3.1-flash-lite') {
    return { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } };
  }
  return {};
}

async function generateWithFallback(
  models: string[],
  buildRequest: (model: string) => Parameters<GoogleGenAI['models']['generateContent']>[0],
  maxPasses: number = 2
) {
  const ai = getAI();
  let lastError: unknown = null;

  for (let pass = 0; pass < maxPasses; pass++) {
    let sawRetryable = false;

    for (const model of models) {
      try {
        const reqParams = buildRequest(model);
        return await ai.models.generateContent(reqParams);
      } catch (err) {
        lastError = err;
        if (isRetryableError(err)) {
          sawRetryable = true;
        }
        console.warn(
          `[Gemini API] Model ${model} failed (pass ${pass + 1}/${maxPasses}):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    if (!sawRetryable || pass === maxPasses - 1) {
      break;
    }

    const delayMs = 700 * (pass + 1) + Math.random() * 300;
    await sleep(delayMs);
  }

  throw lastError || new Error('All Gemini models failed to respond');
}

async function streamWithFallback(
  models: string[],
  buildRequest: (model: string) => Parameters<GoogleGenAI['models']['generateContentStream']>[0],
  onChunk: (chunkText: string) => void,
  maxPasses: number = 2
): Promise<string> {
  const ai = getAI();
  let lastError: unknown = null;

  for (let pass = 0; pass < maxPasses; pass++) {
    let sawRetryable = false;

    for (const model of models) {
      let accumulated = '';
      let emittedAny = false;
      try {
        const reqParams = buildRequest(model);
        const stream = await ai.models.generateContentStream(reqParams);
        for await (const chunk of stream) {
          const text = chunk.text || '';
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

    if (!sawRetryable || pass === maxPasses - 1) {
      break;
    }

    const delayMs = 700 * (pass + 1) + Math.random() * 300;
    await sleep(delayMs);
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

  // Streaming binary audio transcription endpoint
  app.post(
    '/api/transcribe-audio-stream',
    express.raw({ type: '*/*', limit: '50mb' }),
    async (req, res) => {
      const audioBuffer = req.body as Buffer;
      if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        res.status(400).json({ error: 'Audio data is required' });
        return;
      }

      const mimeType =
        (typeof req.query.mimeType === 'string' && req.query.mimeType) ||
        req.header('x-audio-mime-type') ||
        'audio/mpeg';
      const includeTimestamps =
        req.query.includeTimestamps === 'true' ||
        req.header('x-include-timestamps') === 'true';

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const sendEvent = (payload: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        const base64Audio = audioBuffer.toString('base64');
        const models = includeTimestamps ? TIMESTAMP_TRANSCRIBE_MODELS : PLAIN_TRANSCRIBE_MODELS;
        const prompt = buildTranscribePrompt(includeTimestamps);

        const rawText = await streamWithFallback(
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
          }
        );

        const result = formatTranscriptionResult(rawText, includeTimestamps);
        sendEvent({ type: 'done', result });
        res.end();
      } catch (error) {
        console.error('Failed to stream audio transcription:', error);
        sendEvent({
          type: 'error',
          error: formatGeminiError(error, 'Failed to transcribe audio'),
        });
        res.end();
      }
    }
  );

  app.use(express.json({ limit: '50mb' }));

  app.post('/api/transcribe-audio', async (req, res) => {
    try {
      const { base64Audio, mimeType, includeTimestamps = false } = req.body;
      if (!base64Audio) {
        res.status(400).json({ error: 'Audio data is required' });
        return;
      }

      const models = includeTimestamps ? TIMESTAMP_TRANSCRIBE_MODELS : PLAIN_TRANSCRIBE_MODELS;
      const prompt = buildTranscribePrompt(includeTimestamps);

      const response = await generateWithFallback(models, (model) => ({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType || 'audio/mpeg',
                data: base64Audio,
              },
            },
            { text: prompt },
          ],
        },
        config: getFastModelConfig(model),
      }));

      if (!response.text) {
        res.status(500).json({ error: 'No transcription text returned' });
        return;
      }

      res.json(formatTranscriptionResult(response.text.trim(), includeTimestamps));
    } catch (error) {
      console.error('Failed to transcribe audio:', error);
      res.status(500).json({
        error: formatGeminiError(error, 'Failed to transcribe audio'),
      });
    }
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
