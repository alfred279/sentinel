import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { config } from '../config.js';

/**
 * Recorder. Pulls the camera's stream from go2rtc and writes segmented MP4
 * files (default 5-min segments) to disk. SUPERVISED: if FFmpeg dies, we
 * restart within RESTART_DELAY and log a recording_gap event — because a
 * security camera that stops recording without telling you is a liability.
 *
 * 4K NOTE: we copy the codec (-c copy) instead of transcoding. The camera
 * already encoded H.265/H.264 efficiently; re-encoding 4K 24/7 would cook the
 * CPU for zero benefit. Transcode only happens at the streaming layer when a
 * client genuinely can't play the native codec.
 */

const SEGMENT_SECONDS = 300;
const RESTART_DELAY_MS = 5000;

type Job = { proc: ChildProcess; cameraId: string; restarts: number; stopping: boolean };

export class Recorder {
  private jobs = new Map<string, Job>();

  constructor(private db: Pool, private log: Logger) {}

  start(cameraId: string, streamName: string) {
    if (this.jobs.has(cameraId)) return;
    this.spawnJob(cameraId, streamName, 0);
  }

  stop(cameraId: string) {
    const job = this.jobs.get(cameraId);
    if (!job) return;
    job.stopping = true;
    job.proc.kill('SIGTERM');
    this.jobs.delete(cameraId);
  }

  private spawnJob(cameraId: string, streamName: string, restarts: number) {
    const dir = join(config.recordingsPath, cameraId);
    mkdirSync(dir, { recursive: true });

    // Pull from go2rtc's RTSP republish (stable internal endpoint), segment to MP4.
    const input = `${config.go2rtcUrl.replace('http', 'rtsp').replace(':1984', ':8554')}/${streamName}`;
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', input,
      '-c', 'copy',                         // no transcode — preserve 4K, save CPU
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '1',
      join(dir, '%Y-%m-%d_%H-%M-%S.mp4'),
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const job: Job = { proc, cameraId, restarts, stopping: false };
    this.jobs.set(cameraId, job);
    this.log.info({ cameraId, restarts }, 'recorder started');

    proc.on('exit', (code) => {
      if (job.stopping) return;
      this.log.error({ cameraId, code, restarts }, 'recorder exited unexpectedly');
      void this.logGap(cameraId);
      setTimeout(
        () => this.spawnJob(cameraId, streamName, restarts + 1),
        RESTART_DELAY_MS,
      );
    });
  }

  private async logGap(cameraId: string) {
    await this.db.query(
      `INSERT INTO events (camera_id, home_id, type, metadata)
       SELECT id, home_id, 'recording_gap'::event_type, '{"reason":"recorder_exit"}'::jsonb
       FROM cameras WHERE id = $1`,
      [cameraId],
    );
  }
}
