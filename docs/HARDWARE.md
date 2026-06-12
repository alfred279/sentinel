# Hardware Guide

## The hub
| Setup | Recommended | Notes |
|---|---|---|
| 1–3 cameras, motion recording | Raspberry Pi 5 (8GB) + NVMe | Hardware H.265 decode; quiet, cheap |
| 4–8 cameras, continuous 4K | Intel N100 mini PC | QuickSync hardware decode is the workhorse |
| 8+ cameras / AI detection | NUC i5/i7 or Coral TPU + Frigate | Add a Coral TPU for fast person detection |

## Storage math (plan for this — disk fills fast at 4K)
- 4K H.265 continuous ≈ **15–30 GB / camera / day**
- 4 cameras continuous ≈ ~80 GB/day ≈ a 4TB drive lasts ~5–7 weeks
- **Motion-only recording** cuts this 70–90% for most homes
- Use a dedicated drive for ./data/recordings; SSD/NVMe for the DB

## Hardware acceleration (critical for 4K)
Software-decoding multiple 4K streams will peg any CPU. Sentinel avoids transcode
where possible (codec-copy recording, native-codec WebRTC). Where transcode is
unavoidable (HLS fallback / incompatible clients), enable:
- Intel: VAAPI / QuickSync
- NVIDIA: NVDEC/NVENC
- Raspberry Pi: V4L2 M2M

## Network
- Put cameras on a VLAN with no internet access (security best practice — cheap
  cameras are a common breach vector). The hub bridges them to your app.
- Wire cameras over Ethernet/PoE where possible; 4K over flaky WiFi drops frames.
