import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encryptSecret } from '../config.js';
import { go2rtc } from '../services/go2rtc.js';
import { discoverCameras, resolveStreamUrls } from '../services/onvif-discovery.js';

const addCameraSchema = z.object({
  name: z.string().min(1).max(80),
  location_label: z.string().max(80).optional(),
  // Either a discovered ONVIF device (xaddr) OR a manual RTSP url
  xaddr: z.string().url().optional(),
  rtsp_url: z.string().url().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  record_mode: z.enum(['continuous', 'motion', 'off']).default('continuous'),
});

export async function cameraRoutes(app: FastifyInstance) {
  const { db, log, health, recorder, emit } = app.sentinel;

  // ── Scan the LAN for ONVIF cameras ──
  app.post('/homes/:homeId/cameras/discover', async (req) => {
    const cameras = await discoverCameras(5000, log);
    return { cameras };
  });

  // ── Add a camera — VALIDATE connectivity before we ever save it ──
  app.post('/homes/:homeId/cameras', async (req, reply) => {
    const { homeId } = req.params as { homeId: string };
    const body = addCameraSchema.parse(req.body);

    // Resolve the real RTSP url(s)
    let mainUrl = body.rtsp_url;
    let capabilities: Record<string, unknown> = {};
    if (body.xaddr && body.username && body.password) {
      const resolved = await resolveStreamUrls(body.xaddr, body.username, body.password);
      mainUrl = resolved.main;
      capabilities = resolved.capabilities;
    }
    if (!mainUrl) {
      return reply.code(400).send({ error: 'Provide an ONVIF device + credentials or an RTSP URL' });
    }

    // Build an authenticated RTSP url for go2rtc if creds were given separately
    const streamName = `cam_${crypto.randomUUID().slice(0, 8)}`;
    const authedUrl =
      body.username && body.password && !mainUrl.includes('@')
        ? mainUrl.replace('rtsp://', `rtsp://${encodeURIComponent(body.username)}:${encodeURIComponent(body.password)}@`)
        : mainUrl;

    // Register with go2rtc and CONFIRM it actually goes live before persisting.
    await go2rtc.putStream(streamName, authedUrl);
    const ok = await waitForLive(streamName);
    if (!ok) {
      await go2rtc.deleteStream(streamName);
      return reply.code(422).send({
        error: 'Could not connect to the camera. Check the IP, credentials, and that it supports RTSP/ONVIF.',
      });
    }

    const { rows } = await db.query(
      `INSERT INTO cameras
        (home_id, name, location_label, rtsp_user_enc, rtsp_pass_enc,
         main_stream_url, go2rtc_name, capabilities, status, record_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'online',$9)
       RETURNING id, name, location_label, status, record_mode, capabilities`,
      [
        homeId,
        body.name,
        body.location_label ?? null,
        body.username ? encryptSecret(body.username) : null,
        body.password ? encryptSecret(body.password) : null,
        mainUrl,
        streamName,
        capabilities,
        body.record_mode,
      ],
    );
    const cam = rows[0];

    // Start watching + recording
    health.watch(cam.id, streamName);
    if (body.record_mode !== 'off') recorder.start(cam.id, streamName);

    return reply.code(201).send(cam);
  });

  // ── List cameras with live status ──
  app.get('/homes/:homeId/cameras', async (req) => {
    const { homeId } = req.params as { homeId: string };
    const { rows } = await db.query(
      `SELECT id, name, location_label, status, last_seen_at, record_mode, capabilities
       FROM cameras WHERE home_id = $1 ORDER BY name`,
      [homeId],
    );
    return { cameras: rows };
  });

  // ── Get live view URLs (creds never exposed) ──
  app.get('/cameras/:id/live', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await db.query('SELECT go2rtc_name FROM cameras WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Camera not found' });
    return go2rtc.liveUrls(rows[0].go2rtc_name);
  });

  // ── Remove a camera ──
  app.delete('/cameras/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await db.query('SELECT go2rtc_name FROM cameras WHERE id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Camera not found' });
    health.unwatch(id);
    recorder.stop(id);
    await go2rtc.deleteStream(rows[0].go2rtc_name);
    await db.query('DELETE FROM cameras WHERE id = $1', [id]);
    return reply.code(204).send();
  });
}

async function waitForLive(streamName: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await go2rtc.isStreamLive(streamName)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
