import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { registerSecret } from "../log.js";

export interface SecretBox {
  algorithm?: "electron-safe-storage" | "local-aes-256-gcm";
  status(): Promise<{ available: boolean; backend: string; reason?: string }>;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<{ plaintext: string; shouldReEncrypt?: boolean }>;
}

/**
 * Local Node AES-256-GCM fallback secret box when running in local web/CLI mode outside Electron.
 * Uses a 256-bit random key stored separately in `<dataDir>/<keyFileName>` (mode 0600).
 */
export class LocalNodeSecretBox implements SecretBox {
  readonly algorithm = "local-aes-256-gcm" as const;
  private readonly keyFile: string;

  constructor(dataDir: string, keyFileName = ".agency-vault.key") {
    this.keyFile = path.join(dataDir, keyFileName);
  }

  async status(): Promise<{ available: boolean; backend: string; reason?: string }> {
    return { available: true, backend: "AES-256-GCM (local vault)" };
  }

  private getOrCreateKey(): Buffer {
    if (fs.existsSync(this.keyFile)) {
      const raw = fs.readFileSync(this.keyFile, "utf8").trim();
      const key = Buffer.from(raw, "base64");
      if (key.length !== 32) throw new Error("Local vault key file is corrupted");
      registerSecret(raw);
      return key;
    }
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    const b64 = key.toString("base64");
    registerSecret(b64);
    const tmp = `${this.keyFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${b64}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.keyFile);
    try { fs.chmodSync(this.keyFile, 0o600); } catch { /* Windows */ }
    return key;
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    const key = this.getOrCreateKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  async decrypt(ciphertext: Buffer): Promise<{ plaintext: string; shouldReEncrypt?: boolean }> {
    if (!fs.existsSync(this.keyFile)) throw new Error("Local vault key is missing");
    const raw = fs.readFileSync(this.keyFile, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32 || ciphertext.length < 29) {
      throw new Error("Invalid local vault ciphertext or key");
    }
    registerSecret(raw);
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const enc = ciphertext.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    return { plaintext: plain };
  }
}
