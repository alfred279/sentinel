# Sentinel — Self-Hosted 4K Home Security Camera Platform

> This file is the source of truth for Claude Code. Read it fully before writing or editing anything. Build in the phase order defined below. Do not skip ahead — each phase produces something testable.

---

## 1. What we are building

Sentinel is a self-hosted, reliable home security camera system. A user runs a **hub** (mini PC, Raspberry Pi 5, NUC, or any always-on Linux box) on their home network. The hub discovers and connects to their IP cameras (4K ONVIF/RTSP cameras), records footage, detects motion/objects, and serves live + recorded video to a web and mobile app — both at home and remotely.

**The core promise to the user: it just works, and it keeps working.** Reliability is the product. A security camera that drops its stream or silently stops recording is worse than no camera, because it creates false confidence.

### What we are NOT building from scratch
We do **not** write our own video pipeline, codec handling, WebRTC signaling, or NAT traversal. Those are solved. We integrate:

- **go2rtc** — ingests RTSP from cameras, restreams as WebRTC (sub-second live view), HLS (compatibility), and serves snapshots. This is the streaming engine. We orchestrate it; we do not reimplement it.
- **Frigate** (Phase 4, optional) — local AI object detection (person/car/animal) to make alerts smart instead of "a tree moved."
- **FFmpeg** — only where go2rtc doesn't cover us (recording segmentation, thumbnail generation).

Our job is the **product layer**: account/home/camera management, secure remote access brokering, recording lifecycle, the events/alerts system, playback timeline, notifications, and the app UX.

---

## 2. Tech stack (do not substitute without reason)

| Layer | Choice | Why |
|---|---|---|
| Streaming engine | **go2rtc** (Docker) | Best-in-class RTSP→WebRTC/HLS, low latency, used by Home Assistant |
| Backend API | **Node 20 + TypeScript + Fastify** | Fast, typed, matches existing skillset |
| Database | **PostgreSQL 16** (Supabase-compatible) | Relational data: homes, cameras, events, recordings |
| Recording | **FFmpeg** writing segmented MP4/fMP4 | Reliable, hardware-accel capable |
| Object detection | **Frigate** (Phase 4) | Local, private, no cloud inference cost |
| Frontend | **React + TypeScript + Vite + Tailwind** | Live grid, timeline playback, management |
| Live video in browser | **WebRTC** (primary) → **HLS** (fallback) | WebRTC = lowest latency; HLS = always works |
| Auth | **JWT** (access + refresh), argon2 password hashing | Standard, secure |
| Realtime alerts to app | **WebSocket** + **Web Push / FCM** | Instant in-app + push when app is closed |
| Container orchestration | **Docker Compose** | One command to run the whole hub |

---

## 3. Architecture

```
                          ┌─────────────────────────────────────────┐
   HOME NETWORK           │              THE HUB (Docker)            │
   ┌──────────┐  RTSP     │  ┌──────────┐   ┌─────────────────────┐ │
   │ 4K Cam 1 │──────────▶│  │  go2rtc  │◀──│  Sentinel Backend   │ │
   ├──────────┤  RTSP     │  │ streaming│   │  (Fastify + TS)     │ │
   │ 4K Cam 2 │──────────▶│  │  engine  │   │  - camera mgmt      │ │
   ├──────────┤           │  └────┬─────┘   │  - ONVIF discovery  │ │
   │   ...    │           │       │ WebRTC/ │  - stream broker    │ │
   └──────────┘           │       │ HLS     │  - recorder         │ │
                          │       ▼         │  - health monitor   │ │
                          │  ┌──────────┐   │  - events/alerts    │ │
                          │  │ Recorder │   │  - auth             │ │
                          │  │ (FFmpeg) │   └──────────┬──────────┘ │
                          │  └────┬─────┘              │            │
                          │       ▼                    ▼            │
                          │  ┌──────────┐        ┌──────────┐       │
                          │  │  Disk    │        │ Postgres │       │
                          │  │ (footage)│        │          │       │
                          │  └──────────┘        └──────────┘       │
                          └───────────────────────┬─────────────────┘
                                                   │ HTTPS / WSS
                          remote access via        │ (reverse tunnel
                          relay or VPN              │  or Tailscale)
                                                    ▼
                                            ┌──────────────┐
                                            │  Web / Mobile│
                                            │     App      │
                                            └──────────────┘
```

### Key principle: the backend never exposes camera credentials to clients
The frontend never gets a camera's RTSP URL or password. It asks the backend "give me a live view for camera X," the backend returns a short-lived go2rtc WebRTC/HLS URL. Camera creds live only on the hub, encrypted at rest.

---

## 4. Data model

See `db/schema.sql` for the authoritative DDL. Core tables:

- **users** — account owners and members. Argon2 password hash.
- **homes** — a physical location. One hub per home (for now).
- **home_members** — join table, role = owner | admin | viewer.
- **cameras** — name, location label, manufacturer, model, encrypted RTSP credentials, main/sub stream URLs, status, last_seen_at, capabilities (resolution, codec, ptz).
- **recordings** — camera_id, file path, start/end time, duration, size, trigger (continuous | motion | manual), retention_class.
- **events** — camera_id, type (motion | person | vehicle | offline | online | tamper), confidence, thumbnail path, clip recording_id, acknowledged.
- **alert_rules** — per camera/home: which event types notify, schedule (e.g. only 10pm–6am), quiet hours, channels.
- **devices** — push notification tokens per user device.

Every camera credential column is encrypted with a hub-local key (libsodium secretbox). Never store plaintext camera passwords.

---

## 5. Reliability requirements (this is the actual product — treat as non-negotiable)

The health monitor and recorder must guarantee these. Build them defensively.

1. **Per-camera watchdog.** Each camera stream is health-checked every 10s (probe go2rtc + RTSP reachability). On failure → exponential backoff reconnect (1s, 2s, 4s … cap 60s), never give up, log every transition.
2. **Offline alerting.** If a camera is unreachable for > 60s, raise an `offline` event and notify per alert rules. Raise `online` when it recovers.
3. **Recording never silently dies.** The recorder is supervised. If an FFmpeg recording process exits unexpectedly, restart it within 5s and log a gap event. A recording gap is itself an alertable event.
4. **Disk guardrails.** Monitor free space. At 90% full, prune oldest non-protected recordings per retention policy. At 95%, raise a critical alert. Never let the disk fill and crash the hub.
5. **Local-first.** Recording and detection run entirely on the hub. If the internet drops, the system keeps recording and alerting locally; it syncs/notifies when connectivity returns. Internet loss must never stop recording.
6. **Hardware-accelerated transcoding.** 4K at 24/7 will cook a CPU doing software transcode. Detect and use VAAPI/NVDEC/Raspberry Pi hardware decode where available; document the fallback.
7. **Graceful degradation.** If WebRTC fails (restrictive NAT), automatically fall back to HLS. If main 4K stream is too heavy for a client, serve the camera's sub-stream.
8. **Health endpoint + status page.** `/health` returns per-camera status, recorder status, disk usage, last event time. The app surfaces this prominently — the user should always know the system is actually working.

---

## 6. API surface (v1)

Auth: `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`

Homes: `GET/POST /homes`, `GET/PATCH/DELETE /homes/:id`, `POST /homes/:id/members`

Cameras:
- `GET /homes/:id/cameras` — list with live status
- `POST /homes/:id/cameras/discover` — trigger ONVIF LAN discovery, return found cameras
- `POST /homes/:id/cameras` — add a camera (validates RTSP connectivity before saving)
- `GET/PATCH/DELETE /cameras/:id`
- `POST /cameras/:id/test` — re-validate connection
- `POST /cameras/:id/ptz` — pan/tilt/zoom (if capable)

Streaming:
- `GET /cameras/:id/live` — returns `{ webrtc, hls, snapshot }` short-lived URLs
- `GET /cameras/:id/snapshot` — current still

Recordings:
- `GET /cameras/:id/recordings?from=&to=` — timeline segments
- `GET /recordings/:id/playback` — playback URL
- `POST /recordings/:id/protect` — exempt from retention pruning
- `GET /cameras/:id/timeline?date=` — events + recording coverage for scrubber

Events/Alerts:
- `GET /homes/:id/events?from=&to=&type=` — feed
- `POST /events/:id/ack`
- `GET/PUT /cameras/:id/alert-rules`

System: `GET /health`, `GET /homes/:id/status`

Realtime: `WS /ws` — pushes new events, camera status changes, recording gaps.

---

## 7. Build plan — DO THESE IN ORDER

### Phase 0 — Foundation
- Scaffold the monorepo: `backend/`, `frontend/`, `db/`, `docker-compose.yml`.
- Postgres + migrations from `db/schema.sql`.
- Fastify server with health check, config loading, structured logging (pino), error handling.
- Auth: register/login/refresh with JWT + argon2. Home + membership CRUD.
- **Done when:** I can register, log in, create a home, and `GET /health` is green.

### Phase 1 — Connect a camera (the core unlock)
- Integrate go2rtc via docker-compose. Backend manages go2rtc config (add/remove streams via its API).
- ONVIF discovery service: scan the LAN, return discovered cameras with their RTSP URLs.
- Add-camera flow: validate the RTSP stream actually connects (FFprobe) before saving. Encrypt creds at rest.
- Stream broker endpoint returning WebRTC/HLS URLs.
- **Done when:** I can discover or manually add a 4K camera and watch a low-latency live stream in the browser via WebRTC, with HLS fallback.

### Phase 2 — Reliability layer
- Per-camera health monitor with watchdog + exponential-backoff reconnect.
- Online/offline event generation + WebSocket push.
- `/status` endpoint and a status panel in the app.
- **Done when:** I can pull a camera's power, see it go offline + get alerted within 60s, plug it back in, and watch it auto-recover — no restart needed.

### Phase 3 — Recording & playback
- Recorder service: continuous + motion-triggered segmented recording via FFmpeg, supervised with auto-restart.
- Retention policies + disk guardrail pruning job.
- Recordings timeline API + frontend scrubber/playback.
- **Done when:** footage records 24/7, old footage prunes automatically, and I can scrub a timeline and play back any moment.

### Phase 4 — Smart detection & alerts
- Integrate Frigate for person/vehicle/animal detection (or motion-only fallback).
- Event generation with thumbnails + clips, alert rules (schedules, quiet hours).
- Push notifications (Web Push + FCM) and in-app feed.
- **Done when:** I get a phone notification with a thumbnail when a person is detected at night, but not when a cat walks by at noon (if rule says so).

### Phase 5 — Remote access & polish
- Remote access via Tailscale/relay (document the recommended path; don't roll your own crypto).
- Multi-camera live grid, mobile-responsive UI, PTZ controls, settings.
- Onboarding flow for non-technical users.

---

## 8. Conventions

- **Language:** TypeScript everywhere. Strict mode on. No `any` without a comment justifying it.
- **Validation:** Zod schemas on every route input. Validate at the boundary.
- **Errors:** Typed error classes. Never leak stack traces or camera creds in responses.
- **Secrets:** `.env` only, never committed. Camera creds encrypted in DB. A `HUB_ENCRYPTION_KEY` env var seeds the libsodium key.
- **Logging:** pino structured logs. Every camera state transition, recording start/stop/gap, and reconnect is logged with camera_id.
- **Tests:** Vitest. At minimum: auth, camera add/validate, health watchdog state machine, retention pruning logic.
- **Security posture:** This is a camera in someone's home. Assume hostile network. Rate-limit auth. HTTPS only in production. Principle of least exposure — only `/auth` and the app are public; camera streams are brokered, never direct.

---

## 9. Out of scope for v1 (note but don't build)
- Cloud-recorded footage backup (local-first first).
- Two-way audio.
- Multi-hub / multi-site under one account.
- Native iOS/Android apps (responsive web first; wrap later).
- Billing/subscriptions (add when productizing).

---

## 10. First action for Claude Code
Start Phase 0. Read `db/schema.sql`, `docker-compose.yml`, and `go2rtc.yaml` (already scaffolded). Stand up the backend, wire Postgres, implement auth + homes, and confirm `/health` returns green. Then stop and report before Phase 1.
