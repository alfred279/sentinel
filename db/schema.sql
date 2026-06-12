-- Sentinel database schema (PostgreSQL 16)
-- Authoritative DDL. Camera credentials are stored ENCRYPTED (libsodium secretbox),
-- never plaintext — the backend encrypts before insert and decrypts on read.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Accounts ──────────────────────────────────────────────────────────────
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,            -- argon2id
    display_name  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE homes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    timezone   TEXT NOT NULL DEFAULT 'America/Chicago',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE member_role AS ENUM ('owner', 'admin', 'viewer');

CREATE TABLE home_members (
    home_id UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    member_role NOT NULL DEFAULT 'viewer',
    PRIMARY KEY (home_id, user_id)
);

-- ── Cameras ───────────────────────────────────────────────────────────────
CREATE TYPE camera_status AS ENUM ('online', 'offline', 'connecting', 'error', 'disabled');

CREATE TABLE cameras (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    home_id         UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,                 -- "Front Door"
    location_label  TEXT,                          -- "Exterior"
    manufacturer    TEXT,
    model           TEXT,
    ip_address      INET,
    -- encrypted credential blobs (libsodium secretbox, base64) — never plaintext
    rtsp_user_enc   TEXT,
    rtsp_pass_enc   TEXT,
    main_stream_url TEXT,                          -- full 4K profile
    sub_stream_url  TEXT,                          -- low-res profile
    go2rtc_name     TEXT UNIQUE,                   -- stream key registered in go2rtc
    capabilities    JSONB NOT NULL DEFAULT '{}',   -- {resolution, codec, ptz, audio}
    status          camera_status NOT NULL DEFAULT 'connecting',
    last_seen_at    TIMESTAMPTZ,
    record_mode     TEXT NOT NULL DEFAULT 'continuous', -- continuous | motion | off
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cameras_home ON cameras(home_id);

-- ── Recordings ────────────────────────────────────────────────────────────
CREATE TYPE record_trigger AS ENUM ('continuous', 'motion', 'manual');

CREATE TABLE recordings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id   UUID NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    file_path   TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ,
    duration_s  INTEGER,
    size_bytes  BIGINT,
    trigger     record_trigger NOT NULL DEFAULT 'continuous',
    protected   BOOLEAN NOT NULL DEFAULT false,    -- exempt from retention pruning
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recordings_camera_time ON recordings(camera_id, started_at DESC);

-- ── Events ────────────────────────────────────────────────────────────────
CREATE TYPE event_type AS ENUM
    ('motion', 'person', 'vehicle', 'animal', 'offline', 'online', 'tamper', 'recording_gap');

CREATE TABLE events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id     UUID REFERENCES cameras(id) ON DELETE CASCADE,
    home_id       UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
    type          event_type NOT NULL,
    confidence    REAL,                            -- 0..1 for detection events
    thumbnail_path TEXT,
    recording_id  UUID REFERENCES recordings(id) ON DELETE SET NULL,
    metadata      JSONB NOT NULL DEFAULT '{}',
    acknowledged  BOOLEAN NOT NULL DEFAULT false,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_home_time ON events(home_id, occurred_at DESC);
CREATE INDEX idx_events_camera_time ON events(camera_id, occurred_at DESC);

-- ── Alert rules ───────────────────────────────────────────────────────────
CREATE TABLE alert_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    home_id     UUID NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
    camera_id   UUID REFERENCES cameras(id) ON DELETE CASCADE,  -- NULL = all cameras
    event_types event_type[] NOT NULL,
    schedule    JSONB NOT NULL DEFAULT '{}',       -- {"start":"22:00","end":"06:00","days":[...]}
    channels    TEXT[] NOT NULL DEFAULT '{push}',  -- push | email | webhook
    enabled     BOOLEAN NOT NULL DEFAULT true
);

-- ── Push devices ──────────────────────────────────────────────────────────
CREATE TABLE devices (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    push_token  TEXT NOT NULL,
    platform    TEXT NOT NULL,                     -- web | ios | android
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Refresh tokens ────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
