import { createHmac } from "node:crypto";

// RFC 6238 SHA-1, 6 digits, 30 seconds. Only ephemeral synthetic enrollment
// secrets enter this helper. Never persist/log them or enable browser traces.
export function totp(secret: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.toUpperCase().replace(/=+$/, "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Invalid synthetic TOTP secret encoding");
    bits += value.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}

export function incorrectTOTP(secret: string): string {
  const step = Math.floor(Date.now() / 30000);
  // Exclude all neighboring accepted codes, rather than probabilistic 000000.
  const accepted = new Set(
    [-2, -1, 0, 1, 2].map((n) => totp(secret, step + n)),
  );
  for (let n = 0; ; n++) {
    const candidate = n.toString().padStart(6, "0");
    if (!accepted.has(candidate)) return candidate;
  }
}

export async function freshTOTP(secret: string, afterStep = -1) {
  // Wait for the REAL next time step, never forge a future code or change the
  // production clock. Leave submission headroom at the edge of a time step.
  let now = Date.now();
  while (Math.floor(now / 30000) <= afterStep || now % 30000 > 25000) {
    await new Promise((resolve) =>
      setTimeout(resolve, 30000 - (now % 30000) + 100),
    );
    now = Date.now();
  }
  const step = Math.floor(now / 30000);
  return { step, code: totp(secret, step) };
}
