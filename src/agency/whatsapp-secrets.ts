import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
  status(): Promise<{ available: boolean; backend: string; reason?: string }>;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<{ plaintext: string; shouldReEncrypt?: boolean }>;
}

export interface WhatsAppSecretsVaultStatus {
  storage: "electron-safe-storage";
  backend: string;
  hasStoredSecret: boolean;
}

interface FileShape {
  version: 1;
  algorithm: "electron-safe-storage";
  ciphertext: string;
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
    let backend="OS secure storage";
    if (process.platform==="darwin") backend="macOS Keychain";
    else if (process.platform==="win32") backend="Windows DPAPI";
    else if (process.platform==="linux") backend="Linux Secret Service";
    return {storage:"electron-safe-storage",backend,hasStoredSecret:fs.existsSync(this.file)};
  }

  async get(): Promise<WhatsAppSecretConfig | undefined> {
    if (!fs.existsSync(this.file)) return undefined;
    const raw=JSON.parse(fs.readFileSync(this.file,"utf8")) as Partial<FileShape>;
    if (raw.version!==1 || raw.algorithm!=="electron-safe-storage" || typeof raw.ciphertext!=="string") {
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
    const shape:FileShape={version:1,algorithm:"electron-safe-storage",ciphertext:ciphertext.toString("base64")};
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
