/**
 * Local agency CRM API. The console token protects every request; this first release
 * deliberately uses one local operator identity, not multi-user SaaS authentication.
 */
import { AgencyError } from "../../agency/errors.js";
import type { AgencyService } from "../../agency/service.js";
import type { CompanySearchFilters, ContactSearchFilters, LeadSearchFilters, LeadStage } from "../../agency/types.js";
import { HttpError, readJson, send, type Route, type WebContext } from "../http.js";

export const LOCAL_AGENCY_ACTOR = "local-owner";
const ERROR_STATUS: Record<string, number> = {
  VALIDATION_ERROR:400, NOT_FOUND:404, FORBIDDEN:403, CONFLICT:409,
  INVALID_TRANSITION:409, CONSENT_REQUIRED:409, APPROVAL_EXPIRED:409,
  APPROVAL_ALREADY_DECIDED:409, APPROVAL_PAYLOAD_MISMATCH:409, ORGANIZATION_SUSPENDED:423,
};

function routeError(error: unknown): never {
  if (error instanceof AgencyError) throw new HttpError(ERROR_STATUS[error.code] ?? 400,error.message);
  throw error;
}
function decodeSegment(value: string | undefined, field: string): string {
  try {
    const decoded=decodeURIComponent(value ?? "");
    if (!decoded || decoded.length>160) throw new Error("invalid");
    return decoded;
  } catch { throw new HttpError(400,`Invalid ${field}`); }
}
async function readObject(req: Parameters<Route>[0]): Promise<Record<string,unknown>> {
  try {
    const body=await readJson(req);
    if (!body || typeof body!=="object" || Array.isArray(body)) throw new HttpError(400,"JSON body must be an object");
    return body as Record<string,unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400,"Malformed JSON body");
    throw error;
  }
}
function queryInteger(url: URL,name: string,fallback: number): number {
  const value=url.searchParams.get(name);
  if (value===null) return fallback;
  return /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : Number.NaN;
}

export function agencyRoutes(ctx: WebContext): Route {
  const service: AgencyService=ctx.agency;
  const actor=LOCAL_AGENCY_ACTOR;
  return async (req,res,url,seg,_p,method) => {
    if (seg[0]!=="agency") return false;
    const fetchSite=String(req.headers["sec-fetch-site"] ?? "");
    if (fetchSite && fetchSite!=="same-origin" && fetchSite!=="none") throw new HttpError(403,"Cross-site requests are not allowed");
    try {
      if (seg.length===2 && seg[1]==="organizations") {
        if (method==="GET") return send(res,200,{items:service.listOrganizations(actor)});
        if (method==="POST") {
          const body=await readObject(req);
          const organization=service.createOrganization({
            name:body.name as string,countryCode:body.countryCode as string|undefined,
            currency:body.currency as string|undefined,
          },actor);
          return send(res,201,{organization});
        }
        throw new HttpError(405,"Method not allowed");
      }
      if (seg.length<2) throw new HttpError(404,"not found");
      const organizationId=decodeSegment(seg[1],"organization id");

      if (seg.length===3 && seg[2]==="dashboard" && method==="GET") return send(res,200,service.dashboard(organizationId,actor));

      if (seg[2]==="companies") {
        if (seg.length===3 && method==="GET") {
          const filters: CompanySearchFilters={
            query:url.searchParams.get("q")??undefined,industry:url.searchParams.get("industry")??undefined,
            countryCode:url.searchParams.get("countryCode")??undefined,city:url.searchParams.get("city")??undefined,
            status:(url.searchParams.get("status")??undefined) as CompanySearchFilters["status"],
            limit:queryInteger(url,"limit",50),offset:queryInteger(url,"offset",0),
          };
          return send(res,200,service.searchCompanies(organizationId,actor,filters));
        }
        if (seg.length===3 && method==="POST") {
          const body=await readObject(req);
          const company=service.createCompany(organizationId,actor,{
            name:body.name as string,website:body.website as string|undefined,industry:body.industry as string|undefined,
            countryCode:body.countryCode as string|undefined,city:body.city as string|undefined,
          });
          return send(res,201,{company});
        }
        if (seg.length===4 && method==="GET") {
          return send(res,200,{company:service.getCompany(organizationId,actor,decodeSegment(seg[3],"company id"))});
        }
        if (seg.length===5 && seg[4]==="contacts" && (method==="GET" || method==="POST")) {
          const companyId=decodeSegment(seg[3],"company id");
          if (method==="GET") {
            const filters: ContactSearchFilters={companyId,query:url.searchParams.get("q")??undefined,
              status:(url.searchParams.get("status")??undefined) as ContactSearchFilters["status"],
              limit:queryInteger(url,"limit",50),offset:queryInteger(url,"offset",0)};
            return send(res,200,service.searchContacts(organizationId,actor,filters));
          }
          const body=await readObject(req);
          const contact=service.createContact(organizationId,actor,{
            companyId,displayName:body.displayName as string,role:body.role as string|undefined,
            email:body.email as string|undefined,phone:body.phone as string|undefined,
            preferredChannel:body.preferredChannel as string|undefined,
          });
          return send(res,201,{contact});
        }
      }

      if (seg[2]==="contacts" && seg.length===3 && method==="GET") {
        const filters: ContactSearchFilters={query:url.searchParams.get("q")??undefined,
          status:(url.searchParams.get("status")??undefined) as ContactSearchFilters["status"],
          limit:queryInteger(url,"limit",50),offset:queryInteger(url,"offset",0)};
        return send(res,200,service.searchContacts(organizationId,actor,filters));
      }

      if (seg[2]==="leads") {
        if (seg.length===3 && method==="GET") {
          const filters: LeadSearchFilters={query:url.searchParams.get("q")??undefined,
            companyId:url.searchParams.get("companyId")??undefined,
            stage:(url.searchParams.get("stage")??undefined) as LeadStage|undefined,
            limit:queryInteger(url,"limit",50),offset:queryInteger(url,"offset",0)};
          return send(res,200,service.searchLeads(organizationId,actor,filters));
        }
        if (seg.length===3 && method==="POST") {
          const body=await readObject(req);
          const lead=service.createLead(organizationId,actor,{
            companyId:body.companyId as string,contactId:body.contactId as string|undefined,
            source:body.source as string|undefined,notes:body.notes as string|undefined,
          });
          return send(res,201,{lead});
        }
        if (seg.length===5 && seg[4]==="stage" && method==="PATCH") {
          const leadId=decodeSegment(seg[3],"lead id");
          const body=await readObject(req);
          return send(res,200,{lead:service.transitionLead(organizationId,actor,leadId,body.stage as LeadStage)});
        }
      }

      if (seg[2]==="timeline" && seg.length===3 && method==="GET") {
        return send(res,200,{items:service.timeline(organizationId,actor,{
          entityType:url.searchParams.get("entityType")??undefined,
          entityId:url.searchParams.get("entityId")??undefined,limit:queryInteger(url,"limit",50),
        })});
      }
      return false;
    } catch (error) { routeError(error); }
  };
}
