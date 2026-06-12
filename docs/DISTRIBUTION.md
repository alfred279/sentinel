# Distribution — turning Sentinel from code into a downloadable program

There are two separate "downloadable" things, don't confuse them:

1. **The hub** — the actual program, runs 24/7 on a box at home.
2. **The viewer** — the app on a phone/laptop people use to watch. Optional;
   the hub already serves a web UI any browser can open.

---

## Part 1: Ship the hub (do this first)

### Step 1 — Publish prebuilt images (once)
1. Replace `YOUR_GH_USERNAME` with your GitHub username in:
   `install.sh`, `docker-compose.prod.yml`.
2. Push the repo to GitHub.
3. Tag a release: `git tag v0.1.0 && git push origin v0.1.0`.
4. `.github/workflows/release.yml` builds multi-arch images (Pi + Intel) and
   publishes them to GHCR. Make the packages public in your repo settings.

Now your code exists as **installable artifacts**, not source.

### Step 2 — Users install with one command
On their hub (Pi 5, Intel mini PC, any Linux box):
```bash
curl -fsSL https://raw.githubusercontent.com/YOU/sentinel/main/install.sh | sudo bash
```
That script installs Docker, pulls the images, generates secrets, starts
everything, and registers a **systemd service** so it auto-starts on boot and
self-heals. To them, it's a program — they never see source or run a build.

Manage it like any service: `systemctl restart sentinel`, `systemctl status sentinel`.

> This single step gets you ~90% of the "real program" experience. Don't build
> the fancier options below until you have actual users asking for them.

---

## Part 2: Nicer installers (later, when you have traction)

### Option A — `.deb` package (Debian / Ubuntu / Raspberry Pi OS)
Wrap the install logic in a `.deb` so users `apt install ./sentinel.deb`. The
package's post-install hook does what `install.sh` does. Feels native; shows up
in the package manager; clean uninstall.

### Option B — Prebuilt OS image (the appliance dream)
Build a custom OS image (Debian + Sentinel preinstalled) with a tool like
`packer` or `mkosi`, the way Home Assistant ships HAOS. Users flash it with
Raspberry Pi Imager / Balena Etcher, boot, and it's running. Most consumer-
friendly, most work. This is the path if you ever sell preloaded hardware.

---

## Part 3: The viewer app (optional, separate download)

The hub already serves a browser UI. To make a *downloadable* viewer:

- **PWA (do this first):** make the React frontend installable — add a manifest
  + service worker. Users "Add to Home Screen" on phones and "Install" on
  desktop. Zero app-store friction. Works today, costs almost nothing.
- **Desktop app:** wrap the frontend in **Tauri** (tiny, Rust-based) for real
  `.dmg` / `.exe` / `.AppImage` downloads. Better than Electron for size.
- **Mobile app stores:** wrap with **Capacitor** (reuses the React code) to ship
  to the App Store / Play Store when you want push notifications + store presence.

Recommended order: PWA → Tauri desktop → Capacitor mobile. Reuse one React
codebase across all three.

---

## Reality check
The hub is the program. A 24/7 security recorder should run headless as a
service (Part 1), not depend on a desktop app window being open. Build the
viewer apps as *clients* to that hub, not as the system itself.
