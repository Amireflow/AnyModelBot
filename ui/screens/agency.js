import { useEffect, useState } from "preact/hooks";
import { html, Icon, Spinner, Badge } from "../components/ui.js";
import { api } from "../lib/api.js";
import { fmtNum, t, useLang } from "../lib/i18n.js";

const SIZE=25;
const NEXT={new:["researching","archived"],researching:["new","qualified","lost","archived"],qualified:["researching","contact_pending","lost","archived"],contact_pending:["qualified","contacted","lost"],contacted:["qualified","engaged","lost"],engaged:["contacted","opportunity","lost"],opportunity:["engaged","proposal","lost"],proposal:["opportunity","won","lost"],won:["archived"],lost:["qualified","archived"],archived:[]};
const blankCompany={name:"",website:"",industry:"",countryCode:"SN",city:""};
const blankLead={companyId:"",source:"",notes:""};
const blankContact={displayName:"",role:"",email:"",phone:""};
const blankEvidence={evidenceType:"company",sourceUrl:"",summary:"",confidence:"0.7"};
const blankQualificationDraft={targetIndustries:"",targetCountries:"",excludedIndustries:"",requiredEvidenceDomains:"",requireWebsite:false};
const blankCatalogDraft={code:"",name:"",category:"web_app",description:"",estimatedDays:"10",priceMin:"1500",priceBase:"2500",priceMax:"4000",estimatedCost:"1200"};
const blankRulesDraft={minMarginPct:"30",maxAutonomousDiscountPct:"10",defaultDepositPct:"30",requireOwnerApprovalAboveAmount:"0",paymentTermsDefault:""};
const blankNeedsDraft={problemStatement:"",solutionType:"web_app",mustHaveFeatures:"",desiredTimeline:"",budgetMin:"0",budgetMax:"0",clientConfirmed:false};
const blankQuoteDraft={title:"",tier:"standard",lineLabel:"",linePrice:"2500",lineCost:"1200",lineDays:"10",discountPct:"0"};
const SOLUTION_TYPES=["vitrine","ecommerce","web_app","mobile_app","business_platform","internal_tool","automation","maintenance"];
const CHANNELS=["whatsapp","email","web_form","social","phone","other"];
const splitValues=value=>value.split(",").map(item=>item.trim()).filter(Boolean);
const ACTIVE_RESEARCH=new Set(["pending","grounding","researching","collecting","curating","enriching","briefing","editing"]);
const isActiveResearch=job=>{
  if(!ACTIVE_RESEARCH.has(job.status))return false;
  const updated=job.updatedAt?Date.parse(job.updatedAt):Number.NaN;
  return !Number.isFinite(updated)||Date.now()-updated<30*60_000;
};
const enc=encodeURIComponent;
const qs=(o)=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!==""&&v!==undefined&&v!==null).map(([k,v])=>[k,String(v)])).toString();
const storedOrg=()=>{try{return localStorage.getItem("amb-agency-org")||"";}catch{return "";}};
const rememberOrg=(id)=>{try{localStorage.setItem("amb-agency-org",id);}catch{/* optional */}};
const approvalPayload=approval=>{try{const value=JSON.parse(approval.payloadJson);return value&&typeof value==="object"&&!Array.isArray(value)?value:null;}catch{return null;}};
const cleanPhone=value=>String(value||"").replace(/[\s().-]/g,"");

function Field({label,value,onInput,required=false,type="text",placeholder=""}) {
  return html`<label class="agency-field"><span>${label}</span><input class="field" type=${type} autocomplete=${type==="password"?"new-password":undefined} value=${value} placeholder=${placeholder} required=${required} onInput=${(e)=>onInput(e.currentTarget.value)} /></label>`;
}
function Metric({label,value,icon}) {
  return html`<article class="agency-metric"><span class="agency-metric-icon"><${Icon} name=${icon} /></span><strong class="num">${fmtNum(value||0)}</strong><span>${label}</span></article>`;
}
function Empty({title,detail}) {
  return html`<div class="agency-empty"><${Icon} name="inbox" size="xl" /><strong>${title}</strong><span>${detail}</span></div>`;
}

export function AgencyScreen() {
  const lang=useLang();
  const [orgs,setOrgs]=useState([]);
  const [orgId,setOrgId]=useState(storedOrg);
  const [orgName,setOrgName]=useState("");
  const [orgLoading,setOrgLoading]=useState(true);
  const [orgError,setOrgError]=useState("");
  const [dashboard,setDashboard]=useState(null);
  const [tab,setTab]=useState("companies");
  const [query,setQuery]=useState("");
  const [page,setPage]=useState(0);
  const [rows,setRows]=useState({items:[],total:0});
  const [companyOptions,setCompanyOptions]=useState([]);
  const [selected,setSelected]=useState("");
  const [contacts,setContacts]=useState([]);
  const [whatsappOpen,setWhatsappOpen]=useState(false);
  const [whatsappConfig,setWhatsappConfig]=useState(null);
  const [whatsappDraft,setWhatsappDraft]=useState({
    accessToken:"",phoneNumberId:"",businessAccountId:"",apiVersion:"v27.0",appSecret:"",verifyToken:""
  });
  const [whatsappBusy,setWhatsappBusy]=useState("");
  const [whatsappError,setWhatsappError]=useState("");
  const [whatsappNotice,setWhatsappNotice]=useState("");
  const [whatsappClearConfirm,setWhatsappClearConfirm]=useState(false);
  const [whatsappWorkflowOpen,setWhatsappWorkflowOpen]=useState(false);
  const [whatsappApprovals,setWhatsappApprovals]=useState([]);
  const [whatsappOutbox,setWhatsappOutbox]=useState([]);
  const [whatsappWorkflowBusy,setWhatsappWorkflowBusy]=useState(false);
  const [whatsappWorkflowError,setWhatsappWorkflowError]=useState("");
  const [whatsappSendConfirmId,setWhatsappSendConfirmId]=useState("");
  const [consentContactId,setConsentContactId]=useState("");
  const [whatsappConsents,setWhatsappConsents]=useState([]);
  const [whatsappConsentBusy,setWhatsappConsentBusy]=useState(false);
  const [whatsappConsentError,setWhatsappConsentError]=useState("");
  const [whatsappConsentNotice,setWhatsappConsentNotice]=useState("");
  const [whatsappConsentDraft,setWhatsappConsentDraft]=useState({
    purpose:"marketing",status:"granted",source:"manual_confirmation",proof:"",textVersion:"wa-marketing-v1"
  });
  const [whatsappTemplateDraft,setWhatsappTemplateDraft]=useState({
    name:"",language:"fr_FR",components:"[]",reason:""
  });
  const [research,setResearch]=useState({items:[],assessment:null});
  const [qualification,setQualification]=useState(null);
  const [qualificationDraft,setQualificationDraft]=useState(blankQualificationDraft);
  const [qualificationForm,setQualificationForm]=useState(false);
  const [researchJobs,setResearchJobs]=useState([]);
  const [researchLaunch,setResearchLaunch]=useState(null);
  const [researchJobId,setResearchJobId]=useState("");
  const [researchImportMessage,setResearchImportMessage]=useState("");
  const [evidenceForm,setEvidenceForm]=useState(false);
  const [evidenceDraft,setEvidenceDraft]=useState(blankEvidence);
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  const [revision,setRevision]=useState(0);
  const [companyForm,setCompanyForm]=useState(false);
  const [leadForm,setLeadForm]=useState(false);
  const [contactForm,setContactForm]=useState(false);
  const [company,setCompany]=useState(blankCompany);
  const [lead,setLead]=useState(blankLead);
  const [contact,setContact]=useState(blankContact);
  const [leadOptions,setLeadOptions]=useState([]);
  const [selectedLeadId,setSelectedLeadId]=useState("");
  const [catalogItems,setCatalogItems]=useState([]);
  const [catalogDraft,setCatalogDraft]=useState(blankCatalogDraft);
  const [tierPreview,setTierPreview]=useState([]);
  const [rulesDraft,setRulesDraft]=useState(blankRulesDraft);
  const [rulesNotice,setRulesNotice]=useState("");
  const [conversations,setConversations]=useState([]);
  const [selectedConvId,setSelectedConvId]=useState("");
  const [convMessages,setConvMessages]=useState([]);
  const [convDraft,setConvDraft]=useState({channel:"email",subject:""});
  const [msgBody,setMsgBody]=useState("");
  const [needsDraft,setNeedsDraft]=useState(blankNeedsDraft);
  const [needsNotice,setNeedsNotice]=useState("");
  const [quotes,setQuotes]=useState([]);
  const [quoteDraft,setQuoteDraft]=useState(blankQuoteDraft);
  const [negDiscount,setNegDiscount]=useState("10");
  const [negEval,setNegEval]=useState(null);
  const [contracts,setContracts]=useState([]);
  const [depositRefByContract,setDepositRefByContract]=useState({});
  const [approvals,setApprovals]=useState([]);

  useEffect(()=>{
    let live=true;
    setOrgLoading(true);setOrgError("");
    api("/agency/organizations").then(d=>{
      if(!live)return;
      const items=d.items||[];
      setOrgs(items);
      const saved=storedOrg();
      const chosen=items.some(x=>x.id===orgId)?orgId:items.some(x=>x.id===saved)?saved:(items[0]?.id||"");
      setOrgId(chosen);rememberOrg(chosen);
    }).catch(e=>live&&setOrgError(e.message)).finally(()=>live&&setOrgLoading(false));
    return ()=>{live=false;};
  },[lang]);

  useEffect(()=>{
    if(!orgId||!whatsappOpen){setWhatsappConfig(null);return;}
    let live=true;
    setWhatsappBusy("load");setWhatsappError("");setWhatsappNotice("");
    api("/agency/"+enc(orgId)+"/whatsapp/config")
      .then(data=>{
        if(!live)return;
        setWhatsappConfig(data);
        setWhatsappDraft({accessToken:"",phoneNumberId:"",businessAccountId:"",apiVersion:"v27.0",appSecret:"",verifyToken:""});
        setWhatsappClearConfirm(false);
      })
      .catch(err=>live&&setWhatsappError(err.message))
      .finally(()=>live&&setWhatsappBusy(""));
    return ()=>{live=false;};
  },[orgId,whatsappOpen,lang]);

  useEffect(()=>{
    if(!orgId||!whatsappWorkflowOpen){
      setWhatsappApprovals([]);setWhatsappOutbox([]);setWhatsappWorkflowError("");setWhatsappSendConfirmId("");
      return;
    }
    let live=true;
    const refresh=()=>{
      Promise.all([
        api("/agency/"+enc(orgId)+"/approvals?limit=100"),
        api("/agency/"+enc(orgId)+"/whatsapp/outbox?limit=100")
      ]).then(([approvalData,outboxData])=>{
        if(!live)return;
        setWhatsappApprovals(approvalData.items||[]);
        setWhatsappOutbox(outboxData.items||[]);
        setWhatsappWorkflowError("");
      }).catch(err=>live&&setWhatsappWorkflowError(err.message));
    };
    refresh();
    const timer=setInterval(refresh,15000);
    return ()=>{live=false;clearInterval(timer);};
  },[orgId,whatsappWorkflowOpen,lang]);

  useEffect(()=>{
    if(!orgId||!consentContactId){setWhatsappConsents([]);return;}
    let live=true;
    setWhatsappConsentBusy(true);setWhatsappConsentError("");setWhatsappConsentNotice("");
    api("/agency/"+enc(orgId)+"/contacts/"+enc(consentContactId)+"/consents?channel=whatsapp")
      .then(data=>live&&setWhatsappConsents(data.items||[]))
      .catch(err=>live&&setWhatsappConsentError(err.message))
      .finally(()=>live&&setWhatsappConsentBusy(false));
    return ()=>{live=false;};
  },[orgId,consentContactId,revision,lang]);

  useEffect(()=>{
    if(!orgId){setQualificationDraft(blankQualificationDraft);return;}
    let live=true;
    api("/agency/"+enc(orgId)+"/qualification-profile")
      .then(d=>{
        if(!live)return;
        const profile=d.profile;
        setQualificationDraft({
          targetIndustries:(profile.targetIndustries||[]).join(", "),
          targetCountries:(profile.targetCountries||[]).join(", "),
          excludedIndustries:(profile.excludedIndustries||[]).join(", "),
          requiredEvidenceDomains:(profile.requiredEvidenceDomains||[]).join(", "),
          requireWebsite:!!profile.requireWebsite,
        });
      }).catch(e=>live&&setError(e.message));
    return ()=>{live=false;};
  },[orgId,lang]);

  useEffect(()=>{
    if(!orgId){setDashboard(null);setRows({items:[],total:0});return;}
    let live=true;setBusy("load");setError("");
    if(tab==="companies"||tab==="leads"){
      const path=tab==="companies"?"/companies?":"/leads?";
      Promise.all([
        api(`/agency/${enc(orgId)}/dashboard`),
        api(`/agency/${enc(orgId)}${path}${qs({q:query,limit:SIZE,offset:page*SIZE})}`)
      ]).then(([stats,data])=>{
        if(!live)return;
        setDashboard(stats);setRows(data);
      }).catch(e=>live&&setError(e.message)).finally(()=>live&&setBusy(""));
      return ()=>{live=false;};
    }
    Promise.all([
      api(`/agency/${enc(orgId)}/dashboard`),
      api(`/agency/${enc(orgId)}/catalog`),
      api(`/agency/${enc(orgId)}/commercial-rules`),
      api(`/agency/${enc(orgId)}/leads?limit=100&offset=0`),
      api(`/agency/${enc(orgId)}/quotes`),
      api(`/agency/${enc(orgId)}/contracts`),
      api(`/agency/${enc(orgId)}/conversations`),
      api(`/agency/${enc(orgId)}/approvals?limit=100`)
    ]).then(([stats,catData,ruleData,leadData,quoteData,contractData,convData,appData])=>{
      if(!live)return;
      setDashboard(stats);
      setCatalogItems(catData.items||[]);
      if(ruleData.rules){
        setRulesDraft({
          minMarginPct:String(ruleData.rules.minMarginPct??30),
          maxAutonomousDiscountPct:String(ruleData.rules.maxAutonomousDiscountPct??10),
          defaultDepositPct:String(ruleData.rules.defaultDepositPct??30),
          requireOwnerApprovalAboveAmount:String(ruleData.rules.requireOwnerApprovalAboveAmount??0),
          paymentTermsDefault:ruleData.rules.paymentTermsDefault||""
        });
      }
      const leadList=leadData.items||[];
      setLeadOptions(leadList);
      setSelectedLeadId(cur=>leadList.some(l=>l.id===cur)?cur:(leadList[0]?.id||""));
      setQuotes(quoteData.items||[]);
      setContracts(contractData.items||[]);
      setConversations(convData.items||[]);
      setApprovals(appData.items||[]);
    }).catch(e=>live&&setError(e.message)).finally(()=>live&&setBusy(""));
    return ()=>{live=false;};
  },[orgId,tab,query,page,revision,lang]);

  useEffect(()=>{
    if(!orgId||tab!=="commercial"||!selectedLeadId){setNeedsDraft(blankNeedsDraft);return;}
    let live=true;
    api(`/agency/${enc(orgId)}/leads/${enc(selectedLeadId)}/needs`).then(d=>{
      if(!live)return;
      const n=d.needs;
      if(!n){setNeedsDraft(blankNeedsDraft);return;}
      setNeedsDraft({
        problemStatement:n.problemStatement||"",
        solutionType:n.solutionType||"web_app",
        mustHaveFeatures:(n.mustHaveFeatures||[]).join(", "),
        desiredTimeline:n.desiredTimeline||"",
        budgetMin:String(n.budgetMin??0),
        budgetMax:String(n.budgetMax??0),
        clientConfirmed:!!n.clientConfirmed
      });
    }).catch(()=>{});
    return ()=>{live=false;};
  },[orgId,tab,selectedLeadId,revision]);

  useEffect(()=>{
    if(!orgId||!selectedConvId){setConvMessages([]);return;}
    let live=true;
    api(`/agency/${enc(orgId)}/conversations/${enc(selectedConvId)}/messages`)
      .then(d=>live&&setConvMessages(d.items||[])).catch(()=>{});
    return ()=>{live=false;};
  },[orgId,selectedConvId,revision]);

  useEffect(()=>{
    if(!orgId){setCompanyOptions([]);return;}
    let live=true;
    api(`/agency/${enc(orgId)}/companies?limit=100&offset=0`)
      .then(d=>live&&setCompanyOptions(d.items||[])).catch(e=>live&&setError(e.message));
    return ()=>{live=false;};
  },[orgId,revision,lang]);

  useEffect(()=>{
    if(!orgId||!selected){setContacts([]);setQualification(null);return;}
    let live=true;
    api(`/agency/${enc(orgId)}/companies/${enc(selected)}/contacts?limit=100`)
      .then(d=>live&&setContacts(d.items||[])).catch(e=>live&&setError(e.message));
    return ()=>{live=false;};
  },[orgId,selected,revision,lang]);

  useEffect(()=>{
    if(!orgId||!selected){setResearch({items:[],assessment:null});setResearchJobs([]);setResearchLaunch(null);setResearchJobId("");setQualification(null);return;}
    let live=true;
    const refresh=()=>{
      api("/agency/"+enc(orgId)+"/companies/"+enc(selected)+"/evidence")
        .then(d=>live&&setResearch(d)).catch(e=>live&&setError(e.message));
      api("/agency/"+enc(orgId)+"/companies/"+enc(selected)+"/qualification")
        .then(d=>live&&setQualification(d.assessment)).catch(e=>live&&setError(e.message));
      api("/agency/"+enc(orgId)+"/companies/"+enc(selected)+"/research/jobs")
        .then(d=>{
          if(!live)return;
          const jobs=d.items||[];
          const completed=jobs.filter(j=>j.status==="completed");
          setResearchJobs(jobs);
          setResearchLaunch(d.launch||null);
          setResearchJobId(current=>completed.some(j=>j.id===current)?current:(completed[0]?.id||""));
        })
        .catch(()=>live&&setResearchJobs([]));
    };
    refresh();
    const timer=setInterval(refresh,8000);
    return ()=>{live=false;clearInterval(timer);};
  },[orgId,selected,revision,lang]);

  useEffect(()=>{setResearchImportMessage("");},[orgId,selected]);

  const update=(setter,key,value)=>setter(prev=>({...prev,[key]:value}));
  const changeOrg=(id)=>{setOrgId(id);rememberOrg(id);setSelected("");setPage(0);setWhatsappOpen(false);setWhatsappConfig(null);setWhatsappError("");setWhatsappNotice("");setWhatsappClearConfirm(false);setWhatsappWorkflowOpen(false);setConsentContactId("");setWhatsappConsents([]);};
  const createOrg=async(e)=>{
    e.preventDefault();setBusy("org");setOrgError("");
    try{
      const d=await api("/agency/organizations",{method:"POST",body:{name:orgName,countryCode:"SN",currency:"XOF"}});
      setOrgs(list=>[...list,d.organization]);changeOrg(d.organization.id);setOrgName("");
    }catch(err){setOrgError(err.message);}finally{setBusy("");}
  };
  const createCompany=async(e)=>{
    e.preventDefault();setBusy("create");setError("");
    try{await api(`/agency/${enc(orgId)}/companies`,{method:"POST",body:company});setCompany(blankCompany);setCompanyForm(false);setPage(0);setRevision(v=>v+1);}
    catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createLead=async(e)=>{
    e.preventDefault();setBusy("create");setError("");
    try{await api(`/agency/${enc(orgId)}/leads`,{method:"POST",body:lead});setLead(blankLead);setLeadForm(false);setTab("leads");setPage(0);setRevision(v=>v+1);}
    catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createContact=async(e)=>{
    e.preventDefault();setBusy("create");setError("");
    try{await api(`/agency/${enc(orgId)}/companies/${enc(selected)}/contacts`,{method:"POST",body:contact});setContact(blankContact);setContactForm(false);setRevision(v=>v+1);}
    catch(err){setError(err.message);}finally{setBusy("");}
  };
  const moveLead=async(id,stage)=>{
    setBusy("stage");setError("");
    try{await api(`/agency/${enc(orgId)}/leads/${enc(id)}/stage`,{method:"PATCH",body:{stage}});setRevision(v=>v+1);}
    catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createEvidence=async(e)=>{
    e.preventDefault();setBusy("evidence");setError("");
    try{
      await api("/agency/"+enc(orgId)+"/companies/"+enc(selected)+"/evidence",{
        method:"POST",body:{...evidenceDraft,confidence:Number(evidenceDraft.confidence)}
      });
      setEvidenceDraft(blankEvidence);setEvidenceForm(false);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const openWhatsAppConsent=async(contactRecord)=>{
    setConsentContactId(current=>current===contactRecord.id?"":contactRecord.id);
    setWhatsappConsents([]);
    setWhatsappConsentDraft({purpose:"marketing",status:"granted",source:"manual_confirmation",proof:"",textVersion:"wa-marketing-v1"});
    setWhatsappTemplateDraft({name:"",language:"fr_FR",components:"[]",reason:""});
    setWhatsappConsentError("");setWhatsappConsentNotice("");
  };
  const saveWhatsAppConsent=async(e)=>{
    e.preventDefault();setWhatsappConsentBusy(true);setWhatsappConsentError("");setWhatsappConsentNotice("");
    try{
      await api("/agency/"+enc(orgId)+"/contacts/"+enc(consentContactId)+"/consents",{
        method:"POST",body:{
          channel:"whatsapp",purpose:whatsappConsentDraft.purpose,status:whatsappConsentDraft.status,
          source:whatsappConsentDraft.source,proof:whatsappConsentDraft.proof,
          textVersion:whatsappConsentDraft.status==="granted"?whatsappConsentDraft.textVersion:undefined
        }
      });
      const data=await api("/agency/"+enc(orgId)+"/contacts/"+enc(consentContactId)+"/consents?channel=whatsapp");
      setWhatsappConsents(data.items||[]);
      setWhatsappConsentDraft(v=>({...v,proof:""}));
      setWhatsappConsentNotice(t("agency.whatsappConsentSaved"));
    }catch(err){setWhatsappConsentError(err.message);}
    finally{setWhatsappConsentBusy(false);}
  };
  const refreshWhatsAppWorkflow=async()=>{
    setWhatsappWorkflowBusy(true);setWhatsappWorkflowError("");
    try{
      const [approvalData,outboxData]=await Promise.all([
        api("/agency/"+enc(orgId)+"/approvals?limit=100"),
        api("/agency/"+enc(orgId)+"/whatsapp/outbox?limit=100")
      ]);
      setWhatsappApprovals(approvalData.items||[]);
      setWhatsappOutbox(outboxData.items||[]);
    }catch(err){setWhatsappWorkflowError(err.message);}
    finally{setWhatsappWorkflowBusy(false);}
  };
  const requestWhatsAppApproval=async(e,contactRecord)=>{
    e.preventDefault();setWhatsappConsentBusy(true);setWhatsappConsentError("");setWhatsappConsentNotice("");
    try{
      const purpose=whatsappConsentDraft.purpose.trim().toLowerCase();
      const consentData=await api("/agency/"+enc(orgId)+"/contacts/"+enc(contactRecord.id)+"/consents?channel=whatsapp&purpose="+encodeURIComponent(purpose));
      const latest=consentData.items?.[0];
      if(!latest||latest.status!=="granted"||(latest.expiresAt&&latest.expiresAt<=Date.now())||!latest.source||!latest.proof||!latest.textVersion){
        throw new Error(t("agency.whatsappConsentRequired"));
      }
      const recipient=cleanPhone(contactRecord.phone);
      if(!/^\+[1-9][0-9]{7,14}$/.test(recipient))throw new Error(t("agency.whatsappPhoneInvalid"));
      const components=JSON.parse(whatsappTemplateDraft.components||"[]");
      if(!Array.isArray(components)||components.length>10||components.some(item=>!item||typeof item!=="object"||Array.isArray(item))){
        throw new Error(t("agency.whatsappComponentsInvalid"));
      }
      const payload={
        channel:"whatsapp",purpose,contactId:contactRecord.id,recipient,type:"template",
        template:{name:whatsappTemplateDraft.name.trim().toLowerCase(),language:whatsappTemplateDraft.language.trim(),components}
      };
      await api("/agency/"+enc(orgId)+"/approvals",{method:"POST",body:{
        action:"send_message",resourceType:"whatsapp_template",resourceId:contactRecord.id,
        reason:whatsappTemplateDraft.reason,payload
      }});
      setWhatsappWorkflowOpen(true);
      setWhatsappConsentNotice(t("agency.whatsappApprovalRequested"));
      setWhatsappTemplateDraft(v=>({...v,reason:""}));
      await refreshWhatsAppWorkflow();
    }catch(err){setWhatsappConsentError(err.message);}
    finally{setWhatsappConsentBusy(false);}
  };
  const decideWhatsAppApproval=async(approval,decision)=>{
    setWhatsappWorkflowBusy(true);setWhatsappWorkflowError("");
    try{
      await api("/agency/"+enc(orgId)+"/approvals/"+enc(approval.id)+"/decision",{
        method:"POST",body:{
          decision,expectedPayloadHash:approval.payloadHash,
          reason:decision==="approved"?"Reviewed and approved in Agency CRM":"Rejected in Agency CRM"
        }
      });
      await refreshWhatsAppWorkflow();
    }catch(err){setWhatsappWorkflowError(err.message);setWhatsappWorkflowBusy(false);}
  };
  const queueWhatsAppApproval=async(approval)=>{
    setWhatsappWorkflowBusy(true);setWhatsappWorkflowError("");
    try{
      const payload=approvalPayload(approval);
      if(!payload)throw new Error(t("agency.whatsappApprovalPayloadInvalid"));
      await api("/agency/"+enc(orgId)+"/whatsapp/outbox",{method:"POST",body:{
        approvalId:approval.id,
        idempotencyKey:"wa-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,12),
        payload
      }});
      await refreshWhatsAppWorkflow();
    }catch(err){setWhatsappWorkflowError(err.message);setWhatsappWorkflowBusy(false);}
  };
  const sendWhatsAppOutbox=async(message)=>{
    setWhatsappWorkflowBusy(true);setWhatsappWorkflowError("");setWhatsappSendConfirmId("");
    try{
      await api("/agency/"+enc(orgId)+"/whatsapp/outbox/"+enc(message.id)+"/send",{method:"POST"});
      await refreshWhatsAppWorkflow();
    }catch(err){setWhatsappWorkflowError(err.message);setWhatsappWorkflowBusy(false);}
  };
  const saveWhatsAppConfig=async(e)=>{
    e.preventDefault();setWhatsappBusy("save");setWhatsappError("");setWhatsappNotice("");setWhatsappClearConfirm(false);
    try{
      const body={
        accessToken:whatsappDraft.accessToken,
        phoneNumberId:whatsappDraft.phoneNumberId,
        businessAccountId:whatsappDraft.businessAccountId,
        apiVersion:whatsappDraft.apiVersion||"v27.0",
        appSecret:whatsappDraft.appSecret,
        verifyToken:whatsappDraft.verifyToken,
      };
      const result=await api("/agency/"+enc(orgId)+"/whatsapp/config",{method:"PUT",body});
      setWhatsappConfig(result.configuration);
      setWhatsappDraft({accessToken:"",phoneNumberId:"",businessAccountId:"",apiVersion:"v27.0",appSecret:"",verifyToken:""});
      setWhatsappNotice(t("agency.whatsappSaved"));
    }catch(err){setWhatsappError(err.message);}
    finally{setWhatsappBusy("");}
  };
  const clearWhatsAppConfig=async()=>{
    setWhatsappBusy("clear");setWhatsappError("");setWhatsappNotice("");
    try{
      const result=await api("/agency/"+enc(orgId)+"/whatsapp/config",{method:"DELETE"});
      setWhatsappConfig(result.configuration);
      setWhatsappDraft({accessToken:"",phoneNumberId:"",businessAccountId:"",apiVersion:"v27.0",appSecret:"",verifyToken:""});
      setWhatsappClearConfirm(false);
      setWhatsappNotice(t("agency.whatsappCleared"));
    }catch(err){setWhatsappError(err.message);}
    finally{setWhatsappBusy("");}
  };
  const saveQualificationProfile=async(e)=>{
    e.preventDefault();setBusy("qualification-profile");setError("");
    try{
      const payload={
        targetIndustries:splitValues(qualificationDraft.targetIndustries),
        targetCountries:splitValues(qualificationDraft.targetCountries),
        excludedIndustries:splitValues(qualificationDraft.excludedIndustries),
        requiredEvidenceDomains:splitValues(qualificationDraft.requiredEvidenceDomains),
        requireWebsite:qualificationDraft.requireWebsite,
      };
      await api("/agency/"+enc(orgId)+"/qualification-profile",{method:"PUT",body:payload});
      setQualificationForm(false);
      if(selected){
        const assessment=await api("/agency/"+enc(orgId)+"/companies/"+enc(selected)+"/qualification");
        setQualification(assessment.assessment);
      }
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const startResearch=async()=>{
    if(!selected||researchJobs.some(isActiveResearch)||researchLaunchActive)return;
    setBusy("research-start");setError("");setResearchImportMessage("");
    try{
      const started=await api("/agency/"+enc(orgId)+"/companies/"+enc(selected)+"/research/start",{
        method:"POST",body:{}
      });
      setResearchLaunch({turnId:started.turnId,status:"running"});
      setResearchImportMessage(t("agency.researchStarted"));
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const importResearch=async()=>{
    if(!researchJobId||!selected)return;
    setBusy("research-import");setError("");setResearchImportMessage("");
    try{
      const result=await api("/agency/"+enc(orgId)+"/companies/"+enc(selected)+"/research/import",{
        method:"POST",body:{jobId:researchJobId}
      });
      setResearchImportMessage(t("agency.researchImportResult",{
        imported:result.imported||0,duplicates:result.duplicates||0,uncited:result.uncited||0
      }));
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createCatalogItem=async(e)=>{
    e.preventDefault();setBusy("catalog");setError("");
    try{
      await api(`/agency/${enc(orgId)}/catalog`,{method:"POST",body:{
        ...catalogDraft,
        estimatedDays:Number(catalogDraft.estimatedDays),
        priceMin:Number(catalogDraft.priceMin),
        priceBase:Number(catalogDraft.priceBase),
        priceMax:Number(catalogDraft.priceMax),
        estimatedCost:Number(catalogDraft.estimatedCost)
      }});
      setCatalogDraft(blankCatalogDraft);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const previewTiers=async(catalogItemId)=>{
    setBusy("tiers");setError("");
    try{
      const d=await api(`/agency/${enc(orgId)}/quotes/tiered-preview`,{method:"POST",body:{catalogItemId}});
      setTierPreview(d.tiers||[]);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const saveCommercialRules=async(e)=>{
    e.preventDefault();setBusy("rules");setError("");setRulesNotice("");
    try{
      await api(`/agency/${enc(orgId)}/commercial-rules`,{method:"PUT",body:{
        minMarginPct:Number(rulesDraft.minMarginPct),
        maxAutonomousDiscountPct:Number(rulesDraft.maxAutonomousDiscountPct),
        defaultDepositPct:Number(rulesDraft.defaultDepositPct),
        requireOwnerApprovalAboveAmount:Number(rulesDraft.requireOwnerApprovalAboveAmount),
        paymentTermsDefault:rulesDraft.paymentTermsDefault
      }});
      setRulesNotice(t("agency.rulesSaved"));setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const saveNeeds=async(e)=>{
    e.preventDefault();if(!selectedLeadId)return;
    setBusy("needs");setError("");setNeedsNotice("");
    try{
      await api(`/agency/${enc(orgId)}/leads/${enc(selectedLeadId)}/needs`,{method:"PUT",body:{
        problemStatement:needsDraft.problemStatement,
        solutionType:needsDraft.solutionType,
        mustHaveFeatures:splitValues(needsDraft.mustHaveFeatures),
        desiredTimeline:needsDraft.desiredTimeline,
        budgetMin:Number(needsDraft.budgetMin||0),
        budgetMax:Number(needsDraft.budgetMax||0),
        clientConfirmed:needsDraft.clientConfirmed
      }});
      setNeedsNotice(t("agency.needsSaved"));setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const startConversation=async(e)=>{
    e.preventDefault();if(!selectedLeadId)return;
    setBusy("conv");setError("");
    try{
      const d=await api(`/agency/${enc(orgId)}/conversations`,{method:"POST",body:{
        leadId:selectedLeadId,channel:convDraft.channel,subject:convDraft.subject
      }});
      setConvDraft({channel:"email",subject:""});setSelectedConvId(d.conversation.id);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const postConvMessage=async(direction)=>{
    if(!selectedConvId||!msgBody.trim())return;
    setBusy("msg");setError("");
    try{
      await api(`/agency/${enc(orgId)}/conversations/${enc(selectedConvId)}/messages`,{
        method:"POST",body:{direction,body:msgBody}
      });
      setMsgBody("");setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const handoffConv=async(convId)=>{
    setBusy("handoff");setError("");
    try{
      await api(`/agency/${enc(orgId)}/conversations/${enc(convId)}/handoff`,{method:"POST",body:{reason:"Owner review requested from CRM"}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createQuote=async(e)=>{
    e.preventDefault();if(!selectedLeadId)return;
    setBusy("quote");setError("");
    try{
      await api(`/agency/${enc(orgId)}/quotes`,{method:"POST",body:{
        leadId:selectedLeadId,title:quoteDraft.title,tier:quoteDraft.tier,
        discountPct:Number(quoteDraft.discountPct||0),
        lines:[{
          label:quoteDraft.lineLabel||quoteDraft.title,quantity:1,
          unitPrice:Number(quoteDraft.linePrice),unitCost:Number(quoteDraft.lineCost),
          estimatedDays:Number(quoteDraft.lineDays)
        }]
      }});
      setQuoteDraft(blankQuoteDraft);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const evaluateQuoteNeg=async(quoteId)=>{
    setBusy("neg");setError("");
    try{
      const d=await api(`/agency/${enc(orgId)}/quotes/${enc(quoteId)}/negotiate`,{
        method:"POST",body:{requestedDiscountPct:Number(negDiscount||0)}
      });
      setNegEval({quoteId,...d.evaluation});
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const quoteAction=async(quoteId,action,body={})=>{
    setBusy("quote-act");setError("");
    try{
      await api(`/agency/${enc(orgId)}/quotes/${enc(quoteId)}/${action}`,{method:"POST",body});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const approveRecord=async(approvalId)=>{
    const ap=approvals.find(a=>a.id===approvalId);
    if(!ap)return;
    setBusy("approve");setError("");
    try{
      await api(`/agency/${enc(orgId)}/approvals/${enc(ap.id)}/decision`,{
        method:"POST",body:{decision:"approved",expectedPayloadHash:ap.payloadHash,reason:"Approved in Agency CRM"}
      });
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createContract=async(quoteId)=>{
    setBusy("contract");setError("");
    try{
      await api(`/agency/${enc(orgId)}/contracts`,{method:"POST",body:{quoteId}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const contractAction=async(contractId,action,body={})=>{
    setBusy("contract-act");setError("");
    try{
      await api(`/agency/${enc(orgId)}/contracts/${enc(contractId)}/${action}`,{method:"POST",body});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const activeResearchJobs=researchJobs.filter(isActiveResearch);
  const launchUpdated=researchLaunch?.updatedAt?Date.parse(researchLaunch.updatedAt):Number.NaN;
  const researchLaunchActive=researchLaunch?.status==="running"&&(!Number.isFinite(launchUpdated)||Date.now()-launchUpdated<30*60_000);
  const stalledResearchJobs=researchJobs.filter(job=>ACTIVE_RESEARCH.has(job.status)&&!isActiveResearch(job));
  const failedResearchJobs=researchJobs.filter(job=>job.status==="failed"||job.status==="cancelled");
  const completedResearchJobs=researchJobs.filter(job=>job.status==="completed");
  const selectedCompany=(tab==="companies"?(rows.items||[]).find(x=>x.id===selected):null);
  const totalPages=Math.max(1,Math.ceil((rows.total||0)/SIZE));

  return html`<section class="agency-screen view" data-screen="agency">
    <header class="agency-header">
      <div><span class="agency-eyebrow">${t("agency.eyebrow")}</span><h1 class="t-page">${t("agency.title")}</h1><p>${t("agency.description")}</p></div>
      ${orgs.length>0&&html`<label class="agency-org-picker"><span>${t("agency.organization")}</span><select class="field" value=${orgId} onChange=${e=>changeOrg(e.currentTarget.value)}>${orgs.map(o=>html`<option value=${o.id}>${o.name}</option>`)}</select></label>`}
    </header>
    ${orgError&&html`<div class="agency-alert" role="alert">${orgError}</div>`}
    ${orgLoading&&html`<div class="agency-loading"><${Spinner}/>${t("agency.loading")}</div>`}
    ${!orgLoading&&!orgs.length&&html`<div class="agency-first-org"><h2>${t("agency.firstTitle")}</h2><p>${t("agency.firstDescription")}</p>
      <form class="agency-form agency-create-org" onSubmit=${createOrg}><${Field} label=${t("agency.organizationName")} value=${orgName} required onInput=${setOrgName}/>
        <button class="btn primary" type="submit" disabled=${!!busy||!orgName.trim()}>${busy==="org"?t("agency.creating"):t("agency.createOrganization")}</button></form></div>`}

    ${orgId&&html`
      <div class="agency-metrics">
        <${Metric} label=${t("agency.companies")} value=${dashboard?.companyCount} icon="folder"/>
        <${Metric} label=${t("agency.contacts")} value=${dashboard?.contactCount} icon="user"/>
        <${Metric} label=${t("agency.leads")} value=${dashboard?.leadCount} icon="clipboardCheck"/>
        <${Metric} label=${t("agency.won")} value=${dashboard?.wonLeadCount} icon="check"/>
      </div>
      <section class="agency-whatsapp-card">
        <div class="agency-whatsapp-heading">
          <div><span class="agency-eyebrow">${t("agency.whatsappEyebrow")}</span><h2>${t("agency.whatsappTitle")}</h2><p>${t("agency.whatsappDescription")}</p></div>
          <button class="btn" type="button" aria-expanded=${whatsappOpen} onClick=${()=>{setWhatsappOpen(v=>!v);setWhatsappError("");setWhatsappNotice("");}}>
            ${whatsappOpen?t("agency.cancel"):t("agency.whatsappConfigure")}
          </button>
        </div>
        ${whatsappConfig&&html`<div class="agency-whatsapp-status">
          <span class=${"agency-whatsapp-dot "+(whatsappConfig.configured?"ready":"")}></span>
          <strong>${whatsappConfig.configured?t("agency.whatsappConnected"):t("agency.whatsappNotConnected")}</strong>
          <span>${whatsappConfig.source==="secure_storage"?t("agency.whatsappSecureStorage"):whatsappConfig.source==="environment"?t("agency.whatsappEnvironment"):t("agency.whatsappNoCredential")}</span>
          ${whatsappConfig.phoneNumberId&&html`<code>${whatsappConfig.phoneNumberId}</code>`}
          ${whatsappConfig.webhookConfigured&&html`<span class="agency-whatsapp-webhook-ready">${t("agency.whatsappWebhookReady")}</span>`}
        </div>`}
        ${whatsappOpen&&html`
          ${whatsappBusy==="load"&&html`<div class="agency-loading"><${Spinner}/>${t("agency.loading")}</div>`}
          ${whatsappError&&html`<div class="agency-alert" role="alert">${whatsappError}</div>`}
          ${whatsappNotice&&html`<p class="agency-research-feedback" role="status">${whatsappNotice}</p>`}
          ${whatsappConfig&&!whatsappConfig.secureStorageAvailable&&html`<div class="agency-whatsapp-note">${t("agency.whatsappSecureStorageUnavailable",{reason:whatsappConfig.secureStorageReason||"unknown"})} ${whatsappConfig.environmentConfigured?t("agency.whatsappEnvironmentActive"):t("agency.whatsappDesktopOnly")}</div>`}
          ${whatsappConfig?.secureStorageReason&&whatsappConfig.secureStorageAvailable&&html`<div class="agency-whatsapp-note">${t("agency.whatsappSecureStorageUnavailable",{reason:whatsappConfig.secureStorageReason})}</div>`}
          ${whatsappConfig?.savedInSecureStorage&&!whatsappConfig.organizationMatches&&!whatsappConfig.secureStorageReason&&html`<div class="agency-whatsapp-note">${t("agency.whatsappStoredForOtherOrg")}</div>`}
          ${whatsappConfig?.secureStorageAvailable&&(!whatsappConfig.savedInSecureStorage||whatsappConfig.organizationMatches)&&html`
            <form class="agency-form agency-form-grid agency-whatsapp-form" onSubmit=${saveWhatsAppConfig}>
              <div class="agency-form-head"><div><h3>${whatsappConfig.savedInSecureStorage?t("agency.whatsappReplaceTitle"):t("agency.whatsappCredentialsTitle")}</h3><p>${t("agency.whatsappSecretNote")}</p></div></div>
              <${Field} label=${t("agency.whatsappAccessToken")} value=${whatsappDraft.accessToken} type="password" required onInput=${v=>update(setWhatsappDraft,"accessToken",v)}/>
              <${Field} label=${t("agency.whatsappPhoneNumberId")} value=${whatsappDraft.phoneNumberId} required onInput=${v=>update(setWhatsappDraft,"phoneNumberId",v)}/>
              <${Field} label=${t("agency.whatsappBusinessAccountId")} value=${whatsappDraft.businessAccountId} required onInput=${v=>update(setWhatsappDraft,"businessAccountId",v)}/>
              <${Field} label=${t("agency.whatsappGraphVersion")} value=${whatsappDraft.apiVersion} required onInput=${v=>update(setWhatsappDraft,"apiVersion",v)}/>
              <${Field} label=${t("agency.whatsappAppSecret")} value=${whatsappDraft.appSecret} type="password" onInput=${v=>update(setWhatsappDraft,"appSecret",v)}/>
              <${Field} label=${t("agency.whatsappVerifyToken")} value=${whatsappDraft.verifyToken} type="password" onInput=${v=>update(setWhatsappDraft,"verifyToken",v)}/>
              <p class="agency-muted agency-form-wide">${t("agency.whatsappOrganizationBinding")}</p>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${whatsappBusy==="save"||whatsappBusy==="clear"||!whatsappDraft.accessToken.trim()||!whatsappDraft.phoneNumberId.trim()||!whatsappDraft.businessAccountId.trim()}>${whatsappBusy==="save"?t("agency.whatsappSaving"):t("agency.whatsappSave")}</button></div>
            </form>
          `}
          ${whatsappConfig?.savedInSecureStorage&&(whatsappConfig.organizationMatches||!!whatsappConfig.secureStorageReason)&&html`
            <div class="agency-whatsapp-clear">
              ${!whatsappClearConfirm
                ?html`<button class="text" type="button" onClick=${()=>setWhatsappClearConfirm(true)}>${t("agency.whatsappRemove")}</button>`
                :html`<span>${t("agency.whatsappConfirmRemove")}</span><button class="btn" type="button" disabled=${whatsappBusy==="clear"} onClick=${clearWhatsAppConfig}>${whatsappBusy==="clear"?t("agency.whatsappRemoving"):t("agency.whatsappConfirm")}</button><button class="text" type="button" onClick=${()=>setWhatsappClearConfirm(false)}>${t("agency.cancel")}</button>`}
            </div>`}
        `}
      </section>
      <section class="agency-whatsapp-workflow">
        <div class="agency-whatsapp-heading">
          <div><span class="agency-eyebrow">${t("agency.whatsappWorkflowEyebrow")}</span><h2>${t("agency.whatsappWorkflowTitle")}</h2><p>${t("agency.whatsappWorkflowHint")}</p></div>
          <div class="agency-whatsapp-workflow-actions">
            <button class="btn" type="button" onClick=${()=>setWhatsappWorkflowOpen(v=>!v)}>${whatsappWorkflowOpen?t("agency.cancel"):t("agency.whatsappWorkflowOpen")}</button>
            ${whatsappWorkflowOpen&&html`<button class="btn" type="button" disabled=${whatsappWorkflowBusy} onClick=${refreshWhatsAppWorkflow}>${whatsappWorkflowBusy?t("agency.loading"):t("agency.whatsappRefresh")}</button>`}
          </div>
        </div>
        ${whatsappWorkflowOpen&&html`
          ${whatsappWorkflowError&&html`<div class="agency-alert" role="alert">${whatsappWorkflowError}</div>`}
          <div class="agency-whatsapp-workflow-grid">
            <section class="agency-whatsapp-list">
              <div class="agency-contact-heading"><h3>${t("agency.whatsappApprovals")}</h3><span class="agency-qualification-status">${whatsappApprovals.filter(a=>a.action==="send_message"&&a.resourceType==="whatsapp_template").length}</span></div>
              ${whatsappApprovals.filter(a=>a.action==="send_message"&&a.resourceType==="whatsapp_template").map(approval=>{
                const payload=approvalPayload(approval);
                const expired=approval.status==="pending"&&approval.expiresAt&&approval.expiresAt<=Date.now();
                const queued=whatsappOutbox.some(item=>item.approvalId===approval.id);
                return html`<article class="agency-whatsapp-item">
                  <div class="agency-whatsapp-item-head"><strong>${payload?.template?.name||approval.resourceId}</strong><span class=${"agency-whatsapp-state "+(expired?"expired":approval.status)}>${t(`agency.whatsappApprovalStatus.${expired?"expired":approval.status}`)}</span></div>
                  <p>${payload?.recipient||approval.resourceId} · ${payload?.purpose||"—"} · ${payload?.template?.language||"—"}</p>
                  <small>${approval.reason}</small>
                  <small>${t("agency.whatsappPayloadHash")} <code>${approval.payloadHash}</code></small>
                  ${payload?.template&&html`<details class="agency-whatsapp-preview"><summary>${t("agency.whatsappExactPayload")}</summary><pre>${JSON.stringify(payload.template.components||[],null,2)}</pre></details>`}
                  ${approval.decisionReason&&html`<small>${t("agency.whatsappDecisionReason")} ${approval.decisionReason}</small>`}
                  <small>${t("agency.whatsappExpires")} ${new Date(approval.expiresAt).toLocaleString()}</small>
                  ${approval.status==="pending"&&!expired&&html`<div class="agency-whatsapp-item-actions">
                    <button class="btn primary" type="button" disabled=${whatsappWorkflowBusy} onClick=${()=>decideWhatsAppApproval(approval,"approved")}>${t("agency.whatsappApprove")}</button>
                    <button class="btn" type="button" disabled=${whatsappWorkflowBusy} onClick=${()=>decideWhatsAppApproval(approval,"rejected")}>${t("agency.whatsappReject")}</button>
                  </div>`}
                  ${approval.status==="approved"&&!queued&&html`<button class="btn" type="button" disabled=${whatsappWorkflowBusy||!payload} onClick=${()=>queueWhatsAppApproval(approval)}>${t("agency.whatsappQueue")}</button>`}
                  ${approval.status==="approved"&&queued&&html`<small>${t("agency.whatsappAlreadyQueued")}</small>`}
                </article>`;
              })}
              ${!whatsappApprovals.some(a=>a.action==="send_message"&&a.resourceType==="whatsapp_template")&&html`<p class="agency-muted">${t("agency.whatsappNoApprovals")}</p>`}
            </section>
            <section class="agency-whatsapp-list">
              <div class="agency-contact-heading"><h3>${t("agency.whatsappOutbox")}</h3><span class="agency-qualification-status">${whatsappOutbox.length}</span></div>
              ${whatsappOutbox.map(message=>html`<article class="agency-whatsapp-item">
                <div class="agency-whatsapp-item-head"><strong>${message.templateName}</strong><span class=${"agency-whatsapp-state "+message.status}>${t(`agency.whatsappOutboxStatus.${message.status}`)}</span></div>
                <p>${message.recipient} · ${message.language}</p>
                <small>${t("agency.whatsappProviderStatus")} ${message.providerStatus?t(`agency.whatsappProviderStatusValues.${message.providerStatus}`):t("agency.whatsappProviderPending")}</small>
                ${(message.failureCode||message.providerErrorCode)&&html`<small>${t("agency.whatsappFailure")} ${message.failureCode||message.providerErrorCode}</small>`}
                ${message.status==="queued"&&html`
                  ${whatsappSendConfirmId!==message.id
                    ?html`<button class="btn" type="button" disabled=${whatsappWorkflowBusy} onClick=${()=>setWhatsappSendConfirmId(message.id)}>${t("agency.whatsappSend")}</button>`
                    :html`<div class="agency-whatsapp-item-actions"><span>${t("agency.whatsappSendConfirm")}</span><button class="btn primary" type="button" disabled=${whatsappWorkflowBusy} onClick=${()=>sendWhatsAppOutbox(message)}>${t("agency.whatsappConfirmSend")}</button><button class="text" type="button" onClick=${()=>setWhatsappSendConfirmId("")}>${t("agency.cancel")}</button></div>`}
                `}
              </article>`)}
              ${!whatsappOutbox.length&&html`<p class="agency-muted">${t("agency.whatsappNoOutbox")}</p>`}
            </section>
          </div>
          <p class="agency-muted">${t("agency.whatsappAcceptedNote")}</p>
        `}
      </section>
      <div class="agency-toolbar">
        <div class="agency-tabs" role="tablist">
          <button role="tab" aria-selected=${tab==="companies"} class=${tab==="companies"?"active":""} onClick=${()=>{setTab("companies");setPage(0);}}>${t("agency.companies")}</button>
          <button role="tab" aria-selected=${tab==="leads"} class=${tab==="leads"?"active":""} onClick=${()=>{setTab("leads");setPage(0);}}>${t("agency.leads")}</button>
          <button role="tab" aria-selected=${tab==="commercial"} class=${tab==="commercial"?"active":""} onClick=${()=>setTab("commercial")}>${t("agency.commercial")}</button>
          <button role="tab" aria-selected=${tab==="catalog"} class=${tab==="catalog"?"active":""} onClick=${()=>setTab("catalog")}>${t("agency.catalog")}</button>
        </div>
        ${tab==="companies"&&html`<button class="btn" onClick=${()=>setQualificationForm(v=>!v)}>${t("agency.qualificationProfile")}</button>`}
        ${(tab==="companies"||tab==="leads")&&html`<label class="agency-search"><${Icon} name="search"/><input type="search" value=${query} placeholder=${t("agency.search")} onInput=${e=>{setQuery(e.currentTarget.value);setPage(0);}}/></label>`}
        ${tab==="companies"
          ?html`<button class="btn primary" onClick=${()=>setCompanyForm(v=>!v)}><${Icon} name="plus"/>${t("agency.newCompany")}</button>`
          :tab==="leads"
            ?html`<button class="btn primary" disabled=${!dashboard?.companyCount} onClick=${()=>setLeadForm(v=>!v)}><${Icon} name="plus"/>${t("agency.newLead")}</button>`
            :null}
      </div>
      ${error&&html`<div class="agency-alert" role="alert">${error}</div>`}
      ${qualificationForm&&tab==="companies"&&orgId&&html`<form class="agency-form agency-form-grid agency-qualification-form" onSubmit=${saveQualificationProfile}>
        <div class="agency-form-head"><div><h2>${t("agency.qualificationProfile")}</h2><p>${t("agency.qualificationProfileHint")}</p></div><button type="button" class="text" onClick=${()=>setQualificationForm(false)}>${t("agency.cancel")}</button></div>
        <${Field} label=${t("agency.targetIndustries")} value=${qualificationDraft.targetIndustries} placeholder="software, santé, commerce" onInput=${v=>update(setQualificationDraft,"targetIndustries",v)}/>
        <${Field} label=${t("agency.targetCountries")} value=${qualificationDraft.targetCountries} placeholder="SN, CI, BJ" onInput=${v=>update(setQualificationDraft,"targetCountries",v)}/>
        <${Field} label=${t("agency.excludedIndustries")} value=${qualificationDraft.excludedIndustries} placeholder="secteurs à exclure" onInput=${v=>update(setQualificationDraft,"excludedIndustries",v)}/>
        <${Field} label=${t("agency.requiredEvidenceDomains")} value=${qualificationDraft.requiredEvidenceDomains} placeholder="company, financial, news" onInput=${v=>update(setQualificationDraft,"requiredEvidenceDomains",v)}/>
        <label class="agency-qualification-checkbox"><input type="checkbox" checked=${qualificationDraft.requireWebsite} onChange=${e=>update(setQualificationDraft,"requireWebsite",e.currentTarget.checked)}/><span>${t("agency.requireWebsite")}</span></label>
        <p class="agency-muted agency-form-wide">${t("agency.qualificationProfileNote")}</p>
        <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${busy==="qualification-profile"}>${busy==="qualification-profile"?t("agency.creating"):t("agency.saveProfile")}</button></div>
      </form>`}
      ${companyForm&&tab==="companies"&&html`<form class="agency-form agency-form-grid" onSubmit=${createCompany}>
        <div class="agency-form-head"><h2>${t("agency.newCompany")}</h2><button type="button" class="text" onClick=${()=>setCompanyForm(false)}>${t("agency.cancel")}</button></div>
        <${Field} label=${t("agency.companyName")} value=${company.name} required onInput=${v=>update(setCompany,"name",v)}/>
        <${Field} label=${t("agency.website")} value=${company.website} placeholder="https://" onInput=${v=>update(setCompany,"website",v)}/>
        <${Field} label=${t("agency.industry")} value=${company.industry} onInput=${v=>update(setCompany,"industry",v)}/>
        <${Field} label=${t("agency.city")} value=${company.city} onInput=${v=>update(setCompany,"city",v)}/>
        <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.saveCompany")}</button></div>
      </form>`}
      ${leadForm&&tab==="leads"&&html`<form class="agency-form agency-form-grid" onSubmit=${createLead}>
        <div class="agency-form-head"><h2>${t("agency.newLead")}</h2><button type="button" class="text" onClick=${()=>setLeadForm(false)}>${t("agency.cancel")}</button></div>
        <label class="agency-field"><span>${t("agency.company")}</span><select class="field" value=${lead.companyId} required onChange=${e=>update(setLead,"companyId",e.currentTarget.value)}>
          <option value="">${t("agency.chooseCompany")}</option>${companyOptions.map(c=>html`<option value=${c.id}>${c.name}</option>`)}
        </select></label>
        <${Field} label=${t("agency.source")} value=${lead.source} onInput=${v=>update(setLead,"source",v)}/>
        <${Field} label=${t("agency.notes")} value=${lead.notes} onInput=${v=>update(setLead,"notes",v)}/>
        <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy||!lead.companyId}>${t("agency.saveLead")}</button></div>
      </form>`}
      ${busy==="load"&&html`<div class="agency-loading"><${Spinner}/>${t("agency.loading")}</div>`}
      ${!busy&&tab==="companies"&&!rows.items?.length&&html`<${Empty} title=${t("agency.noCompanies")} detail=${query?t("agency.noSearchResults"):t("agency.noCompaniesHint")}/>`}
      ${tab==="companies"&&rows.items?.length>0&&html`<div class="agency-content-grid">
        <div class="agency-table-wrap"><table class="agency-table"><thead><tr><th>${t("agency.company")}</th><th>${t("agency.industry")}</th><th>${t("agency.city")}</th></tr></thead>
          <tbody>${rows.items.map(c=>html`<tr class=${selected===c.id?"selected":""}><td><button class="agency-company-link" onClick=${()=>{setSelected(v=>v===c.id?"":c.id);setConsentContactId("");}}><strong>${c.name}</strong><small>${c.website||c.countryCode||"—"}</small></button></td><td>${c.industry||"—"}</td><td>${c.city||"—"}</td></tr>`)}</tbody>
        </table></div>
        ${selectedCompany&&html`<aside class="agency-detail"><div class="agency-detail-head"><div><span class="agency-eyebrow">${t("agency.companyDetails")}</span><h2>${selectedCompany.name}</h2></div><button class="icon-btn" aria-label=${t("agency.close")} onClick=${()=>{setSelected("");setConsentContactId("");}}><${Icon} name="close"/></button></div>
          <dl class="agency-detail-facts"><div><dt>${t("agency.website")}</dt><dd>${selectedCompany.website||"—"}</dd></div><div><dt>${t("agency.industry")}</dt><dd>${selectedCompany.industry||"—"}</dd></div><div><dt>${t("agency.city")}</dt><dd>${selectedCompany.city||"—"}</dd></div></dl>
          <div class="agency-contact-heading"><h3>${t("agency.contacts")}</h3><button class="text" onClick=${()=>setContactForm(v=>!v)}>${t("agency.addContact")}</button></div>
          ${contactForm&&html`<form class="agency-form agency-contact-form" onSubmit=${createContact}><${Field} label=${t("agency.contactName")} value=${contact.displayName} required onInput=${v=>update(setContact,"displayName",v)}/><${Field} label=${t("agency.role")} value=${contact.role} onInput=${v=>update(setContact,"role",v)}/><${Field} label=${t("agency.email")} value=${contact.email} type="email" onInput=${v=>update(setContact,"email",v)}/><${Field} label=${t("agency.phone")} value=${contact.phone} type="tel" onInput=${v=>update(setContact,"phone",v)}/><button class="btn primary block" type="submit">${t("agency.saveContact")}</button></form>`}
          ${contacts.map(p=>{
            const latest=whatsappConsents.filter(item=>item.purpose===whatsappConsentDraft.purpose.trim().toLowerCase())[0];
            const consentActive=!!latest&&latest.status==="granted"&&whatsappConsentDraft.status==="granted"&&(!latest.expiresAt||latest.expiresAt>Date.now())&&!!latest.source&&!!latest.proof&&!!latest.textVersion;
            const recipient=cleanPhone(p.phone);
            const phoneValid=/^\+[1-9][0-9]{7,14}$/.test(recipient);
            return html`<div class="agency-contact-manage">
              <div class="agency-contact-row"><span class="agency-contact-avatar">${(p.displayName||"?").slice(0,1).toUpperCase()}</span><span><strong>${p.displayName}</strong><small>${p.role||p.email||p.phone||"—"}</small></span>
                <button class="text" type="button" aria-expanded=${consentContactId===p.id} onClick=${()=>openWhatsAppConsent(p)}>${consentContactId===p.id?t("agency.cancel"):t("agency.whatsappManageConsent")}</button>
              </div>
              ${consentContactId===p.id&&html`
                <section class="agency-consent-panel">
                  <div class="agency-contact-heading"><h4>${t("agency.whatsappConsentTitle")}</h4><span class="agency-qualification-status">${latest?t(`agency.whatsappConsentStatus.${latest.status}`):t("agency.whatsappConsentMissing")}</span></div>
                  ${whatsappConsentError&&html`<div class="agency-alert" role="alert">${whatsappConsentError}</div>`}
                  ${whatsappConsentNotice&&html`<p class="agency-research-feedback" role="status">${whatsappConsentNotice}</p>`}
                  ${whatsappConsentBusy&&html`<div class="agency-loading"><${Spinner}/>${t("agency.loading")}</div>`}
                  <form class="agency-form agency-consent-form" onSubmit=${saveWhatsAppConsent}>
                    <${Field} label=${t("agency.whatsappPurpose")} value=${whatsappConsentDraft.purpose} required onInput=${v=>update(setWhatsappConsentDraft,"purpose",v)}/>
                    <label class="agency-field"><span>${t("agency.whatsappConsentAction")}</span><select class="field" value=${whatsappConsentDraft.status} onChange=${e=>update(setWhatsappConsentDraft,"status",e.currentTarget.value)}><option value="granted">${t("agency.whatsappGrant")}</option><option value="withdrawn">${t("agency.whatsappWithdraw")}</option></select></label>
                    <${Field} label=${t("agency.whatsappConsentSource")} value=${whatsappConsentDraft.source} required onInput=${v=>update(setWhatsappConsentDraft,"source",v)}/>
                    <${Field} label=${t("agency.whatsappConsentProof")} value=${whatsappConsentDraft.proof} required placeholder=${t("agency.whatsappConsentProofHint")} onInput=${v=>update(setWhatsappConsentDraft,"proof",v)}/>
                    ${whatsappConsentDraft.status==="granted"&&html`<${Field} label=${t("agency.whatsappConsentTextVersion")} value=${whatsappConsentDraft.textVersion} required onInput=${v=>update(setWhatsappConsentDraft,"textVersion",v)}/>`}
                    <button class="btn primary" type="submit" disabled=${whatsappConsentBusy}>${t("agency.whatsappSaveConsent")}</button>
                  </form>
                  <div class="agency-consent-history">
                    ${whatsappConsents.map(item=>html`<div><strong>${t(`agency.whatsappConsentStatus.${item.status}`)} · ${item.purpose}</strong><small>${item.source} · ${item.textVersion||"—"} · ${new Date(item.createdAt).toLocaleString()}</small><small>${t("agency.whatsappConsentProof")}: ${item.proof}</small></div>`)}
                  </div>
                  <div class="agency-contact-heading"><h4>${t("agency.whatsappPrepareTemplate")}</h4><span class="agency-qualification-status">${consentActive?t("agency.whatsappConsentActive"):t("agency.whatsappConsentRequired")}</span></div>
                  ${!phoneValid&&html`<p class="agency-muted">${t("agency.whatsappPhoneInvalid")}</p>`}
                  <form class="agency-form agency-consent-form" onSubmit=${e=>requestWhatsAppApproval(e,p)}>
                    <${Field} label=${t("agency.whatsappTemplateName")} value=${whatsappTemplateDraft.name} required onInput=${v=>update(setWhatsappTemplateDraft,"name",v)}/>
                    <${Field} label=${t("agency.whatsappTemplateLanguage")} value=${whatsappTemplateDraft.language} required onInput=${v=>update(setWhatsappTemplateDraft,"language",v)}/>
                    <label class="agency-field"><span>${t("agency.whatsappTemplateComponents")}</span><textarea class="field" rows="3" value=${whatsappTemplateDraft.components} onInput=${e=>update(setWhatsappTemplateDraft,"components",e.currentTarget.value)}></textarea></label>
                    <${Field} label=${t("agency.whatsappApprovalReason")} value=${whatsappTemplateDraft.reason} required onInput=${v=>update(setWhatsappTemplateDraft,"reason",v)}/>
                    <button class="btn primary" type="submit" disabled=${whatsappConsentBusy||!consentActive||!phoneValid||!whatsappTemplateDraft.name.trim()||!whatsappTemplateDraft.reason.trim()}>${t("agency.whatsappRequestApproval")}</button>
                  </form>
                </section>`}
            </div>`;
          })}

          ${!contacts.length&&html`<p class="agency-muted">${t("agency.noContacts")}</p>`}
          <section class="agency-qualification">
            <div class="agency-contact-heading"><h3>${t("agency.qualificationTitle")}</h3><span class="agency-qualification-status">${qualification?t(`agency.qualificationStatus.${qualification.status}`):"—"}</span></div>
            ${qualification?html`<div class="agency-qualification-score"><strong>${qualification.score===null?"—":qualification.score+"/100"}</strong><span>${t("agency.qualificationCoverage",{coverage:qualification.coverage})}</span></div>
              ${qualification.criteria.map(item=>html`<div class="agency-qualification-criterion"><strong>${t(`agency.qualificationCriteria.${item.id}`)}</strong><span class=${"agency-qualification-result "+item.result}>${t(`agency.qualificationResult.${item.result}`)}</span><small>${t("agency.qualificationExpected",{value:item.expected.join(", ")})} · ${item.observed||t("agency.qualificationUnknownValue")} · ${t("agency.qualificationWeight",{weight:Math.round(item.weight)})}</small></div>`)}
              ${qualification.blockingReasons.length?html`<p class="agency-qualification-warning">${t("agency.qualificationBlocked")}</p>`:null}
              ${qualification.status==="unconfigured"?html`<p class="agency-muted">${t("agency.qualificationNoProfile")}</p>`:null}
            ` : html`<p class="agency-muted">${t("agency.qualificationNoProfile")}</p>`}
            <p class="agency-muted">${t("agency.qualificationManualOnly")}</p>
          </section>
          <section class="agency-research">
            <div class="agency-contact-heading"><h3>${t("agency.researchImportTitle")}</h3><button class="btn" disabled=${!!busy||activeResearchJobs.length>0||researchLaunchActive} onClick=${startResearch}>${busy==="research-start"?t("agency.startingResearch"):t("agency.startResearch")}</button></div>
            ${activeResearchJobs.map(job=>html`<div class="agency-active-job"><div><strong>${t(`agency.jobStatus.${job.status}`)}</strong><span class="num">${job.progress}%</span></div><div class="agency-job-progress"><i style=${{width:Math.max(0,Math.min(100,job.progress))+"%"}}></i></div><small>${job.currentStep||job.id}</small></div>`)}
            ${stalledResearchJobs.map(job=>html`<div class="agency-research-stalled"><strong>${t("agency.researchStalled")}</strong><span>${job.company} · ${job.id}</span></div>`)}
            ${failedResearchJobs.map(job=>html`<div class="agency-research-failed"><strong>${t(`agency.jobStatus.${job.status}`)}</strong><span>${job.company} · ${job.id}</span></div>`)}
            ${researchLaunch?.status==="failed"&&!failedResearchJobs.length&&html`<div class="agency-research-failed"><strong>${t("agency.researchLaunchFailed")}</strong></div>`}
            ${researchLaunch?.status==="done"&&!activeResearchJobs.length&&!completedResearchJobs.length&&!failedResearchJobs.length&&html`<div class="agency-research-stalled"><strong>${t("agency.researchFinishedNoReport")}</strong></div>`}
            ${completedResearchJobs.length?html`<div class="agency-research-import"><label class="agency-field"><span>${t("agency.chooseResearchJob")}</span><select class="field" value=${researchJobId} onChange=${e=>setResearchJobId(e.currentTarget.value)}><option value="">—</option>${completedResearchJobs.map(job=>html`<option value=${job.id}>${job.company} · ${job.sourceCount} ${t("agency.sources")} · ${job.id}</option>`)}</select></label><button class="btn" disabled=${!researchJobId||!!busy} onClick=${importResearch}>${busy==="research-import"?t("agency.importingResearch"):t("agency.importResearch")}</button></div>`:activeResearchJobs.length?null:html`<p class="agency-muted">${t("agency.noResearchJobs")}</p>`}
            ${researchImportMessage&&html`<p class="agency-research-feedback" role="status">${researchImportMessage}</p>`}
            <div class="agency-contact-heading"><h3>${t("agency.researchTitle")}</h3><button class="text" onClick=${()=>setEvidenceForm(v=>!v)}>${t("agency.addEvidence")}</button></div>
            ${research.assessment&&html`<div class="agency-research-score"><strong>${research.assessment.score}/100</strong><span>${t(`agency.researchStatus.${research.assessment.status}`)}</span><small>${research.assessment.evidenceCount} ${t("agency.evidenceCount")} · ${research.assessment.distinctSourceHosts} ${t("agency.sources")}</small></div>`}
            ${evidenceForm&&html`<form class="agency-form agency-evidence-form" onSubmit=${createEvidence}>
              <${Field} label=${t("agency.evidenceType")} value=${evidenceDraft.evidenceType} required onInput=${v=>update(setEvidenceDraft,"evidenceType",v)}/>
              <${Field} label=${t("agency.sourceUrl")} value=${evidenceDraft.sourceUrl} type="url" placeholder="https://" required onInput=${v=>update(setEvidenceDraft,"sourceUrl",v)}/>
              <${Field} label=${t("agency.evidenceConfidence")} value=${evidenceDraft.confidence} type="number" onInput=${v=>update(setEvidenceDraft,"confidence",v)}/>
              <label class="agency-field"><span>${t("agency.evidenceSummary")}</span><textarea class="field" rows="3" required value=${evidenceDraft.summary} onInput=${e=>update(setEvidenceDraft,"summary",e.currentTarget.value)}></textarea></label>
              <button class="btn primary block" type="submit" disabled=${!!busy}>${busy==="evidence"?t("agency.creating"):t("agency.saveEvidence")}</button>
            </form>`}
            ${(research.items||[]).map(item=>html`<article class="agency-evidence-row"><div><strong>${item.evidenceType}</strong><small>${Math.round(item.confidence*100)}% · ${item.observedAt?new Date(item.observedAt).toLocaleDateString():t("agency.dateUnknown")}</small></div><a href=${item.sourceUrl} target="_blank" rel="noopener noreferrer">${item.sourceUrl}</a><p>${item.summary}</p></article>`)}
            ${!research.items?.length&&html`<p class="agency-muted">${t("agency.noEvidence")}</p>`}
          </section>
        </aside>`}
      </div>`}
      ${tab==="leads"&&rows.items?.length>0&&html`<div class="agency-lead-list">${rows.items.map(l=>html`<article class="agency-lead-card"><div class="agency-lead-main"><div><strong>${companyOptions.find(c=>c.id===l.companyId)?.name||l.companyId}</strong><p>${l.notes||l.source||t("agency.noLeadNotes")}</p></div><${Badge} s=${t(`agency.stage.${l.stage}`)}/></div>
        <div class="agency-lead-footer"><span>${t("agency.updated")} · ${new Date(l.updatedAt).toLocaleDateString()}</span><label class="agency-stage-select"><span>${t("agency.moveTo")}</span><select class="field" value=${l.stage} disabled=${busy==="stage"||!NEXT[l.stage]?.length} onChange=${e=>moveLead(l.id,e.currentTarget.value)}><option value=${l.stage}>${t(`agency.stage.${l.stage}`)}</option>${(NEXT[l.stage]||[]).map(s=>html`<option value=${s}>${t(`agency.stage.${s}`)}</option>`)}</select></label></div>
      </article>`)}</div>`}
      ${tab==="leads"&&!busy&&!rows.items?.length&&html`<${Empty} title=${t("agency.noLeads")} detail=${query?t("agency.noSearchResults"):t("agency.noLeadsHint")}/>`}
      ${(tab==="companies"||tab==="leads")&&rows.total>SIZE&&html`<div class="agency-pagination"><button class="btn" disabled=${page===0} onClick=${()=>setPage(v=>Math.max(0,v-1))}>${t("agency.previous")}</button><span>${t("agency.page",{current:page+1,total:Math.ceil(rows.total/SIZE)})}</span><button class="btn" disabled=${(page+1)*SIZE>=rows.total} onClick=${()=>setPage(v=>v+1)}>${t("agency.next")}</button></div>`}
      ${tab==="catalog"&&html`<div class="agency-commercial-grid">
        <section class="agency-commercial-section">
          <h2>${t("agency.catalogTitle")}</h2>
          <form class="agency-form agency-form-grid" onSubmit=${createCatalogItem}>
            <div class="agency-form-head"><h3>${t("agency.newCatalogItem")}</h3></div>
            <${Field} label=${t("agency.catalogCode")} value=${catalogDraft.code} required onInput=${v=>update(setCatalogDraft,"code",v)}/>
            <${Field} label=${t("agency.catalogName")} value=${catalogDraft.name} required onInput=${v=>update(setCatalogDraft,"name",v)}/>
            <label class="agency-field"><span>${t("agency.catalogCategory")}</span><select class="field" value=${catalogDraft.category} onChange=${e=>update(setCatalogDraft,"category",e.currentTarget.value)}>${SOLUTION_TYPES.map(st=>html`<option value=${st}>${t(`agency.solutionType.${st}`)}</option>`)}</select></label>
            <${Field} label=${t("agency.catalogDays")} value=${catalogDraft.estimatedDays} type="number" required onInput=${v=>update(setCatalogDraft,"estimatedDays",v)}/>
            <${Field} label=${t("agency.catalogPriceMin")} value=${catalogDraft.priceMin} type="number" required onInput=${v=>update(setCatalogDraft,"priceMin",v)}/>
            <${Field} label=${t("agency.catalogPriceBase")} value=${catalogDraft.priceBase} type="number" required onInput=${v=>update(setCatalogDraft,"priceBase",v)}/>
            <${Field} label=${t("agency.catalogPriceMax")} value=${catalogDraft.priceMax} type="number" required onInput=${v=>update(setCatalogDraft,"priceMax",v)}/>
            <${Field} label=${t("agency.catalogCost")} value=${catalogDraft.estimatedCost} type="number" required onInput=${v=>update(setCatalogDraft,"estimatedCost",v)}/>
            <label class="agency-field agency-form-wide"><span>${t("agency.catalogDescription")}</span><textarea class="field" rows="2" required value=${catalogDraft.description} onInput=${e=>update(setCatalogDraft,"description",e.currentTarget.value)}></textarea></label>
            <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.saveCatalogItem")}</button></div>
          </form>
          <div class="agency-commercial-list">
            ${!catalogItems.length&&html`<p class="agency-muted">${t("agency.noCatalogItems")}</p>`}
            ${catalogItems.map(item=>html`<article class="agency-commercial-card">
              <div class="agency-commercial-head"><strong>${item.name} (${item.code})</strong><span class="agency-qualification-status">${t(`agency.solutionType.${item.category}`)}</span></div>
              <p>${item.description}</p>
              <small>${item.priceMin} – ${item.priceBase} – ${item.priceMax} · ${item.estimatedDays}d</small>
              <div class="agency-commercial-actions"><button class="btn" type="button" onClick=${()=>previewTiers(item.id)}>${t("agency.previewTiers")}</button></div>
            </article>`)}
            ${tierPreview.length>0&&tierPreview.map(tier=>html`<article class="agency-commercial-card">
              <div class="agency-commercial-head"><strong>${tier.title}</strong><span class="agency-qualification-status">${t("agency.marginLabel",{pct:tier.marginPct})}</span></div>
              <p>${tier.scopeSummary}</p>
              <small>${tier.price} · ${tier.estimatedDays}d</small>
            </article>`)}
          </div>
        </section>
        <section class="agency-commercial-section">
          <h2>${t("agency.commercialRulesTitle")}</h2>
          ${rulesNotice&&html`<p class="agency-research-feedback" role="status">${rulesNotice}</p>`}
          <form class="agency-form" onSubmit=${saveCommercialRules}>
            <${Field} label=${t("agency.minMarginPct")} value=${rulesDraft.minMarginPct} type="number" required onInput=${v=>update(setRulesDraft,"minMarginPct",v)}/>
            <${Field} label=${t("agency.maxDiscountPct")} value=${rulesDraft.maxAutonomousDiscountPct} type="number" required onInput=${v=>update(setRulesDraft,"maxAutonomousDiscountPct",v)}/>
            <${Field} label=${t("agency.defaultDepositPct")} value=${rulesDraft.defaultDepositPct} type="number" required onInput=${v=>update(setRulesDraft,"defaultDepositPct",v)}/>
            <${Field} label=${t("agency.ownerThreshold")} value=${rulesDraft.requireOwnerApprovalAboveAmount} type="number" required onInput=${v=>update(setRulesDraft,"requireOwnerApprovalAboveAmount",v)}/>
            <${Field} label=${t("agency.paymentTerms")} value=${rulesDraft.paymentTermsDefault} onInput=${v=>update(setRulesDraft,"paymentTermsDefault",v)}/>
            <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.saveRules")}</button></div>
          </form>
        </section>
      </div>`}
      ${tab==="commercial"&&html`<div class="agency-commercial-section">
        <label class="agency-field"><span>${t("agency.selectLead")}</span><select class="field" value=${selectedLeadId} onChange=${e=>{setSelectedLeadId(e.currentTarget.value);setSelectedConvId("");}}>
          <option value="">—</option>${leadOptions.map(l=>html`<option value=${l.id}>${companyOptions.find(c=>c.id===l.companyId)?.name||l.companyId} · ${t(`agency.stage.${l.stage}`)}</option>`)}
        </select></label>
        ${!selectedLeadId&&html`<p class="agency-muted">${t("agency.noLeadSelected")}</p>`}
        ${selectedLeadId&&html`<div class="agency-commercial-grid">
          <section class="agency-commercial-section">
            <h3>${t("agency.conversationsTitle")}</h3>
            <form class="agency-form" onSubmit=${startConversation}>
              <div class="agency-form-head"><strong>${t("agency.newConversation")}</strong></div>
              <label class="agency-field"><span>${t("agency.channel")}</span><select class="field" value=${convDraft.channel} onChange=${e=>update(setConvDraft,"channel",e.currentTarget.value)}>${CHANNELS.map(ch=>html`<option value=${ch}>${ch}</option>`)}</select></label>
              <${Field} label=${t("agency.subject")} value=${convDraft.subject} required onInput=${v=>update(setConvDraft,"subject",v)}/>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.startConversation")}</button></div>
            </form>
            <div class="agency-commercial-list">
              ${!conversations.filter(c=>c.leadId===selectedLeadId).length&&html`<p class="agency-muted">${t("agency.noConversations")}</p>`}
              ${conversations.filter(c=>c.leadId===selectedLeadId).map(conv=>html`<article class="agency-commercial-card">
                <div class="agency-commercial-head"><button class="text" type="button" onClick=${()=>setSelectedConvId(conv.id)}><strong>${conv.subject}</strong></button><span class="agency-whatsapp-state">${t(`agency.conversationStatus.${conv.status}`)}</span></div>
                <small>${conv.channel}</small>
                <div class="agency-commercial-actions"><button class="btn" type="button" onClick=${()=>setSelectedConvId(conv.id)}>${conv.id===selectedConvId?"•":t("agency.open")}</button>${conv.status!=="opted_out"&&conv.status!=="handoff_human"&&html`<button class="text" type="button" onClick=${()=>handoffConv(conv.id)}>${t("agency.handoffHuman")}</button>`}</div>
              </article>`)}
            </div>
            ${selectedConvId&&html`<div class="agency-commercial-card">
              <div class="agency-msg-list">${convMessages.map(m=>html`<div class="agency-msg-row"><strong>${m.direction} · ${m.signal}</strong><span>${m.body}</span></div>`)}</div>
              <${Field} label=${t("agency.messageBody")} value=${msgBody} onInput=${setMsgBody}/>
              <div class="agency-commercial-actions">
                <button class="btn primary" type="button" disabled=${!!busy||!msgBody.trim()} onClick=${()=>postConvMessage("outbound")}>${t("agency.sendOutbound")}</button>
                <button class="btn" type="button" disabled=${!!busy||!msgBody.trim()} onClick=${()=>postConvMessage("inbound")}>${t("agency.recordInbound")}</button>
              </div>
            </div>`}
          </section>
          <section class="agency-commercial-section">
            <h3>${t("agency.needsTitle")}</h3>
            ${needsNotice&&html`<p class="agency-research-feedback" role="status">${needsNotice}</p>`}
            <form class="agency-form" onSubmit=${saveNeeds}>
              <label class="agency-field"><span>${t("agency.problemStatement")}</span><textarea class="field" rows="2" required value=${needsDraft.problemStatement} onInput=${e=>update(setNeedsDraft,"problemStatement",e.currentTarget.value)}></textarea></label>
              <label class="agency-field"><span>${t("agency.solutionTypeLabel")}</span><select class="field" value=${needsDraft.solutionType} onChange=${e=>update(setNeedsDraft,"solutionType",e.currentTarget.value)}>${SOLUTION_TYPES.map(st=>html`<option value=${st}>${t(`agency.solutionType.${st}`)}</option>`)}</select></label>
              <${Field} label=${t("agency.mustHaveFeatures")} value=${needsDraft.mustHaveFeatures} onInput=${v=>update(setNeedsDraft,"mustHaveFeatures",v)}/>
              <${Field} label=${t("agency.desiredTimeline")} value=${needsDraft.desiredTimeline} onInput=${v=>update(setNeedsDraft,"desiredTimeline",v)}/>
              <${Field} label=${t("agency.budgetMin")} value=${needsDraft.budgetMin} type="number" onInput=${v=>update(setNeedsDraft,"budgetMin",v)}/>
              <${Field} label=${t("agency.budgetMax")} value=${needsDraft.budgetMax} type="number" onInput=${v=>update(setNeedsDraft,"budgetMax",v)}/>
              <label class="agency-qualification-checkbox"><input type="checkbox" checked=${needsDraft.clientConfirmed} onChange=${e=>update(setNeedsDraft,"clientConfirmed",e.currentTarget.checked)}/><span>${t("agency.clientConfirmed")}</span></label>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.saveNeeds")}</button></div>
            </form>
          </section>
          <section class="agency-commercial-section">
            <h3>${t("agency.quotesTitle")}</h3>
            <form class="agency-form agency-form-grid" onSubmit=${createQuote}>
              <div class="agency-form-head"><strong>${t("agency.newQuote")}</strong></div>
              <${Field} label=${t("agency.quoteTitle")} value=${quoteDraft.title} required onInput=${v=>update(setQuoteDraft,"title",v)}/>
              <label class="agency-field"><span>${t("agency.quoteTier")}</span><select class="field" value=${quoteDraft.tier} onChange=${e=>update(setQuoteDraft,"tier",e.currentTarget.value)}><option value="essential">essential</option><option value="standard">standard</option><option value="advanced">advanced</option><option value="custom">custom</option></select></label>
              <${Field} label=${t("agency.lineLabel")} value=${quoteDraft.lineLabel} required onInput=${v=>update(setQuoteDraft,"lineLabel",v)}/>
              <${Field} label=${t("agency.linePrice")} value=${quoteDraft.linePrice} type="number" required onInput=${v=>update(setQuoteDraft,"linePrice",v)}/>
              <${Field} label=${t("agency.lineCost")} value=${quoteDraft.lineCost} type="number" required onInput=${v=>update(setQuoteDraft,"lineCost",v)}/>
              <${Field} label=${t("agency.lineDays")} value=${quoteDraft.lineDays} type="number" required onInput=${v=>update(setQuoteDraft,"lineDays",v)}/>
              <${Field} label=${t("agency.discountPct")} value=${quoteDraft.discountPct} type="number" onInput=${v=>update(setQuoteDraft,"discountPct",v)}/>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.createQuote")}</button></div>
            </form>
            <div class="agency-commercial-list">
              ${!quotes.filter(q=>q.leadId===selectedLeadId).length&&html`<p class="agency-muted">${t("agency.noQuotes")}</p>`}
              ${quotes.filter(q=>q.leadId===selectedLeadId).map(q=>{
                const ap=approvals.find(a=>a.id===q.approvalId);
                return html`<article class="agency-commercial-card">
                  <div class="agency-commercial-head"><strong>v${q.version} · ${q.title}</strong><span class="agency-whatsapp-state">${t(`agency.quoteStatus.${q.status}`)}</span></div>
                  <small>${q.netTotal} ${q.currency} · ${t("agency.marginLabel",{pct:q.marginPct})} · ${q.deliveryDays}d</small>
                  <div class="agency-commercial-actions">
                    <input class="field" type="number" value=${negDiscount} onInput=${e=>setNegDiscount(e.currentTarget.value)} aria-label=${t("agency.negotiateDiscount")}/>
                    <button class="btn" type="button" onClick=${()=>evaluateQuoteNeg(q.id)}>${t("agency.evaluateNegotiation")}</button>
                    ${q.status==="draft"&&html`<button class="btn" type="button" onClick=${()=>quoteAction(q.id,"request-approval",{reason:"Review quote before sending"})}>${t("agency.requestQuoteApproval")}</button>`}
                    ${q.status==="pending_approval"&&ap?.status==="pending"&&html`<button class="btn primary" type="button" onClick=${()=>approveRecord(ap.id)}>${t("agency.approveAndSend")}</button>`}
                    ${q.status==="pending_approval"&&ap?.status==="approved"&&html`<button class="btn primary" type="button" onClick=${()=>quoteAction(q.id,"send")}>${t("agency.sendQuoteBtn")}</button>`}
                    ${q.status==="sent"&&html`<button class="btn primary" type="button" onClick=${()=>quoteAction(q.id,"decision",{decision:"accepted"})}>${t("agency.acceptQuoteBtn")}</button><button class="text" type="button" onClick=${()=>quoteAction(q.id,"decision",{decision:"rejected"})}>${t("agency.rejectQuoteBtn")}</button>`}
                    ${q.status==="accepted"&&html`<button class="btn primary" type="button" onClick=${()=>createContract(q.id)}>${t("agency.createContractBtn")}</button>`}
                  </div>
                  ${negEval&&negEval.quoteId===q.id&&html`<small>${negEval.allowedAutonomously?t("agency.negotiationAllowed",{margin:negEval.resultingMarginPct,floor:negEval.priceFloor}):t("agency.negotiationNeedsApproval",{violations:negEval.violations.join(", ")})}</small>`}
                </article>`;
              })}
            </div>
          </section>
          <section class="agency-commercial-section">
            <h3>${t("agency.contractsTitle")}</h3>
            <div class="agency-commercial-list">
              ${!contracts.filter(c=>c.leadId===selectedLeadId).length&&html`<p class="agency-muted">${t("agency.noContracts")}</p>`}
              ${contracts.filter(c=>c.leadId===selectedLeadId).map(c=>{
                const ap=approvals.find(a=>a.id===c.approvalId);
                return html`<article class="agency-commercial-card">
                  <div class="agency-commercial-head"><strong>${c.title}</strong><span class="agency-whatsapp-state">${t(`agency.contractStatus.${c.status}`)}</span></div>
                  <small>${c.totalAmount} ${c.currency} · ${c.depositStatus==="paid"?t("agency.depositPaidLabel"):t("agency.depositUnpaidLabel")} (${c.depositAmount})</small>
                  <div class="agency-commercial-actions">
                    ${c.status==="draft"&&html`<button class="btn" type="button" onClick=${()=>contractAction(c.id,"request-approval",{reason:"Review contract before signature"})}>${t("agency.requestContractApproval")}</button>`}
                    ${c.status==="pending_approval"&&ap?.status==="pending"&&html`<button class="btn primary" type="button" onClick=${()=>approveRecord(ap.id)}>${t("agency.approveAndSend")}</button>`}
                    ${c.status==="pending_approval"&&ap?.status==="approved"&&html`<button class="btn primary" type="button" onClick=${()=>contractAction(c.id,"sign")}>${t("agency.signContractBtn")}</button>`}
                    ${c.status==="signed"&&c.depositStatus==="unpaid"&&html`<input class="field" placeholder=${t("agency.depositRef")} value=${depositRefByContract[c.id]||""} onInput=${e=>setDepositRefByContract(p=>({...p,[c.id]:e.currentTarget.value}))}/><button class="btn primary" type="button" disabled=${!(depositRefByContract[c.id]||"").trim()} onClick=${()=>contractAction(c.id,"deposit",{status:"paid",reference:depositRefByContract[c.id]})}>${t("agency.recordDepositBtn")}</button>`}
                  </div>
                </article>`;
              })}
            </div>
          </section>
        </div>`}
      </div>`}
    `}
  </section>`;

}
