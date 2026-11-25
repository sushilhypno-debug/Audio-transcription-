# Miraclesmastery Audio Transcription

An AI-powered audio transcription studio built with React, TypeScript, Vite, and Express. Upload speech recordings in Marathi, Hindi, English, or other spoken languages to generate verbatim plain-text transcripts, synchronized `[MM:SS - MM:SS]` timestamp timelines, and `.srt` subtitle files with live streaming output.

## Features

- **Live Streaming Transcription:** Streams transcription output incrementally over Server-Sent Events (SSE) as audio is processed.
- **Timestamped & Plain Modes:** Generate synchronized `[MM:SS - MM:SS]` segment timelines or clean verbatim paragraphs.
- **Interactive Audio Playback:** Play back uploaded audio with variable playback speed (`0.75x`–`1.5x`), click any timestamp to jump directly to that point in the recording, or use browser text-to-speech read-aloud.
- **Multi-Format Export:** Edit transcripts inline, copy to clipboard, or export as `.txt` and SubRip `.srt` subtitle files.
- **Client-Side Audio Optimization:** Automatically downsamples large uncompressed WAV/FLAC audio to 16 kHz mono WAV before upload when doing so reduces transfer size.
- **Server-Side API Security:** All Gemini API calls run exclusively on the Express backend with MIME allowlisting, binary signature checks, 20 MB upload limits, rate limiting, concurrency caps, timeouts, and same-origin protection.

## Technology Stack

- **Frontend:** React 19, TypeScript, Vite 6, Tailwind CSS
- **Backend:** Node.js, Express 5, `tsx`
- **AI SDK:** `@google/genai` (server-side only, using `gemini-3.5-transcribe` with `gemini-3.1-flash-lite` fallback)

## Prerequisites

- **Node.js** v20+ (or **Bun** v1.1+)
- A **Google Gemini API key** from [Google AI Studio](https://aistudio.google.com/)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/sushilhypno-debug/Audio-transcription-.git
   cd Audio-transcription-
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Configuring `GEMINI_API_KEY` Securely

1. Copy the example environment file to a local `.env` file:
   ```bash
   cp .env.example .env
   ```

2. Open `.env` and set your server-side API key:
   ```env
   GEMINI_API_KEY=your_actual_gemini_api_key_here
   ```

**Security notes:**
- Never commit `.env` or any file containing real API keys to Git. `.gitignore` is configured to ignore `.env`, `.env.*`, `*.local`, `*.pem`, and `*.key` while allowing `.env.example`.
- Do not prefix the key with `VITE_`. `GEMINI_API_KEY` is read strictly on the Node.js server (`server.ts`) and is never bundled into frontend assets or exposed to browser network requests.
- Configure spending limits and daily quota caps on your API key in Google Cloud / Google AI Studio.

## Running Locally

### Development Mode
Runs the Express backend with Vite middleware on port `3000`:
```bash
npm run dev
```
Open `http://localhost:3000` in your browser.

### Production Build & Start
```bash
npm run build
NODE_ENV=production npm start
```

### Type Checking
```bash
npm run lint
```

## Supported Audio Formats & Upload Limits

- **Supported Formats:** `MP3`, `WAV`, `M4A` / `MP4`, `AAC`, `OGG`, `OPUS`, `WEBM`, `FLAC`, `WMA`
- **Maximum File Size:** **20 MB** (enforced on both the frontend and backend)
- **Server Validation:** Uploaded files are validated against a strict audio MIME allowlist and container magic-byte signatures before being sent to Gemini.

## API Security & Configurable Limits

The backend endpoint `POST /api/transcribe-audio-stream` includes built-in protections configurable via environment variables in `.env`:

| Environment Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | *(required)* | Server-side Gemini API key. Returns HTTP `503` if unset. |
| `PORT` | `3000` | HTTP port for the Express server. |
| `ALLOWED_ORIGINS` | *(same-origin)* | Comma-separated list of additional allowed browser origins (e.g. `https://app.example.com`). Localhost is allowed automatically in non-production mode. |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | Sliding window duration in milliseconds per client IP. |
| `RATE_LIMIT_MAX_REQUESTS` | `15` | Maximum transcription requests per IP per rate-limit window. |
| `MAX_CONCURRENT_PER_IP` | `2` | Maximum simultaneous active transcriptions per client IP. |
| `MAX_CONCURRENT_GLOBAL` | `10` | Maximum simultaneous active transcriptions across the entire server. |
| `TRANSCRIPTION_TIMEOUT_MS` | `120000` (2 min) | Hard timeout for each transcription stream. |

## Deployment Security Warnings

Before deploying this application to a **publicly accessible URL**, keep the following in mind:

1. **No End-User Authentication:** This repository does not include user accounts or login by default. Anyone who can reach your public URL can consume your `GEMINI_API_KEY` quota up to the configured rate limits. For private or team deployments, place the app behind authentication (e.g., Identity-Aware Proxy, OAuth, or a server-side access gate).
2. **Set Cloud Billing & Quota Caps:** Always set strict daily request limits and billing alerts on your Gemini API key in Google Cloud Console.
3. **In-Memory Rate Limiter:** The built-in rate limiter and concurrency tracker are stored in Node.js process memory. If you scale horizontally across multiple server instances, use a shared store (such as Redis) or API gateway rate limiting.
4. **Reverse Proxy Configuration:** `server.ts` enables `trust proxy` (`1` hop). Ensure your hosting proxy overwrites `X-Forwarded-For` and `X-Forwarded-Host` so clients cannot spoof IP addresses or host headers.
5. **PWA Icon Notice:** `manifest.json` currently references an external icon URL. If you plan to redistribute or white-label the app, replace it with your own locally hosted icon asset.

## Troubleshooting

- **"Audio transcription service is not configured on the server" (`503`):** Verify that `GEMINI_API_KEY` is set in your `.env` file or hosting environment and restart the server.
- **"Audio file exceeds the 20 MB maximum upload limit" (`413`):** Compress or trim your audio recording (for example, converting a large stereo WAV to mono MP3/M4A) so it is under 20 MB.
- **"Unsupported audio format" / "Uploaded file does not match a valid supported audio format" (`415`):** Ensure the file is a genuine audio file in one of the supported formats and not a renamed video, image, or document file.
- **"Too many transcription requests" (`429`):** Wait until the rate-limit window resets (see the `Retry-After` header) or adjust `RATE_LIMIT_MAX_REQUESTS` / `MAX_CONCURRENT_PER_IP` for your local setup.
- **"Request origin is not allowed" (`403`):** If accessing the API from a different frontend origin, add that exact origin (including protocol and port) to `ALLOWED_ORIGINS`.

## License

This project is licensed under the [MIT License](LICENSE).
