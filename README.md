# Sentinel — Self-Hosted 4K Home Security Platform

Reliable, private, self-hosted security camera system. Runs on a hub at home,
connects to 4K ONVIF/RTSP IP cameras, records 24/7, detects people/vehicles,
and streams live + recorded video to a web/mobile app — locally and remotely.

**Reliability is the product.** Per-camera watchdogs with auto-reconnect,
supervised recording with gap detection, disk guardrails, and local-first
operation (keeps recording even when the internet is down).

## Why this architecture
We don't reinvent the video pipeline. We stand on:
- **go2rtc** — RTSP → WebRTC (sub-second live) / HLS streaming engine
- **FFmpeg** — supervised segmented recording (codec-copy, no 4K transcode)
- **Frigate** (Phase 4) — local AI object detection, no cloud inference cost

We build the product layer: accounts, camera management, reliability, alerts,
playback, and UX. See `CLAUDE.md` for the full spec and phased build plan.

## Quickstart (on the hub)
```bash
cp .env.example .env
# generate secrets:
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
# set a strong DB_PASSWORD in .env, then:
docker compose up -d
```
- App: http://<hub-ip>:8080
- Backend health: http://<hub-ip>:4000/health
- go2rtc UI (LAN only): http://<hub-ip>:1984

## Project map
```
sentinel/
├── CLAUDE.md            ← read this first; the build spec for Claude Code
├── docker-compose.yml   ← runs go2rtc + postgres + backend + frontend
├── go2rtc.yaml          ← streaming engine config (backend manages streams)
├── .env.example
├── db/schema.sql        ← Postgres DDL (encrypted camera creds)
├── backend/             ← Fastify + TypeScript API
│   └── src/
│       ├── server.ts            ← bootstrap, websocket fan-out, /health
│       ├── config.ts            ← env + libsodium credential encryption
│       ├── routes/cameras.ts    ← discover / add (validated) / live / delete
│       └── services/
│           ├── go2rtc.ts          ← streaming engine client
│           ├── onvif-discovery.ts ← LAN auto-discovery of cameras
│           ├── health-monitor.ts  ← watchdog + reconnect (reliability core)
│           └── recorder.ts        ← supervised 24/7 recording + gap detection
├── frontend/            ← React + Vite (live grid, timeline, management)
└── docs/                ← HARDWARE.md, REMOTE_ACCESS.md
```

## Hardware you'll want
- A hub: Raspberry Pi 5 (small setups), or an Intel N100/NUC (more cameras,
  hardware decode). 4K @ 24/7 across several cameras wants hardware accel.
- Storage: ~15–30 GB per 4K camera per day on continuous H.265. A 4TB drive
  ≈ weeks of footage for a few cameras. Motion-only recording stretches it far.
- Cameras: any ONVIF + RTSP 4K IP camera. Two stream profiles (main 4K + sub)
  strongly recommended — see `go2rtc.yaml`.

See `docs/HARDWARE.md` and `docs/REMOTE_ACCESS.md`.

## Status
Scaffold + Phase 0/1 foundation. Hand `CLAUDE.md` to Claude Code and build the
phases in order. Each phase ends in something you can test on real hardware.
