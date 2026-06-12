# Remote Access

Goal: watch your cameras from your phone away from home, WITHOUT exposing the
hub to the public internet (don't port-forward camera systems — they get
scanned and attacked constantly).

## Recommended: Tailscale (easiest, secure)
1. Install Tailscale on the hub and on each phone/laptop.
2. Access the app at the hub's Tailscale IP from anywhere. Encrypted, no open
   ports, no DNS, no certs to manage.

## Alternative: Cloudflare Tunnel
Exposes only the app (not camera streams) over an authenticated tunnel.

## What NOT to do
- Don't port-forward 554/RTSP, 1984/go2rtc, or 5432/Postgres to the internet.
- Don't put cameras directly on the public internet.

## Productizing later
If you turn this into a product, the remote-access layer is where a managed
relay service (and a subscription) naturally lives — you run the relay, the
customer gets zero-config remote viewing. Build local-first now; add the relay
when you commercialize.
