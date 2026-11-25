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
      let errMsg = 'Unable to transcribe audio right now. Please try again.';
      try {
        const errData = await response.json();
        if (errData?.error && typeof errData.error === 'string') {
          errMsg = errData.error;
        }
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
          throw new Error(payload.error || 'Unable to transcribe audio right now. Please try again.');
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
}

export const geminiService = new GeminiService();
