import sodium from 'libsodium-wrappers';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL!,
  go2rtcUrl: process.env.GO2RTC_URL ?? 'http://localhost:1984',
  jwtSecret: process.env.JWT_SECRET!,
  recordingsPath: process.env.RECORDINGS_PATH ?? '/recordings',
  // 32-byte hex key seeding the libsodium secretbox used for camera creds
  hubEncryptionKey: process.env.HUB_ENCRYPTION_KEY!,
};

for (const [k, v] of Object.entries({
  DATABASE_URL: config.databaseUrl,
  JWT_SECRET: config.jwtSecret,
  HUB_ENCRYPTION_KEY: config.hubEncryptionKey,
})) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

// ── Camera credential encryption ──────────────────────────────────────────
// Camera RTSP passwords NEVER hit the DB in plaintext. We encrypt with a
// hub-local key so a leaked DB dump alone cannot expose a household's cameras.
let key: Uint8Array;
await sodium.ready;
key = sodium.from_hex(config.hubEncryptionKey.padEnd(64, '0').slice(0, 64));

export function encryptSecret(plaintext: string): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return sodium.to_base64(nonce) + ':' + sodium.to_base64(cipher);
}

export function decryptSecret(blob: string): string {
  const [n, c] = blob.split(':');
  const nonce = sodium.from_base64(n);
  const cipher = sodium.from_base64(c);
  const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  return sodium.to_string(plain);
}
