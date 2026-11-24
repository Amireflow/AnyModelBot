import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppCloudApiClient, WhatsAppProviderError } from "../src/agency/whatsapp-cloud.js";

function jsonResponse(value:unknown,status=200):Response {
  return new Response(JSON.stringify(value),{
    status,headers:{"content-type":"application/json"},
  });
}

describe("WhatsApp Cloud API adapter",()=>{
  afterEach(()=>vi.unstubAllGlobals());

  const config={
    organizationId:"agency-unit-test",
    accessToken:"unit-test-token",
    phoneNumberId:"123456789012345",
    businessAccountId:"987654321098765",
    apiVersion:"v27.0",
  };
  const message={
    organizationId:"agency-unit-test",
    recipient:"+221771234567",
    templateName:"hello_world",
    language:"fr_FR",
    components:[],
  };

  it("binds configured credentials to a single Agency organization",()=>{
    const client=new WhatsAppCloudApiClient(config);
    expect(client.isConfigured("agency-unit-test")).toBe(true);
    expect(client.isConfigured("another-agency")).toBe(false);
    expect(client.isConfigured()).toBe(true);
  });

  it("checks the requested template language and APPROVED status before sending",async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(jsonResponse({data:[
        {name:"hello_world",language:"en_US",status:"APPROVED"},
        {name:"hello_world",language:"fr_FR",status:"APPROVED"},
      ]}))
      .mockResolvedValueOnce(jsonResponse({messages:[{id:"wamid.cloud-test"}]}));
    vi.stubGlobal("fetch",fetchMock);
    const client=new WhatsAppCloudApiClient(config);

    const result=await client.sendTemplateMessage(message);

    expect(result.providerMessageId).toBe("wamid.cloud-test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [templateUrl,templateOptions]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(String(templateUrl)).toContain("/v27.0/987654321098765/message_templates");
    expect(String(templateUrl)).toContain("name=hello_world");
    expect(new Headers(templateOptions.headers).get("Authorization")).toBe("Bearer unit-test-token");

    const [sendUrl,sendOptions]=fetchMock.mock.calls[1] as unknown as [string,RequestInit];
    expect(String(sendUrl)).toBe("https://graph.facebook.com/v27.0/123456789012345/messages");
    const body=JSON.parse(String(sendOptions.body)) as Record<string,unknown>;
    expect(body).toMatchObject({
      messaging_product:"whatsapp",recipient_type:"individual",
      to:"221771234567",type:"template",
      template:{name:"hello_world",language:{code:"fr_FR"},components:[]},
    });
  });

  it("blocks pending/rejected or wrong-language templates before the send request",async()=>{
    const fetchMock=vi.fn().mockResolvedValueOnce(jsonResponse({data:[
      {name:"hello_world",language:"fr_FR",status:"PENDING"},
    ]}));
    vi.stubGlobal("fetch",fetchMock);
    const client=new WhatsAppCloudApiClient(config);

    await expect(client.sendTemplateMessage(message)).rejects.toMatchObject({
      code:"TEMPLATE_NOT_APPROVED",uncertain:false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when account credentials are incomplete",async()=>{
    const fetchMock=vi.fn();
    vi.stubGlobal("fetch",fetchMock);
    const client=new WhatsAppCloudApiClient({accessToken:"test-token",phoneNumberId:config.phoneNumberId});

    expect(client.isConfigured()).toBe(false);
    await expect(client.sendTemplateMessage(message)).rejects.toBeInstanceOf(WhatsAppProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks send timeouts as ambiguous instead of silently retrying",async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(jsonResponse({data:[
        {name:"hello_world",language:"fr_FR",status:"APPROVED"},
      ]}))
      .mockRejectedValueOnce(new Error("network timeout"));
    vi.stubGlobal("fetch",fetchMock);
    const client=new WhatsAppCloudApiClient(config);

    await expect(client.sendTemplateMessage(message)).rejects.toMatchObject({
      code:"NETWORK_OR_TIMEOUT",uncertain:true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
