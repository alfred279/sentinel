import { config } from '../config.js';

/**
 * Thin client around the go2rtc REST API. The backend is the ONLY thing that
 * talks to go2rtc — it registers a camera's RTSP source under a stream key,
 * then hands clients short-lived WebRTC/HLS URLs that reference that key.
 * Clients never see the RTSP URL or camera credentials.
 */
export const go2rtc = {
  /** Register (or replace) a camera's RTSP source under a stream key. */
  async putStream(streamName: string, rtspUrl: string): Promise<void> {
    const url = `${config.go2rtcUrl}/api/streams?name=${encodeURIComponent(
      streamName,
    )}&src=${encodeURIComponent(rtspUrl)}`;
    const res = await fetch(url, { method: 'PUT' });
    if (!res.ok) throw new Error(`go2rtc putStream failed: ${res.status}`);
  },

  async deleteStream(streamName: string): Promise<void> {
    await fetch(
      `${config.go2rtcUrl}/api/streams?src=${encodeURIComponent(streamName)}`,
      { method: 'DELETE' },
    );
  },

  /** True if go2rtc currently has a live producer for this stream. */
  async isStreamLive(streamName: string): Promise<boolean> {
    const res = await fetch(`${config.go2rtcUrl}/api/streams`);
    if (!res.ok) return false;
    const streams = (await res.json()) as Record<string, { producers?: unknown[] }>;
    const s = streams[streamName];
    return Boolean(s && Array.isArray(s.producers) && s.producers.length > 0);
  },

  /** URLs handed to the frontend for live view. Sub-stream used for grids. */
  liveUrls(streamName: string) {
    const base = config.go2rtcUrl;
    return {
      webrtc: `${base}/api/ws?src=${encodeURIComponent(streamName)}`, // WebRTC signaling
      hls: `${base}/api/stream.m3u8?src=${encodeURIComponent(streamName)}`,
      snapshot: `${base}/api/frame.jpeg?src=${encodeURIComponent(streamName)}`,
    };
  },
};
