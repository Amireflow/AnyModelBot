import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WhatsAppSecretsFile, type WhatsAppSecretBox, type WhatsAppSecretConfig } from "../src/agency/whatsapp-secrets.js";

const config:WhatsAppSecretConfig={
  organizationId:"agency-secret-test",
  accessToken:"EAAB-secret-access-token-0123456789",
  phoneNumberId:"123456789012345",
  businessAccountId:"987654321098765",
  apiVersion:"v27.0",
  appSecret:"app-secret-value-0123456789",
  verifyToken:"verify-token-value-012345",
};

function fakeBox(options:{available?:boolean;rotate?:boolean}={}):WhatsAppSecretBox{
  let decryptCount=0;
  let encryptCount=0;
  return {
    async status(){
      return options.available===false
        ? {available:false,backend:"mock-keychain",reason:"mock keychain locked"}
        : {available:true,backend:"mock-keychain"};
    },
    async encrypt(plaintext){
      const nonce=encryptCount++%256;
      const encrypted=Buffer.from([...Buffer.from(plaintext)].map(byte=>byte^0x5a));
      return Buffer.concat([Buffer.from([nonce]),encrypted]);
    },
    async decrypt(ciphertext){
      const plaintext=Buffer.from([...ciphertext.subarray(1)].map(byte=>byte^0x5a)).toString("utf8");
      const shouldReEncrypt=options.rotate===true && decryptCount===0;
      decryptCount++;
      return {plaintext,shouldReEncrypt};
    },
  };
}

const directories:string[]=[];
function temporaryFile(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"amb-whatsapp-vault-"));
  directories.push(directory);
  return path.join(directory,"whatsapp-secrets.json");
}
afterEach(()=>{
  for(const directory of directories.splice(0))fs.rmSync(directory,{recursive:true,force:true});
});

describe("WhatsApp OS-encrypted credential vault",()=>{
  it("stores ciphertext only, reloads credentials and binds them to one organization",async()=>{
    const file=temporaryFile();
    const vault=new WhatsAppSecretsFile(file,fakeBox());

    await vault.set(config,config.organizationId);

    const raw=fs.readFileSync(file,"utf8");
    expect(raw).not.toContain(config.accessToken);
    expect(raw).not.toContain(config.appSecret);
    expect(raw).not.toContain(config.verifyToken);
    expect(JSON.parse(raw)).toMatchObject({
      version:1,algorithm:"electron-safe-storage",
    });
    expect(await vault.get()).toEqual(config);
    expect(vault.status()).toMatchObject({
      storage:"electron-safe-storage",hasStoredSecret:true,
    });
    await expect(vault.set(config,"another-organization")).rejects.toThrow(/bound to the requested organization/);
  });

  it("refuses plaintext fallback when the operating-system secret store is unavailable",async()=>{
    const file=temporaryFile();
    const vault=new WhatsAppSecretsFile(file,fakeBox({available:false}));

    await expect(vault.set(config,config.organizationId)).rejects.toThrow(/mock keychain locked/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rewrites ciphertext when the key provider requests re-encryption",async()=>{
    const file=temporaryFile();
    const vault=new WhatsAppSecretsFile(file,fakeBox({rotate:true}));
    await vault.set(config,config.organizationId);
    const before=fs.readFileSync(file,"utf8");

    expect(await vault.get()).toEqual(config);

    const after=fs.readFileSync(file,"utf8");
    expect(after).not.toBe(before);
  });

  it("fails closed on an unsupported or corrupted file",async()=>{
    const file=temporaryFile();
    fs.writeFileSync(file,JSON.stringify({version:9,algorithm:"plain",ciphertext:"secret"}),{mode:0o600});
    const vault=new WhatsAppSecretsFile(file,fakeBox());

    await expect(vault.get()).rejects.toThrow(/unsupported format/);
  });

  it("removes the encrypted credential file even when the OS key store is locked",async()=>{
    const file=temporaryFile();
    const vault=new WhatsAppSecretsFile(file,fakeBox());
    await vault.set(config,config.organizationId);
    expect(fs.existsSync(file)).toBe(true);

    // Explicit local-owner recovery must not require decrypting a corrupt or locked vault.
    const lockedVault=new WhatsAppSecretsFile(file,fakeBox({available:false}));
    lockedVault.clear();

    expect(fs.existsSync(file)).toBe(false);
    expect(await vault.get()).toBeUndefined();
  });
});
