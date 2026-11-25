export interface TranscriptSegment {
  startTime: string;
  endTime: string;
  text: string;
}

export interface TranscriptionResult {
  transcript: string;
  timestampedTranscript?: string;
  srt?: string;
  segments?: TranscriptSegment[];
}
