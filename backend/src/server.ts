import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import pino from 'pino';
import pg from 'pg';
import { config } from './config.js';
import { HealthMonitor } from './services/health-monitor.js';
import { Recorder } from './services/recorder.js';
import { cameraRoutes } from './routes/cameras.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const db = new pg.Pool({ connectionString: config.databaseUrl });

// ── WebSocket fan-out for realtime events (status changes, new detections) ──
const sockets = new Set<import('ws').WebSocket>();
function emit(event: { camera_id: string; type: string }) {
  const msg = JSON.stringify({ kind: 'event', ...event, at: new Date().toISOString() });
  for (const s of sockets) {
    try { s.send(msg); } catch { /* dropped client */ }
  }
}

const health = new HealthMonitor(db, log, emit);
const recorder = new Recorder(db, log);

// Make shared services available to routes
declare module 'fastify' {
  interface FastifyInstance {
    sentinel: {
      db: pg.Pool;
      log: typeof log;
      health: HealthMonitor;
      recorder: Recorder;
      emit: typeof emit;
    };
  }
}

async function main() {
  const app = Fastify({ logger: log });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(websocket);

  app.decorate('sentinel', { db, log, health, recorder, emit });

  app.get('/health', async () => {
    const cams = await db.query(
      `SELECT status, count(*)::int AS n FROM cameras GROUP BY status`,
    );
    return {
      ok: true,
      cameras: Object.fromEntries(cams.rows.map((r) => [r.status, r.n])),
      time: new Date().toISOString(),
    };
  });

  app.register(async (w) => {
    w.get('/ws', { websocket: true }, (conn) => {
      sockets.add(conn.socket);
      conn.socket.on('close', () => sockets.delete(conn.socket));
    });
  });

  // TODO(Phase 0): authRoutes, homeRoutes  |  (Phase 3): recordingRoutes  |  (Phase 4): alertRoutes
  await app.register(cameraRoutes);

  // On boot, resume watching + recording every enabled camera (survives restarts)
  const { rows } = await db.query(
    `SELECT id, go2rtc_name, record_mode FROM cameras WHERE enabled = true`,
  );
  for (const c of rows) {
    if (c.go2rtc_name) {
      health.watch(c.id, c.go2rtc_name);
      if (c.record_mode !== 'off') recorder.start(c.id, c.go2rtc_name);
    }
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  log.info(`Sentinel backend listening on :${config.port}`);
}

main().catch((e) => {
  log.error(e, 'fatal startup error');
  process.exit(1);
});
