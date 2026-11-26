# QuickDrop

**Free, instant file and text transfer between any two devices.** No sign-up, no app, no email or phone number.
Pick files, then scan the **QR code** or type the **6-digit code** on the other device.

```
 Laptop                                   Phone
 ┌──────────────────────┐                 ┌───────────────────┐
 │ 1. Send              │   scan QR  or   │ 3. Receive        │
 │    Files & text      │ ──────────────▶ │    Accept → done  │
 │ 2. Connect           │  enter 482 913  │    live progress  │
 │    QR + 6-digit code │                 │                   │
 └──────────────────────┘                 └───────────────────┘
```

## Features

- **No login required.** An optional free account only raises the limits and keeps your history across devices.
- **QR code, link or six-digit one-time code.** The QR encodes a temporary transfer link. The code is short-lived, rate-limited and single-use.
- **Two delivery modes:**
  - **Live**: device to device over WebRTC, with no size limit and nothing stored. It falls back to an encrypted relay through the server if the two networks can't connect directly.
  - **Upload**: encrypted chunks are stored for up to 24 h (7 days with an account). The receiver can start downloading while the upload is still running.
- **Accept step.** The receiver sees what's coming (file names, sizes, message) before anything downloads.
- **Live progress on both screens**, with speed and time left. The sender also sees "Code entered on iPhone · Safari", "Delivered".
- **Files and text.** Send a message, link or Wi‑Fi password, alone or along with files.
- **End-to-end encrypted.** AES-256-GCM in the browser, so the server only ever handles ciphertext.
- Image and video previews, "Save all" as a ZIP, an in-app QR scanner, drag & drop and paste.
- Installable as an app (PWA). Light and dark themes, responsive, accessible.

## Quick start

Requires **Node.js 22.5+** (it uses the built-in `node:sqlite`).

```bash
cd apps/quickdrop
npm install
npm start            # http://localhost:3000
```

Open `http://localhost:3000` in two browser windows (or two browsers) to try a transfer.

> **Testing with a phone?** Browsers only allow in-page encryption and the camera on **HTTPS** (or `localhost`),
> so `http://192.168.x.x:3000` won't work. Use a tunnel such as `cloudflared tunnel --url http://localhost:3000`
> or `ngrok http 3000`, or deploy it (below).

## How it works

| Step | What happens |
|---|---|
| Send | The browser generates a random 256-bit key and encrypts the file list and every 1 MiB (Upload) or 60 KiB (Live) chunk with AES-GCM. |
| QR / link | `https://your.site/r/<transfer-id>#<key>`. The key sits after `#`, which browsers never send to any server. |
| 6-digit code | The sender's browser picks the code and sends the server only `SHA-256(code)` plus the transfer key wrapped with a PBKDF2 key derived from the code. |
| Receive | The receiver claims the code (or opens the link), decrypts the file list, taps **Accept**, and the chunks are fetched (Upload) or streamed (Live) and decrypted locally. |
| Clean-up | One-time transfers are deleted right after delivery. Everything else is deleted when it expires. |

### Security model

- **QR code and link: zero-knowledge.** The key never reaches the server, so neither the server operator nor anyone who steals the storage can read your files or file names.
- **6-digit code: convenience with guardrails.** A six-digit code has only a million combinations, so it is protected by:
  - a short lifetime (`CODE_TTL_MINUTES`, default 60)
  - single use for one-time transfers
  - a per-IP limit on wrong guesses
  - a sender notification showing which device used the code

  While a code is active the server holds the key wrapped with it. That stops anyone who only has the storage, but not a malicious server operator. Once the code is used or expires, the wrapped key is deleted. For the strongest privacy, share the QR or link instead.
- **Live transfers** use app-level encryption on top of WebRTC's DTLS, so the relay fallback is still end-to-end encrypted.
- **Server hardening:**
  - a strict Content-Security-Policy, `Referrer-Policy: no-referrer` and no third-party scripts or trackers
  - CSRF protection: a custom header is required on every write
  - scrypt password hashing and HttpOnly session cookies
  - rate limits, size quotas and path-traversal checks

## Configuration

All settings are environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where to listen |
| `DATA_DIR` | `./data` | SQLite database and encrypted chunks |
| `APP_NAME` | `QuickDrop` | Brand name shown in the UI |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so the real client IP and HTTPS are detected |
| `ANON_MAX_GB` / `USER_MAX_GB` | `4` / `16` | Upload-mode size limit without / with an account |
| `ANON_MAX_HOURS` / `USER_MAX_HOURS` | `24` / `168` | How long uploads are kept |
| `ANON_MAX_DOWNLOADS` / `USER_MAX_DOWNLOADS` | `10` / `100` | Max receivers per transfer |
| `STORAGE_QUOTA_GB` | `50` | Total disk space for active uploads |
| `CODE_TTL_MINUTES` | `60` | Lifetime of a 6-digit code (senders can create a new one) |
| `SIGNUP_ENABLED` | `true` | Allow creating accounts |
| `RELAY_ENABLED` | `true` | Relay Live transfers through the server when a direct connection fails |
| `STUN_URLS` | Google + Cloudflare STUN | Comma-separated STUN servers |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | – | Optional TURN server (e.g. coturn) for strict corporate networks |
| `ICE_SERVERS` | – | Full JSON `RTCIceServer[]` (overrides the STUN/TURN variables) |
| `RATE_CODE_FAILURES_PER_10MIN` | `10` | Wrong code attempts allowed per IP |
| `RATE_CREATE_PER_HOUR` | `120` | Transfers created per IP per hour |

## Deploy

Any host that runs Docker (or Node 22) **and supports WebSockets** works: a small VPS, Fly.io, Render, Railway and so on.
You need **HTTPS** and a **persistent disk** mounted at `DATA_DIR` for Upload mode.

**Docker + automatic HTTPS (Caddy):**

```bash
cd apps/quickdrop
DOMAIN=drop.example.com docker compose up -d
```

**Plain Docker:**

```bash
docker build -t quickdrop apps/quickdrop
docker run -d -p 3000:3000 -v quickdrop-data:/data -e TRUST_PROXY=true quickdrop
```

Put it behind any HTTPS reverse proxy (Caddy, nginx, Cloudflare) that forwards WebSocket upgrades on `/ws`.

### Scaling worldwide

A single instance handles a lot, because Live transfers go device to device and only signaling touches the server. To grow further:

1. Put a CDN in front for the static files. API, chunk and `/ws` traffic must reach the origin.
2. Add TURN servers in a few regions, so strict networks still get fast direct connections.
3. To run several instances: move chunks to object storage (S3/R2) and the rate limits and signaling rooms to Redis. Everything is isolated behind `ChunkStore`, `RateLimiter` and `SignalingHub`.

## Development

```bash
npm run dev          # auto-restart on changes
npm test             # unit + API tests (node:test)
npm run test:e2e     # real browser tests with Playwright + Chromium
```

The browser tests run two independent browsers as the sending and receiving devices. They cover:

- Upload mode received with the code on an emulated iPhone
- Live mode over real WebRTC
- The relay fallback
- Text-only transfers and one-time expiry

Each test checks the received files byte for byte.

```
apps/quickdrop
├── server/            Node.js server (no framework)
│   ├── app.js         HTTP routes, security headers, wiring
│   ├── transfers.js   transfers, chunks, codes, downloads, expiry
│   ├── signaling.js   WebSocket pairing, WebRTC signaling, encrypted relay
│   ├── auth.js        optional accounts (scrypt + sessions)
│   ├── storage.js     encrypted chunk storage on disk
│   └── db.js          SQLite schema (node:sqlite)
├── public/            static web app, no build step
│   ├── js/shared/     crypto, codes, chunking, zip (also used by the tests)
│   ├── js/send.js     send page and share panel
│   ├── js/receive.js  receive page: code, QR scan, accept, download
│   └── js/transport.js  WebRTC data channel + relay fallback
└── test/              unit, API and browser tests
```

## Roadmap ideas

- Stream very large files straight to disk on mobile (service worker / File System Access).
- Password-authenticated key exchange (PAKE) for 6-digit codes, so even the server can't use an active code.
- More languages, a share-sheet target for the installed app, and password reset by email.
