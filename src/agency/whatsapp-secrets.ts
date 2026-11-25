import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { registerSecret } from "../log.js";

export interface WhatsAppSecretConfig {
  organizationId: string;
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  apiVersion: string;
  appSecret?: string;
  verifyToken?: string;
}

export interface WhatsAppSecretBox {
  algorithm?: "electron-safe-storage" | "local-aes-256-gcm";
  status(): Promise<{ available: boolean; backend: string; reason?: string }>;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<{ plaintext: string; shouldReEncrypt?: boolean }>;
}

export interface WhatsAppSecretsVaultStatus {
  storage: "electron-safe-storage" | "local-aes-256-gcm";
  backend: string;
  hasStoredSecret: boolean;
}

interface FileShape {
  version: 1;
  algorithm: "electron-safe-storage" | "local-aes-256-gcm";
  ciphertext: string;
}

/**
 * Local Node AES-256-GCM fallback secret box when running in local web/CLI mode outside Electron.
 * Uses a 256-bit random key stored separately in `<dataDir>/.whatsapp-vault.key` (mode 0600).
 */
export class LocalNodeSecretBox implements WhatsAppSecretBox {
  readonly algorithm = "local-aes-256-gcm" as const;
  private readonly keyFile: string;

  constructor(dataDir: string, keyFileName = ".whatsapp-vault.key") {
    this.keyFile = path.join(dataDir, keyFileName);
  }

  async status(): Promise<{ available: boolean; backend: string; reason?: string }> {
    return { available: true, backend: "AES-256-GCM (local vault)" };
  }

  private getOrCreateKey(): Buffer {
    if (fs.existsSync(this.keyFile)) {
      const raw = fs.readFileSync(this.keyFile, "utf8").trim();
      const key = Buffer.from(raw, "base64");
      if (key.length !== 32) throw new Error("Local WhatsApp vault key file is corrupted");
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
    if (!fs.existsSync(this.keyFile)) throw new Error("Local WhatsApp vault key is missing");
    const raw = fs.readFileSync(this.keyFile, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32 || ciphertext.length < 29) {
      throw new Error("Invalid local WhatsApp ciphertext or key");
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

function requiredString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") throw new TypeError(name + " must be a string");
  const normalized=value.trim();
  if (normalized.length<min || normalized.length>max) throw new TypeError(name + " has an invalid length");
  return normalized;
}

export function normalizeWhatsAppSecretConfig(value: unknown, expectedOrganizationId?: string): WhatsAppSecretConfig {
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new TypeError("WhatsApp credentials must be an object");
  const source=value as Record<string,unknown>;
  const allowed=["organizationId","accessToken","phoneNumberId","businessAccountId","apiVersion","appSecret","verifyToken"];
  if (Object.keys(source).some(key=>!allowed.includes(key))) throw new TypeError("Unsupported WhatsApp credential field");
  const config: WhatsAppSecretConfig={
    organizationId:requiredString(source.organizationId,"organizationId",1,160),
    accessToken:requiredString(source.accessToken,"accessToken",16,4096),
    phoneNumberId:requiredString(source.phoneNumberId,"phoneNumberId",5,30),
    businessAccountId:requiredString(source.businessAccountId,"businessAccountId",5,30),
    apiVersion:requiredString(source.apiVersion ?? "v27.0","apiVersion",4,16),
    appSecret:source.appSecret==null || source.appSecret==="" ? undefined : requiredString(source.appSecret,"appSecret",16,512),
    verifyToken:source.verifyToken==null || source.verifyToken==="" ? undefined : requiredString(source.verifyToken,"verifyToken",16,256),
  };
  if (!/^\d{5,30}$/.test(config.phoneNumberId) || !/^\d{5,30}$/.test(config.businessAccountId)) {
    throw new TypeError("Meta phone number and business account IDs must be numeric IDs");
  }
  if (!/^v\d{1,3}\.\d{1,3}$/.test(config.apiVersion)) throw new TypeError("Invalid Graph API version");
  if (expectedOrganizationId && config.organizationId!==expectedOrganizationId) {
    throw new TypeError("WhatsApp credentials must be bound to the requested organization");
  }
  return config;
}

/**
 * Stores WhatsApp credentials only as OS-encrypted ciphertext.
 * The encryption primitive is injected by Electron's main process; CLI/Docker use environment variables.
 */
export class WhatsAppSecretsFile {
  constructor(readonly file: string, private readonly box: WhatsAppSecretBox) {}

  static at(dataDir: string, box: WhatsAppSecretBox): WhatsAppSecretsFile {
    return new WhatsAppSecretsFile(path.join(dataDir,"whatsapp-secrets.json"),box);
  }

  async availability(): Promise<{available:boolean;backend:string;reason?:string}> {
    return this.box.status();
  }

  status(): WhatsAppSecretsVaultStatus {
    const storage = this.box.algorithm ?? "electron-safe-storage";
    let backend = storage === "local-aes-256-gcm" ? "AES-256-GCM (local vault)" : "OS secure storage";
    if (storage === "electron-safe-storage") {
      if (process.platform==="darwin") backend="macOS Keychain";
      else if (process.platform==="win32") backend="Windows DPAPI";
      else if (process.platform==="linux") backend="Linux Secret Service";
    }
    return {storage,backend,hasStoredSecret:fs.existsSync(this.file)};
  }

  async get(): Promise<WhatsAppSecretConfig | undefined> {
    if (!fs.existsSync(this.file)) return undefined;
    const raw=JSON.parse(fs.readFileSync(this.file,"utf8")) as Partial<FileShape>;
    const expectedAlg = this.box.algorithm ?? "electron-safe-storage";
    if (raw.version!==1 || raw.algorithm!==expectedAlg || typeof raw.ciphertext!=="string") {
      throw new Error("WhatsApp secure credential file has an unsupported format");
    }
    const status=await this.box.status();
    if (!status.available) throw new Error(status.reason || "OS secure storage is unavailable");
    const ciphertext=Buffer.from(raw.ciphertext,"base64");
    let decrypted:{plaintext:string;shouldReEncrypt?:boolean};
    let attempts=0;
    try {
      decrypted=await this.box.decrypt(ciphertext);
      // Electron's async safeStorage API asks callers to decrypt again after key rotation.
      // Re-read with the new key before replacing the ciphertext on disk.
      while (decrypted.shouldReEncrypt) {
        if (++attempts>3) throw new Error("OS secure storage kept requesting key rotation");
        decrypted=await this.box.decrypt(ciphertext);
      }
    } catch {
      throw new Error("WhatsApp credentials cannot be decrypted by this system account");
    }
    let parsed:unknown;
    try { parsed=JSON.parse(decrypted.plaintext); }
    catch { throw new Error("WhatsApp secure credential payload is invalid"); }
    const config=normalizeWhatsAppSecretConfig(parsed);
    this.register(config);
    if (attempts>0) await this.write(config);
    return config;
  }

  async set(value: unknown, expectedOrganizationId?: string): Promise<void> {
    const config=normalizeWhatsAppSecretConfig(value,expectedOrganizationId);
    await this.write(config);
    this.register(config);
  }

  clear(): void {
    if (fs.existsSync(this.file)) fs.rmSync(this.file,{force:true});
  }

  private register(config: WhatsAppSecretConfig): void {
    registerSecret(config.accessToken);
    if(config.appSecret)registerSecret(config.appSecret);
    if(config.verifyToken)registerSecret(config.verifyToken);
  }

  private async write(config: WhatsAppSecretConfig): Promise<void> {
    const status=await this.box.status();
    if (!status.available) throw new Error(status.reason || "OS secure storage is unavailable; WhatsApp secrets were not saved");
    const ciphertext=await this.box.encrypt(JSON.stringify(config));
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length<16) throw new Error("OS secure storage returned invalid ciphertext");
    const shape:FileShape={version:1,algorithm:this.box.algorithm ?? "electron-safe-storage",ciphertext:ciphertext.toString("base64")};
    const directory=path.dirname(this.file);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const temporary=this.file+"."+process.pid+"."+randomBytes(6).toString("hex")+".tmp";
    let fd:number|undefined;
    try {
      fd=fs.openSync(temporary,"wx",0o600);
      fs.writeFileSync(fd,JSON.stringify(shape)+"\n","utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd=undefined;
      fs.renameSync(temporary,this.file);
      try { fs.chmodSync(this.file,0o600); } catch { /* Windows does not expose POSIX file modes. */ }
      try {
        const directoryFd=fs.openSync(directory,"r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch { /* Directory fsync is not supported on every platform. */ }
    } catch (error) {
      if (fd!==undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
      try { fs.rmSync(temporary,{force:true}); } catch { /* best effort */ }
      throw error;
    }
  }
}
