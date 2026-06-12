import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { go2rtc } from './go2rtc.js';

/**
 * Reliability core. Each enabled camera gets a watchdog that probes liveness
 * every CHECK_INTERVAL. On failure it reconnects with exponential backoff and
 * NEVER gives up. State transitions raise online/offline events and push over
 * WebSocket. A camera that silently drops is the #1 failure mode of cheap
 * security systems — this is the thing that makes Sentinel trustworthy.
 */

const CHECK_INTERVAL_MS = 10_000;
const OFFLINE_THRESHOLD_MS = 60_000;
const BACKOFF_CAP_MS = 60_000;

type CamState = {
  id: string;
  streamName: string;
  status: 'online' | 'offline' | 'connecting';
  lastSeen: number;
  failStreak: number;
  timer?: NodeJS.Timeout;
};

export class HealthMonitor {
  private cams = new Map<string, CamState>();

  constructor(
    private db: Pool,
    private log: Logger,
    private emit: (event: { camera_id: string; type: string }) => void,
  ) {}

  watch(cameraId: string, streamName: string) {
    if (this.cams.has(cameraId)) return;
    const state: CamState = {
      id: cameraId,
      streamName,
      status: 'connecting',
      lastSeen: Date.now(),
      failStreak: 0,
    };
    this.cams.set(cameraId, state);
    this.schedule(state, CHECK_INTERVAL_MS);
  }

  unwatch(cameraId: string) {
    const s = this.cams.get(cameraId);
    if (s?.timer) clearTimeout(s.timer);
    this.cams.delete(cameraId);
  }

  private schedule(state: CamState, delay: number) {
    state.timer = setTimeout(() => void this.check(state), delay);
  }

  private async check(state: CamState) {
    let live = false;
    try {
      live = await go2rtc.isStreamLive(state.streamName);
    } catch {
      live = false;
    }

    const now = Date.now();
    if (live) {
      state.lastSeen = now;
      state.failStreak = 0;
      await this.transition(state, 'online');
      this.schedule(state, CHECK_INTERVAL_MS);
    } else {
      state.failStreak++;
      const downFor = now - state.lastSeen;
      if (downFor > OFFLINE_THRESHOLD_MS) {
        await this.transition(state, 'offline');
      }
      // exponential backoff reconnect attempt, capped
      const backoff = Math.min(2 ** state.failStreak * 1000, BACKOFF_CAP_MS);
      this.log.warn(
        { cameraId: state.id, downFor, backoff },
        'camera stream down — retrying',
      );
      this.schedule(state, backoff);
    }
  }

  private async transition(state: CamState, next: 'online' | 'offline') {
    if (state.status === next) return;
    const prev = state.status;
    state.status = next;
    this.log.info({ cameraId: state.id, from: prev, to: next }, 'camera status change');

    await this.db.query(
      'UPDATE cameras SET status = $1, last_seen_at = now() WHERE id = $2',
      [next, state.id],
    );
    // raise online/offline event + push to clients
    await this.db.query(
      `INSERT INTO events (camera_id, home_id, type)
       SELECT id, home_id, $2::event_type FROM cameras WHERE id = $1`,
      [state.id, next],
    );
    this.emit({ camera_id: state.id, type: next });
  }
}
