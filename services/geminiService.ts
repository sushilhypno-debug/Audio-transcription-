import { TranscriptionResult } from "../types";
import { optimizeAudioForTranscription } from "./audioOptimizer";

export class GeminiService {
  private optimizedCache = new WeakMap<File, Promise<{ blob: Blob; mimeType: string }>>();

  private getOptimizedAudio(file: File): Promise<{ blob: Blob; mimeType: string }> {
    let cached = this.optimizedCache.get(file);
    if (!cached) {
      cached = optimizeAudioForTranscription(file);
      this.optimizedCache.set(file, cached);
    }
    return cached;
  }

  async transcribeAudioFile(
    file: File,
    includeTimestamps: boolean = false,
    onStreamChunk?: (accumulatedText: string) => void
  ): Promise<TranscriptionResult> {
    const { blob, mimeType } = await this.getOptimizedAudio(file);

    const params = new URLSearchParams({
      mimeType,
      includeTimestamps: String(includeTimestamps),
    });

    const response = await fetch(`/api/transcribe-audio-stream?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Audio-Mime-Type': mimeType,
        'X-Include-Timestamps': String(includeTimestamps),
      },
      body: blob,
    });

    if (!response.ok) {
      let errMsg = 'Failed to transcribe audio';
      try {
        const errData = await response.json();
        errMsg = errData.error || errMsg;
      } catch {
        // Ignore parse error
      }
      throw new Error(errMsg);
    }

    if (!response.body) {
      throw new Error('Streaming response unavailable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let accumulatedText = '';
    let finalResult: TranscriptionResult | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop() || '';

      for (const eventBlock of events) {
        const dataLines = eventBlock
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());

        if (dataLines.length === 0) continue;

        const payload = JSON.parse(dataLines.join('\n'));
        if (payload.type === 'chunk' && payload.text) {
          accumulatedText += payload.text;
          onStreamChunk?.(accumulatedText);
        } else if (payload.type === 'done' && payload.result) {
          finalResult = payload.result;
        } else if (payload.type === 'error') {
          throw new Error(payload.error || 'Failed to transcribe audio');
        }
      }
    }

    if (finalResult) {
      return finalResult;
    }

    if (accumulatedText.trim()) {
      return { transcript: accumulatedText.trim() };
    }

    throw new Error('No transcription text returned');
  }

  async transcribeAudio(
    base64Audio: string,
    mimeType: string,
    includeTimestamps: boolean = false
  ): Promise<TranscriptionResult> {
    const response = await fetch('/api/transcribe-audio', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64Audio, mimeType, includeTimestamps }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'No transcription text returned');
    }

    return data;
  }
}

export const geminiService = new GeminiService();
