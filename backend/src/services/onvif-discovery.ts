import onvif from 'onvif';
import type { Logger } from 'pino';

export type DiscoveredCamera = {
  name: string;
  ip: string;
  xaddr: string;          // ONVIF device service URL
  manufacturer?: string;
  model?: string;
};

/**
 * ONVIF WS-Discovery: broadcasts on the LAN and collects responding cameras.
 * This is what powers the "Scan for cameras" button — the non-technical user
 * never has to know an RTSP URL or IP. We resolve the actual RTSP profile URLs
 * after they pick a camera and provide credentials.
 */
export function discoverCameras(timeoutMs = 5000, log?: Logger): Promise<DiscoveredCamera[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredCamera>();

    onvif.Discovery.on('device', (cam: any, _rinfo: any, _xml: any) => {
      try {
        const xaddr: string = cam?.xaddrs?.[0] ?? cam?.xaddr ?? '';
        const ip = new URL(xaddr).hostname;
        if (!found.has(ip)) {
          found.set(ip, {
            name: cam?.name ?? `Camera ${ip}`,
            ip,
            xaddr,
            manufacturer: cam?.hardware,
          });
        }
      } catch (e) {
        log?.debug({ e }, 'failed to parse discovered device');
      }
    });

    onvif.Discovery.on('error', (e: unknown) => log?.warn({ e }, 'discovery error'));
    onvif.Discovery.probe();

    setTimeout(() => {
      onvif.Discovery.removeAllListeners('device');
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/**
 * Once the user provides credentials, connect via ONVIF to pull the real
 * RTSP stream profile URLs (main 4K + sub-stream) and capabilities.
 */
export function resolveStreamUrls(
  xaddr: string,
  user: string,
  pass: string,
): Promise<{ main: string; sub?: string; capabilities: Record<string, unknown> }> {
  const host = new URL(xaddr).hostname;
  const port = Number(new URL(xaddr).port) || 80;

  return new Promise((resolve, reject) => {
    const cam = new onvif.Cam(
      { hostname: host, username: user, password: pass, port },
      function (this: any, err: Error | null) {
        if (err) return reject(err);
        this.getStreamUri(
          { protocol: 'RTSP' },
          (e: Error | null, stream: { uri: string }) => {
            if (e) return reject(e);
            const caps = {
              ptz: Boolean(this.capabilities?.PTZ),
              audio: Boolean(this.videoSources?.[0]?.audioSources),
            };
            // Many cameras expose a second (sub) profile; map it where available.
            resolve({ main: stream.uri, capabilities: caps });
          },
        );
      },
    );
  });
}
