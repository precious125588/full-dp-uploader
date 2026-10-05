# full-dp-uploader

WhatsApp **Full Screen DP Uploader** — set an edge-to-edge profile picture without cropping. No blur, no zoom, just upload, pair, done.

## Features
- Full-screen WhatsApp DP via Baileys
- Pairing-code login (no QR scan needed)
- **Redesigned dark homepage** with drag & drop upload and live image preview
- **Live progress monitor**: Connecting → Pairing code → WhatsApp linked → Uploading DP → Done → Logging out → Clearing → All work cleared
- Automatic session & upload cleanup after every run

## Run locally
```bash
npm install
npm start
```
Open http://localhost:8000

## Deploy
Deploy anywhere Node.js runs (Render, Railway, your own VPS). Set the `PORT` env var if needed — it defaults to 8000.

## API
| Endpoint | Method | Description |
|---|---|---|
| `/upload` | POST | multipart `image` field — returns `{ filename }` |
| `/connect?phoneNumber=…&filename=…&sessionId=…` | GET | returns pairing `{ code, sessionId }` |
| `/connect/status?sessionId=…` | GET | live progress `{ status, step, message }` |
| `/clear` | GET | wipes `uploads/` and `session/` |

Crafted with ❤️ by Amruth ✨
