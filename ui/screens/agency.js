import { useEffect, useState } from "preact/hooks";
import { html, Icon, Spinner, Badge } from "../components/ui.js";
import { Markdown } from "../components/markdown.js";
import { api } from "../lib/api.js";
import { fmtNum, t, useLang } from "../lib/i18n.js";
import { AgencyCopilot } from "./agency/copilot.js";
import { AgencyAgents } from "./agency/agents.js";
import { ProjectStudio } from "./agency/studio.js";

const SIZE=25;
const NEXT={new:["researching","archived"],researching:["new","qualified","lost","archived"],qualified:["researching","contact_pending","lost","archived"],contact_pending:["qualified","contacted","lost"],contacted:["qualified","engaged","lost"],engaged:["contacted","opportunity","lost"],opportunity:["engaged","proposal","lost"],proposal:["opportunity","won","lost"],won:["archived"],lost:["qualified","archived"],archived:[]};
const PROJECT_NEXT={handoff_pending:["scoping","archived"],scoping:["in_progress","archived"],in_progress:["qa_review","archived"],qa_review:["in_progress","ready_for_delivery","archived"],ready_for_delivery:["qa_review","delivered","archived"],delivered:["accepted","maintenance","qa_review","archived"],accepted:["maintenance","archived"],maintenance:["in_progress","archived"],archived:[]};
const blankCompany={name:"",website:"",industry:"",countryCode:"SN",city:""};
const blankLead={companyId:"",source:"",notes:""};
const blankContact={displayName:"",role:"",email:"",phone:""};
const blankEvidence={evidenceType:"company",sourceUrl:"",summary:"",confidence:"0.7"};
const blankQualificationDraft={targetIndustries:"",targetCountries:"",excludedIndustries:"",requiredEvidenceDomains:"",requireWebsite:false};
const blankCatalogDraft={code:"",name:"",category:"web_app",description:"",estimatedDays:"10",priceMin:"1500",priceBase:"2500",priceMax:"4000",estimatedCost:"1200"};
const blankRulesDraft={minMarginPct:"30",maxAutonomousDiscountPct:"10",defaultDepositPct:"30",requireOwnerApprovalAboveAmount:"0",paymentTermsDefault:""};
const blankNeedsDraft={problemStatement:"",solutionType:"web_app",mustHaveFeatures:"",desiredTimeline:"",budgetMin:"0",budgetMax:"0",clientConfirmed:false};
const blankQuoteDraft={title:"",tier:"standard",lineLabel:"",linePrice:"2500",lineCost:"1200",lineDays:"10",discountPct:"0"};
const blankProjectDraft={contractId:"",title:"",workspacePath:"",targetStack:"typescript, web",technicalSpecs:"",estimatedDays:"14"};
const blankLotDraft={title:"",description:"",acceptanceCriteria:"",ownerRole:"developer",estimatedHours:"8"};
const blankScopeDraft={title:"",description:"",budgetDelta:"0",daysDelta:"0"};
const blankQaDraft={category:"functional",status:"passed",title:"",evidence:"",findings:""};
const blankDeliveryDraft={environmentUrl:"",releaseNotes:""};
const blankFollowUpDraft={type:"satisfaction",dueDays:"7",notes:""};
const blankMissionDraft={projectId:"",agentRole:"developer",title:"",objective:"",preferredTool:"claude"};
const AGENT_ROLES=["prospecting","qualification","commercial","estimator","project_manager","architect","developer","ui_ux","qa_functional","qa_technical","qa_ui_ux","qa_security","retention"];
const QA_CATEGORIES=["functional","technical","ui_ux","security"];
const QA_STATUSES=["pending","passed","failed","blocked"];
const FOLLOWUP_TYPES=["satisfaction","maintenance","upsell","support","case_study"];
const SOLUTION_TYPES=["vitrine","ecommerce","web_app","mobile_app","business_platform","internal_tool","automation","maintenance"];
const CHANNELS=["whatsapp","email","web_form","social","phone","other"];
const CLI_ACTIONS=[["npm_test","npm test"],["npm_typecheck","typecheck"],["npm_build","build"],["git_status","git status"],["claude_brief","Claude CLI"],["codex_brief","Codex CLI"]];
const LEAD_FILTERS=["all","new","qualified","proposal","won","lost"];
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
function Metric({label,value,icon,tone=""}) {
  return html`<article class="agency-metric">
    <div class="agency-metric-top"><span class="agency-metric-label">${label}</span><span class=${"agency-metric-icon"+(tone?" tone-"+tone:"")}><${Icon} name=${icon} size="sm"/></span></div>
    <strong class="agency-metric-value num">${typeof value==="string"?value:fmtNum(value||0)}</strong>
  </article>`;
}
function Empty({title,detail}) {
  return html`<div class="agency-empty"><${Icon} name="inbox" size="xl" /><strong>${title}</strong><span>${detail}</span></div>`;
}

export function AgencyScreen({ initialTab = "operations", onTabChange } = {}) {
  const lang=useLang();
  const [orgs,setOrgs]=useState([]);
  const [orgId,setOrgId]=useState(storedOrg);
  const [orgName,setOrgName]=useState("");
  const [orgFormOpen,setOrgFormOpen]=useState(false);
  const [orgLoading,setOrgLoading]=useState(true);
  const [orgError,setOrgError]=useState("");
  const [dashboard,setDashboard]=useState(null);
  const [tab,setTab]=useState(initialTab || "operations");
  useEffect(()=>{if(initialTab && initialTab !== tab){setTab(initialTab);setPage(0);}},[initialTab]);
  const switchTab=(next)=>{setTab(next);setPage(0);onTabChange?.(next);};
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
  const [suggestNotice,setSuggestNotice]=useState("");
  const [needsDraft,setNeedsDraft]=useState(blankNeedsDraft);
  const [needsNotice,setNeedsNotice]=useState("");
  const [quotes,setQuotes]=useState([]);
  const [quoteDraft,setQuoteDraft]=useState(blankQuoteDraft);
  const [negDiscount,setNegDiscount]=useState("10");
  const [negEval,setNegEval]=useState(null);
  const [contracts,setContracts]=useState([]);
  const [depositRefByContract,setDepositRefByContract]=useState({});
  const [approvals,setApprovals]=useState([]);
  const [projects,setProjects]=useState([]);
  const [selectedProjectId,setSelectedProjectId]=useState("");
  const [workspaceNotice,setWorkspaceNotice]=useState("");
  const [projectDraft,setProjectDraft]=useState(blankProjectDraft);
  const [projectLots,setProjectLots]=useState([]);
  const [lotDraft,setLotDraft]=useState(blankLotDraft);
  const [lotEvidenceById,setLotEvidenceById]=useState({});
  const [briefModal,setBriefModal]=useState("");
  const [scopeChanges,setScopeChanges]=useState([]);
  const [scopeDraft,setScopeDraft]=useState(blankScopeDraft);
  const [qaChecks,setQaChecks]=useState([]);
  const [qaDraft,setQaDraft]=useState(blankQaDraft);
  const [qaGate,setQaGate]=useState(null);
  const [deliveries,setDeliveries]=useState([]);
  const [deliveryDraft,setDeliveryDraft]=useState(blankDeliveryDraft);
  const [feedbackByDelivery,setFeedbackByDelivery]=useState({});
  const [followUps,setFollowUps]=useState([]);
  const [followUpDraft,setFollowUpDraft]=useState(blankFollowUpDraft);
  const [agentProfiles,setAgentProfiles]=useState([]);
  const [devTools,setDevTools]=useState([]);
  const [missions,setMissions]=useState([]);
  const [missionDraft,setMissionDraft]=useState(blankMissionDraft);
  const [metrics,setMetrics]=useState(null);
  const [leadStageFilter,setLeadStageFilter]=useState("all");
  const [commercialSubTab,setCommercialSubTab]=useState("conversations");
  const [projectSubTab,setProjectSubTab]=useState("lots");
  const [cliActionByMission,setCliActionByMission]=useState({});
  const [quoteLines,setQuoteLines]=useState([{label:"",unitPrice:"2500",unitCost:"1200",estimatedDays:"10"}]);
  const [prospectQuery,setProspectQuery]=useState("");
  const [prospectIndustry,setProspectIndustry]=useState("");
  const [prospectCity,setProspectCity]=useState("");
  const [prospectResults,setProspectResults]=useState([]);
  const [auditResultByCompany,setAuditResultByCompany]=useState({});
  const [leadViewMode,setLeadViewMode]=useState("list");
  const [auditEvents,setAuditEvents]=useState([]);
  const [auditVerify,setAuditVerify]=useState(null);
  const [execNodeStatus,setExecNodeStatus]=useState(null);
  const [emailStatus,setEmailStatus]=useState(null);
  const [prospectOpen,setProspectOpen]=useState(false);
  const [missionFormOpen,setMissionFormOpen]=useState(false);
  const [catalogFormOpen,setCatalogFormOpen]=useState(false);
  const [convFormOpen,setConvFormOpen]=useState(false);
  const [quoteFormOpen,setQuoteFormOpen]=useState(false);
  const [projectFormOpen,setProjectFormOpen]=useState(false);
  const [lotFormOpen,setLotFormOpen]=useState(false);
  const [scopeFormOpen,setScopeFormOpen]=useState(false);
  const [qaFormOpen,setQaFormOpen]=useState(false);
  const [deliveryFormOpen,setDeliveryFormOpen]=useState(false);
  const [followUpFormOpen,setFollowUpFormOpen]=useState(false);

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
    if(tab==="copilot"){setBusy("");return ()=>{live=false;};}
    if(tab==="agents"){
      api(`/agency/${enc(orgId)}/agents`)
        .then(d=>{if(live)setAgentProfiles(d.items||[]);})
        .catch(e=>live&&setError(e.message))
        .finally(()=>live&&setBusy(""));
      return ()=>{live=false;};
    }
    if(tab==="projects"||tab==="operations"){
      Promise.all([
        api(`/agency/${enc(orgId)}/dashboard`),
        api(`/agency/${enc(orgId)}/contracts`),
        api(`/agency/${enc(orgId)}/projects`),
        api(`/agency/${enc(orgId)}/approvals?limit=100`),
        api(`/agency/${enc(orgId)}/followups`),
        api(`/agency/${enc(orgId)}/missions`),
        api(`/agency/${enc(orgId)}/agents`),
        api(`/agency/${enc(orgId)}/dev-tools`),
        api(`/agency/${enc(orgId)}/metrics`),
        api(`/agency/${enc(orgId)}/audit?limit=40`),
        api(`/agency/${enc(orgId)}/execution-node`)
      ]).then(([stats,contractData,projectData,appData,fuData,missionData,agentData,toolData,metricData,auditData,nodeData])=>{
        if(!live)return;
        setDashboard(stats);
        const contractList=contractData.items||[];
        setContracts(contractList);
        const signedPaid=contractList.find(c=>c.status==="signed"&&(c.depositAmount===0||c.depositStatus==="paid"));
        setProjectDraft(cur=>cur.contractId?cur:({...cur,contractId:signedPaid?.id||""}));
        const projList=projectData.items||[];
        setProjects(projList);
        setSelectedProjectId(cur=>projList.some(p=>p.id===cur)?cur:(projList[0]?.id||""));
        setApprovals(appData.items||[]);
        setFollowUps(fuData.items||[]);
        setMissions(missionData.items||[]);
        setAgentProfiles(agentData.items||[]);
        setDevTools(toolData.items||[]);
        setMetrics(metricData.metrics||null);
        setAuditEvents(auditData.items||[]);
        setExecNodeStatus(nodeData.status||null);
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
      api(`/agency/${enc(orgId)}/approvals?limit=100`),
      api(`/agency/${enc(orgId)}/email/status`)
    ]).then(([stats,catData,ruleData,leadData,quoteData,contractData,convData,appData,emailData])=>{
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
      setEmailStatus(emailData||null);
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
      setOrgs(list=>[...list,d.organization]);changeOrg(d.organization.id);setOrgName("");setOrgFormOpen(false);
    }catch(err){setOrgError(err.message);}finally{setBusy("");}
  };
  const createCompany=async(e)=>{
    e.preventDefault();setBusy("create");setError("");
    try{await api(`/agency/${enc(orgId)}/companies`,{method:"POST",body:company});setCompany(blankCompany);setCompanyForm(false);setPage(0);setRevision(v=>v+1);}
    catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createLead=async(e)=>{
    e.preventDefault();setBusy("create");setError("");
    try{await api(`/agency/${enc(orgId)}/leads`,{method:"POST",body:lead});setLead(blankLead);setLeadForm(false);switchTab("leads");setRevision(v=>v+1);}
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
      setCatalogDraft(blankCatalogDraft);setCatalogFormOpen(false);setRevision(v=>v+1);
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
      setConvDraft({channel:"email",subject:""});setConvFormOpen(false);setSelectedConvId(d.conversation.id);setRevision(v=>v+1);
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
  const normalizedQuoteLines=()=>quoteLines.map(ln=>({
    label:(ln.label||quoteDraft.title||"Prestation").trim(),
    quantity:1,
    unitPrice:Number(ln.unitPrice||0),
    unitCost:Number(ln.unitCost||0),
    estimatedDays:Number(ln.estimatedDays||1)
  })).filter(ln=>ln.label);
  const createQuote=async(e)=>{
    e.preventDefault();if(!selectedLeadId)return;
    setBusy("quote");setError("");
    try{
      const lines=normalizedQuoteLines();
      await api(`/agency/${enc(orgId)}/quotes`,{method:"POST",body:{
        leadId:selectedLeadId,title:quoteDraft.title,tier:quoteDraft.tier,
        discountPct:Number(quoteDraft.discountPct||0),
        lines:lines.length?lines:[{
          label:quoteDraft.lineLabel||quoteDraft.title,quantity:1,
          unitPrice:Number(quoteDraft.linePrice),unitCost:Number(quoteDraft.lineCost),
          estimatedDays:Number(quoteDraft.lineDays)
        }]
      }});
      setQuoteDraft(blankQuoteDraft);
      setQuoteLines([{label:"",unitPrice:"2500",unitCost:"1200",estimatedDays:"10"}]);
      setQuoteFormOpen(false);
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const reviseQuote=async(quoteId)=>{
    setBusy("quote-rev");setError("");
    try{
      const lines=normalizedQuoteLines();
      await api(`/agency/${enc(orgId)}/quotes/${enc(quoteId)}/revise`,{method:"POST",body:{
        title:quoteDraft.title||undefined,tier:quoteDraft.tier,
        discountPct:Number(quoteDraft.discountPct||0),
        ...(lines.length&&quoteLines.some(l=>l.label.trim())?{lines}:{})
      }});
      setRevision(v=>v+1);
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
  const decideApproval=async(approvalId,decision)=>{
    const ap=approvals.find(a=>a.id===approvalId);
    if(!ap)return;
    setBusy("approve");setError("");
    try{
      await api(`/agency/${enc(orgId)}/approvals/${enc(ap.id)}/decision`,{
        method:"POST",body:{decision,expectedPayloadHash:ap.payloadHash,reason:`${decision} in Agency CRM`}
      });
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const approveRecord=(approvalId)=>decideApproval(approvalId,"approved");
  const searchProspects=async(e)=>{
    e.preventDefault();if(!prospectQuery.trim())return;
    setBusy("prospect-search");setError("");
    try{
      const data=await api(`/agency/${enc(orgId)}/prospecting/search`,{
        method:"POST",body:{query:prospectQuery,industry:prospectIndustry,city:prospectCity,maxResults:8}
      });
      setProspectResults(data.items||[]);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const importProspect=async(item)=>{
    setBusy("prospect-imp");setError("");
    try{
      await api(`/agency/${enc(orgId)}/companies`,{
        method:"POST",body:{name:item.name,website:item.website,industry:prospectIndustry,city:prospectCity}
      });
      setProspectResults(prev=>prev.filter(x=>x.website!==item.website));
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const auditCompanySite=async(companyId)=>{
    setBusy("site-audit");setError("");
    try{
      const data=await api(`/agency/${enc(orgId)}/companies/${enc(companyId)}/website-audit`,{method:"POST",body:{}});
      setAuditResultByCompany(prev=>({...prev,[companyId]:data.evidenceSummary||"Audit terminé"}));
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const archiveCompany=async(companyId)=>{
    setBusy("archive-co");setError("");
    try{
      await api(`/agency/${enc(orgId)}/companies/${enc(companyId)}`,{method:"PATCH",body:{status:"archived"}});
      setSelected("");setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const extractNeeds=async()=>{
    if(!selectedConvId)return;
    setBusy("extract");setError("");setNeedsNotice("");
    try{
      const data=await api(`/agency/${enc(orgId)}/conversations/${enc(selectedConvId)}/extract-needs`,{method:"POST",body:{}});
      const ex=data.extracted||{};
      setNeedsDraft(cur=>({
        ...cur,
        problemStatement:ex.problemStatement||cur.problemStatement,
        solutionType:SOLUTION_TYPES.includes(ex.solutionType)?ex.solutionType:cur.solutionType,
        mustHaveFeatures:Array.isArray(ex.mustHaveFeatures)?ex.mustHaveFeatures.join(", "):cur.mustHaveFeatures,
        desiredTimeline:ex.desiredTimeline||cur.desiredTimeline,
        budgetMin:ex.budgetMin!=null?String(ex.budgetMin):cur.budgetMin,
        budgetMax:ex.budgetMax!=null?String(ex.budgetMax):cur.budgetMax
      }));
      setNeedsNotice(`(${data.mode||"ai"}) ✓`);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const estimateQuote=async()=>{
    if(!selectedLeadId)return;
    setBusy("estimate");setError("");
    try{
      const data=await api(`/agency/${enc(orgId)}/quotes/estimate`,{method:"POST",body:{leadId:selectedLeadId}});
      setQuoteDraft(cur=>({...cur,title:data.title||cur.title,tier:data.tier||cur.tier}));
      if(Array.isArray(data.lines)&&data.lines.length){
        setQuoteLines(data.lines.map(l=>({
          label:l.label||"",unitPrice:String(l.unitPrice??0),unitCost:String(l.unitCost??0),estimatedDays:String(l.estimatedDays??1)
        })));
      }
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const autoPlanLots=async(projectId)=>{
    setBusy("auto-lots");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(projectId)}/auto-plan`,{method:"POST",body:{apply:true}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const runFourAxisQa=async(projectId)=>{
    setBusy("qa-4axis");setError("");setWorkspaceNotice("");
    try{
      const data=await api(`/agency/${enc(orgId)}/projects/${enc(projectId)}/qa-audit`,{method:"POST",body:{}});
      setWorkspaceNotice(data.summary||"QA 4 axes ✓");
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const convertFollowUp=async(followUpId)=>{
    setBusy("convert-fu");setError("");
    try{
      await api(`/agency/${enc(orgId)}/followups/${enc(followUpId)}/convert-opportunity`,{method:"POST",body:{}});
      setRevision(v=>v+1);switchTab("leads");
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const verifyAuditChain=async()=>{
    setBusy("verify-audit");setError("");
    try{
      const data=await api(`/agency/${enc(orgId)}/audit/verify`);
      setAuditVerify(data.verification||null);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createContract=async(quoteId)=>{
    setBusy("contract");setError("");
    try{
      await api(`/agency/${enc(orgId)}/contracts`,{method:"POST",body:{quoteId}});
      setCommercialSubTab("contracts");
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
  useEffect(()=>{
    if(!orgId||tab!=="projects"||!selectedProjectId){
      setProjectLots([]);setScopeChanges([]);setQaChecks([]);setQaGate(null);setDeliveries([]);return;
    }
    let live=true;
    Promise.all([
      api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/lots`),
      api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/scope-changes`),
      api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/qa-checks`),
      api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/qa-gate`),
      api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/deliveries`)
    ]).then(([lotsData,scData,qaData,gateData,delData])=>{
      if(!live)return;
      setProjectLots(lotsData.items||[]);
      setScopeChanges(scData.items||[]);
      setQaChecks(qaData.items||[]);
      setQaGate(gateData.gate||null);
      setDeliveries(delData.items||[]);
    }).catch(()=>{});
    return ()=>{live=false;};
  },[orgId,tab,selectedProjectId,revision]);
  const createProjectHandoff=async(e)=>{
    e.preventDefault();if(!projectDraft.contractId)return;
    setBusy("proj-handoff");setError("");
    try{
      const d=await api(`/agency/${enc(orgId)}/projects`,{method:"POST",body:{
        contractId:projectDraft.contractId,
        title:projectDraft.title||undefined,
        workspacePath:projectDraft.workspacePath||undefined,
        targetStack:splitValues(projectDraft.targetStack),
        technicalSpecs:projectDraft.technicalSpecs||undefined,
        estimatedDays:Number(projectDraft.estimatedDays||14)
      }});
      setProjectDraft(blankProjectDraft);
      setProjectFormOpen(false);
      setSelectedProjectId(d.project.id);
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const updateProjectStatus=async(projectId,status)=>{
    if(!projectId||!status)return;
    setBusy("proj-status");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(projectId)}/status`,{method:"PATCH",body:{status}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createProjectLot=async(e)=>{
    e.preventDefault();if(!selectedProjectId)return;
    setBusy("lot-create");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/lots`,{method:"POST",body:{
        title:lotDraft.title,
        description:lotDraft.description,
        acceptanceCriteria:splitValues(lotDraft.acceptanceCriteria),
        ownerRole:lotDraft.ownerRole,
        estimatedHours:Number(lotDraft.estimatedHours||8)
      }});
      setLotDraft(blankLotDraft);setLotFormOpen(false);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const updateLotStatus=async(lotId,status)=>{
    if(!selectedProjectId)return;
    setBusy("lot-upd");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/lots/${enc(lotId)}`,{method:"PATCH",body:{
        status,
        evidenceSummary:lotEvidenceById[lotId]||undefined
      }});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const generateBrief=async(lotId)=>{
    if(!selectedProjectId)return;
    setBusy("brief");setError("");
    try{
      const d=await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/lots/${enc(lotId)}/execution-brief`,{method:"POST",body:{}});
      setBriefModal(d.brief||"");
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const proposeScopeChange=async(e)=>{
    e.preventDefault();if(!selectedProjectId)return;
    setBusy("scope");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/scope-changes`,{method:"POST",body:{
        title:scopeDraft.title,
        description:scopeDraft.description,
        budgetDelta:Number(scopeDraft.budgetDelta||0),
        daysDelta:Number(scopeDraft.daysDelta||0)
      }});
      setScopeDraft(blankScopeDraft);setScopeFormOpen(false);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const scopeChangeAction=async(scId,action,body={})=>{
    if(!selectedProjectId)return;
    setBusy("scope-act");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/scope-changes/${enc(scId)}/${action}`,{method:"POST",body});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const recordQaCheck=async(e)=>{
    e.preventDefault();if(!selectedProjectId)return;
    setBusy("qa");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/qa-checks`,{method:"POST",body:{
        category:qaDraft.category,
        status:qaDraft.status,
        title:qaDraft.title,
        evidence:qaDraft.evidence,
        findings:qaDraft.findings
      }});
      setQaDraft(blankQaDraft);setQaFormOpen(false);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const prepareDelivery=async(e)=>{
    e.preventDefault();if(!selectedProjectId)return;
    setBusy("delivery");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/deliveries`,{method:"POST",body:{
        environmentUrl:deliveryDraft.environmentUrl,
        releaseNotes:deliveryDraft.releaseNotes
      }});
      setDeliveryDraft(blankDeliveryDraft);setDeliveryFormOpen(false);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const deliveryAction=async(deliveryId,action,body={})=>{
    if(!selectedProjectId)return;
    setBusy("delivery-act");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/deliveries/${enc(deliveryId)}/${action}`,{method:"POST",body});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const scheduleFollowUp=async(e)=>{
    e.preventDefault();if(!selectedProjectId)return;
    setBusy("followup");setError("");
    try{
      const dueAt=Date.now()+Math.max(1,Number(followUpDraft.dueDays||7))*86400000;
      await api(`/agency/${enc(orgId)}/projects/${enc(selectedProjectId)}/followups`,{method:"POST",body:{
        type:followUpDraft.type,
        dueAt,
        notes:followUpDraft.notes
      }});
      setFollowUpDraft(blankFollowUpDraft);setFollowUpFormOpen(false);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const completeFollowUp=async(followUpId)=>{
    setBusy("followup-upd");setError("");
    try{
      await api(`/agency/${enc(orgId)}/followups/${enc(followUpId)}`,{method:"PATCH",body:{status:"completed",outcome:"Completed in CRM"}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const createMission=async(e)=>{
    e.preventDefault();setBusy("mission");setError("");
    try{
      await api(`/agency/${enc(orgId)}/missions`,{method:"POST",body:{
        projectId:missionDraft.projectId||undefined,
        agentRole:missionDraft.agentRole,
        title:missionDraft.title,
        objective:missionDraft.objective,
        preferredTool:missionDraft.preferredTool
      }});
      setMissionDraft(blankMissionDraft);setMissionFormOpen(false);setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const updateMission=async(missionId,status)=>{
    setBusy("mission-upd");setError("");
    try{
      await api(`/agency/${enc(orgId)}/missions/${enc(missionId)}/status`,{method:"PATCH",body:{status}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const suggestReply=async()=>{
    if(!selectedConvId)return;
    setBusy("suggest");setError("");setSuggestNotice("");
    try{
      const d=await api(`/agency/${enc(orgId)}/conversations/${enc(selectedConvId)}/suggest-reply`,{method:"POST",body:{}});
      setMsgBody(d.draft||"");
      if(d.guardrailsNote)setSuggestNotice(d.guardrailsNote);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const initWorkspace=async(projectId)=>{
    if(!projectId)return;
    setBusy("ws-init");setError("");setWorkspaceNotice("");
    try{
      const d=await api(`/agency/${enc(orgId)}/projects/${enc(projectId)}/workspace/init`,{method:"POST",body:{}});
      setWorkspaceNotice(t("agency.workspaceReady",{path:d.workspace?.relativePath||""}));
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const runAutoQa=async(projectId)=>{
    if(!projectId)return;
    setBusy("qa-run");setError("");
    try{
      await api(`/agency/${enc(orgId)}/projects/${enc(projectId)}/qa-run`,{method:"POST",body:{}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const executeMission=async(missionId,mode,cliAction)=>{
    setBusy("mission-exec");setError("");
    try{
      await api(`/agency/${enc(orgId)}/missions/${enc(missionId)}/execute`,{method:"POST",body:{mode,cliAction}});
      setRevision(v=>v+1);
    }catch(err){setError(err.message);}finally{setBusy("");}
  };
  const activeResearchJobs=researchJobs.filter(isActiveResearch);
  const launchUpdated=researchLaunch?.updatedAt?Date.parse(researchLaunch.updatedAt):Number.NaN;
  const researchLaunchActive=researchLaunch?.status==="running"&&(!Number.isFinite(launchUpdated)||Date.now()-launchUpdated<30*60_000);
  const stalledResearchJobs=researchJobs.filter(job=>ACTIVE_RESEARCH.has(job.status)&&!isActiveResearch(job));
  const failedResearchJobs=researchJobs.filter(job=>job.status==="failed"||job.status==="cancelled");
  const completedResearchJobs=researchJobs.filter(job=>job.status==="completed");
  const activeOrg=orgs.find(o=>o.id===orgId);
  const cur=activeOrg?.currency||"";
  const selectedCompany=(tab==="companies"?(rows.items||[]).find(x=>x.id===selected):null);
  const selectedProject=(tab==="projects"?projects.find(p=>p.id===selectedProjectId):null);
  const totalPages=Math.max(1,Math.ceil((rows.total||0)/SIZE));

  return html`<section class="agency-screen view" data-screen="agency">
    <header class="agency-header">
      <div class="agency-title-wrap">
        <h1 class="t-page">${t(`agency.${tab}`)}</h1>
        ${cur&&html`<span class="agency-org-pill">${cur}</span>`}
      </div>
      ${orgs.length>0&&html`<div class="agency-org-bar">
        <label class="agency-org-picker"><select class="field" aria-label=${t("agency.organization")} value=${orgId} onChange=${e=>changeOrg(e.currentTarget.value)}>${orgs.map(o=>html`<option value=${o.id}>${o.name}</option>`)}</select></label>
        <button class="btn" type="button" aria-expanded=${orgFormOpen} title=${t("agency.newOrganization")} onClick=${()=>setOrgFormOpen(v=>!v)}><${Icon} name=${orgFormOpen?"close":"plus"} size="sm"/></button>
      </div>`}
    </header>
    ${orgError&&html`<div class="agency-alert" role="alert">${orgError}</div>`}
    ${orgLoading&&html`<div class="agency-loading"><${Spinner}/>${t("agency.loading")}</div>`}
    ${orgs.length>0&&orgFormOpen&&html`<form class="agency-form agency-create-org" onSubmit=${createOrg}><${Field} label=${t("agency.organizationName")} value=${orgName} required onInput=${setOrgName}/>
      <button class="btn primary" type="submit" disabled=${!!busy||!orgName.trim()}>${busy==="org"?t("agency.creating"):t("agency.createOrganization")}</button></form>`}
    ${!orgLoading&&!orgs.length&&html`<div class="agency-first-org"><h2>${t("agency.firstTitle")}</h2><p>${t("agency.firstDescription")}</p>
      <form class="agency-form agency-create-org" onSubmit=${createOrg}><${Field} label=${t("agency.organizationName")} value=${orgName} required onInput=${setOrgName}/>
        <button class="btn primary" type="submit" disabled=${!!busy||!orgName.trim()}>${busy==="org"?t("agency.creating"):t("agency.createOrganization")}</button></form></div>`}

    ${orgId&&html`
      ${(tab==="companies"||tab==="leads")&&html`<div class="agency-metrics">
        <${Metric} label=${t("agency.companies")} value=${dashboard?.companyCount} icon="folder" tone="blue"/>
        <${Metric} label=${t("agency.contacts")} value=${dashboard?.contactCount} icon="user" tone="teal"/>
        <${Metric} label=${t("agency.leads")} value=${dashboard?.leadCount} icon="clipboardCheck" tone="purple"/>
        <${Metric} label=${t("agency.won")} value=${dashboard?.wonLeadCount} icon="check" tone="green"/>
      </div>`}
      ${tab==="commercial"&&html`<div class="agency-channels-bar">
        <div class="agency-whatsapp-status">
          <span class=${"agency-whatsapp-dot "+(whatsappConfig?.configured?"ready":"")}></span>
          <strong>${t("agency.whatsappTitle")}</strong>
          <span>${whatsappConfig?.configured?t("agency.whatsappConnected"):t("agency.whatsappNotConnected")}</span>
          ${whatsappConfig?.phoneNumberId&&html`<code>${whatsappConfig.phoneNumberId}</code>`}
          ${whatsappConfig?.webhookConfigured&&html`<span class="agency-whatsapp-webhook-ready">${t("agency.whatsappWebhookReady")}</span>`}
        </div>
        <div class="agency-channels-actions">
          <button class="btn" type="button" aria-expanded=${whatsappOpen} onClick=${()=>{setWhatsappOpen(v=>!v);setWhatsappError("");setWhatsappNotice("");}}>
            ${whatsappOpen?t("agency.cancel"):t("agency.whatsappConfigure")}
          </button>
          <button class="btn" type="button" aria-expanded=${whatsappWorkflowOpen} onClick=${()=>setWhatsappWorkflowOpen(v=>!v)}>
            ${whatsappWorkflowOpen?t("agency.cancel"):t("agency.whatsappWorkflowOpen")}
          </button>
        </div>
      </div>`}
      ${(tab==="companies"||tab==="commercial")&&whatsappOpen&&html`<section class="agency-whatsapp-card">
        <div class="agency-whatsapp-heading">
          <div><span class="agency-eyebrow">${t("agency.whatsappEyebrow")}</span><h2>${t("agency.whatsappTitle")}</h2><p>${t("agency.whatsappDescription")}</p></div>
        </div>
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
      </section>`}
      ${(tab==="companies"||tab==="commercial")&&whatsappWorkflowOpen&&html`<section class="agency-whatsapp-workflow">
        <div class="agency-whatsapp-heading">
          <div><span class="agency-eyebrow">${t("agency.whatsappWorkflowEyebrow")}</span><h2>${t("agency.whatsappWorkflowTitle")}</h2><p>${t("agency.whatsappWorkflowHint")}</p></div>
          <div class="agency-whatsapp-workflow-actions">
            <button class="btn" type="button" disabled=${whatsappWorkflowBusy} onClick=${refreshWhatsAppWorkflow}>${whatsappWorkflowBusy?t("agency.loading"):t("agency.whatsappRefresh")}</button>
          </div>
        </div>
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
      </section>`}
      <div class="agency-toolbar">
        <div class="agency-tabs" role="tablist">
          <button role="tab" aria-selected=${tab==="operations"} class=${tab==="operations"?"active":""} onClick=${()=>switchTab("operations")}>${t("agency.operations")}</button>
          <button role="tab" aria-selected=${tab==="companies"} class=${tab==="companies"?"active":""} onClick=${()=>switchTab("companies")}>${t("agency.companies")}</button>
          <button role="tab" aria-selected=${tab==="leads"} class=${tab==="leads"?"active":""} onClick=${()=>switchTab("leads")}>${t("agency.leads")}</button>
          <button role="tab" aria-selected=${tab==="commercial"} class=${tab==="commercial"?"active":""} onClick=${()=>switchTab("commercial")}>${t("agency.commercial")}</button>
          <button role="tab" aria-selected=${tab==="catalog"} class=${tab==="catalog"?"active":""} onClick=${()=>switchTab("catalog")}>${t("agency.catalog")}</button>
          <button role="tab" aria-selected=${tab==="projects"} class=${tab==="projects"?"active":""} onClick=${()=>switchTab("projects")}>${t("agency.projects")}</button>
          <button role="tab" aria-selected=${tab==="agents"} class=${tab==="agents"?"active":""} onClick=${()=>switchTab("agents")}>${t("agency.agents")}</button>
          <button role="tab" aria-selected=${tab==="copilot"} class=${tab==="copilot"?"active":""} onClick=${()=>switchTab("copilot")}>${t("agency.copilot")}</button>
        </div>
        ${(tab==="companies"||tab==="leads")&&html`<label class="agency-search"><${Icon} name="search" size="sm"/><input type="search" value=${query} placeholder=${t("agency.search")} onInput=${e=>{setQuery(e.currentTarget.value);setPage(0);}}/></label>`}
        ${tab==="companies"&&html`<div class="agency-toolbar-actions">
          <button class=${"btn"+(prospectOpen?" primary":"")} type="button" onClick=${()=>setProspectOpen(v=>!v)}><${Icon} name="globe" size="sm"/>${t("agency.prospectSearchTitle")}</button>
          <button class="btn" type="button" onClick=${()=>setQualificationForm(v=>!v)}>${t("agency.qualificationProfile")}</button>
          <button class="btn primary" type="button" onClick=${()=>setCompanyForm(v=>!v)}><${Icon} name="plus" size="sm"/>${t("agency.newCompany")}</button>
        </div>`}
        ${tab==="leads"&&html`<div class="agency-toolbar-actions">
          <button class="btn primary" type="button" disabled=${!dashboard?.companyCount} onClick=${()=>setLeadForm(v=>!v)}><${Icon} name="plus" size="sm"/>${t("agency.newLead")}</button>
        </div>`}
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
      ${tab==="companies"&&prospectOpen&&html`<section class="agency-project-section">
        <form class="agency-form agency-form-grid" onSubmit=${searchProspects}>
          <div class="agency-form-head"><strong>${t("agency.prospectSearchTitle")}</strong><button type="button" class="text" onClick=${()=>setProspectOpen(false)}>${t("agency.cancel")}</button></div>
          <${Field} label=${t("agency.prospectQuery")} value=${prospectQuery} placeholder="BTP, e-commerce, clinique…" onInput=${setProspectQuery}/>
          <${Field} label=${t("agency.prospectSector")} value=${prospectIndustry} onInput=${setProspectIndustry}/>
          <${Field} label=${t("agency.prospectCity")} value=${prospectCity} onInput=${setProspectCity}/>
          <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy||!prospectQuery.trim()}>${t("agency.prospectSearchBtn")}</button></div>
        </form>
        ${prospectResults.length>0&&html`<div class="agency-commercial-list">
          ${prospectResults.map(item=>html`<article class="agency-commercial-card">
            <div class="agency-commercial-head"><strong>${item.name}</strong><small>${item.domain}</small></div>
            <small>${item.snippet||item.website}</small>
            <div class="agency-commercial-actions">
              <button class="btn primary" type="button" disabled=${!!busy||!!item.duplicateCompanyId} onClick=${()=>importProspect(item)}>${item.duplicateCompanyId?"✓":t("agency.prospectImportBtn")}</button>
            </div>
          </article>`)}
        </div>`}
      </section>`}
      ${!busy&&tab==="companies"&&!rows.items?.length&&html`<${Empty} title=${t("agency.noCompanies")} detail=${query?t("agency.noSearchResults"):t("agency.noCompaniesHint")}/>`}
      ${tab==="companies"&&rows.items?.length>0&&html`<div class="agency-content-grid">
        <div class="agency-table-wrap"><table class="agency-table"><thead><tr><th>${t("agency.company")}</th><th>${t("agency.industry")}</th><th>${t("agency.city")}</th></tr></thead>
          <tbody>${rows.items.map(c=>html`<tr class=${selected===c.id?"selected":""}><td><button class="agency-company-link" onClick=${()=>{setSelected(v=>v===c.id?"":c.id);setConsentContactId("");}}>
            <span class="agency-avatar">${(c.name||"?").slice(0,1).toUpperCase()}</span>
            <span class="agency-company-meta"><strong>${c.name}</strong><small>${c.website||c.countryCode||"—"}</small></span>
          </button></td><td>${c.industry||"—"}</td><td>${c.city||"—"}</td></tr>`)}</tbody>
        </table></div>
        ${selectedCompany&&html`<aside class="agency-detail"><div class="agency-detail-head"><div class="agency-detail-identity">
          <span class="agency-avatar">${(selectedCompany.name||"?").slice(0,1).toUpperCase()}</span>
          <div><span class="agency-eyebrow">${t("agency.companyDetails")}</span><h2>${selectedCompany.name}</h2></div>
        </div><button class="icon-btn" aria-label=${t("agency.close")} onClick=${()=>{setSelected("");setConsentContactId("");}}><${Icon} name="close"/></button></div>
          <dl class="agency-facts-grid"><div><dt>${t("agency.website")}</dt><dd>${selectedCompany.website||"—"}</dd></div><div><dt>${t("agency.industry")}</dt><dd>${selectedCompany.industry||"—"}</dd></div><div><dt>${t("agency.city")}</dt><dd>${selectedCompany.city||"—"}</dd></div></dl>
          <div class="agency-commercial-actions">
            <button class="btn primary" type="button" onClick=${()=>{setLead({companyId:selectedCompany.id,source:"crm",notes:""});setLeadForm(true);switchTab("leads");}}><${Icon} name="plus"/>${t("agency.createLeadFromCompany")}</button>
            ${selectedCompany.website&&html`<button class="btn" type="button" disabled=${!!busy} onClick=${()=>auditCompanySite(selectedCompany.id)}>${t("agency.websiteAuditBtn")}</button>`}
            <button class="text" type="button" disabled=${!!busy} onClick=${()=>archiveCompany(selectedCompany.id)}>${t("agency.archiveBtn")}</button>
          </div>
          ${auditResultByCompany[selectedCompany.id]&&html`<p class="agency-research-feedback" role="status">${auditResultByCompany[selectedCompany.id]}</p>`}
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
          </section>
          <section class="agency-research">
            ${(researchJobs.length>0||researchLaunch)&&html`<div class="agency-contact-heading"><h3>${t("agency.researchImportTitle")}</h3></div>`}
            ${activeResearchJobs.map(job=>html`<div class="agency-active-job"><div><strong>${t(`agency.jobStatus.${job.status}`)}</strong><span class="num">${job.progress}%</span></div><div class="agency-job-progress"><i style=${{width:Math.max(0,Math.min(100,job.progress))+"%"}}></i></div><small>${job.currentStep||job.id}</small></div>`)}
            ${stalledResearchJobs.map(job=>html`<div class="agency-research-stalled"><strong>${t("agency.researchStalled")}</strong><span>${job.company} · ${job.id}</span></div>`)}
            ${failedResearchJobs.map(job=>html`<div class="agency-research-failed"><strong>${t(`agency.jobStatus.${job.status}`)}</strong><span>${job.company} · ${job.id}</span></div>`)}
            ${completedResearchJobs.length>0&&html`<div class="agency-research-import"><label class="agency-field"><span>${t("agency.chooseResearchJob")}</span><select class="field" value=${researchJobId} onChange=${e=>setResearchJobId(e.currentTarget.value)}><option value="">—</option>${completedResearchJobs.map(job=>html`<option value=${job.id}>${job.company} · ${job.sourceCount} ${t("agency.sources")} · ${job.id}</option>`)}</select></label><button class="btn" disabled=${!researchJobId||!!busy} onClick=${importResearch}>${busy==="research-import"?t("agency.importingResearch"):t("agency.importResearch")}</button></div>`}
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
      ${tab==="leads"&&rows.items?.length>0&&html`<div class="agency-leads-bar">
        <div class="agency-stage-filters" role="group" aria-label=${t("agency.leads")}>
          ${LEAD_FILTERS.map(st=>{
            const count=st==="all"?rows.items.length:rows.items.filter(l=>l.stage===st).length;
            return html`<button type="button" class=${leadStageFilter===st?"active":""} onClick=${()=>setLeadStageFilter(st)}>
              <span>${st==="all"?t("agency.allStages"):t(`agency.stage.${st}`)}</span>
              <span class="agency-count-pill">${count}</span>
            </button>`;
          })}
        </div>
        <div class="agency-subtabs">
          <button type="button" class=${leadViewMode==="list"?"active":""} onClick=${()=>setLeadViewMode("list")}>${t("agency.viewList")}</button>
          <button type="button" class=${leadViewMode==="kanban"?"active":""} onClick=${()=>setLeadViewMode("kanban")}>${t("agency.viewKanban")}</button>
        </div>
      </div>`}
      ${tab==="leads"&&rows.items?.length>0&&leadViewMode==="list"&&html`<div class="agency-lead-list">${rows.items.filter(l=>leadStageFilter==="all"||l.stage===leadStageFilter).map(l=>html`<article class="agency-lead-card"><div class="agency-lead-main"><div><strong>${companyOptions.find(c=>c.id===l.companyId)?.name||l.companyId}</strong><p>${l.notes||l.source||t("agency.noLeadNotes")}</p></div><span class=${"agency-whatsapp-state "+l.stage}>${t(`agency.stage.${l.stage}`)}</span></div>
        <div class="agency-lead-footer"><span>${t("agency.updated")} · ${new Date(l.updatedAt).toLocaleDateString()}</span>
          <div class="agency-commercial-actions">
            <button class="btn" type="button" onClick=${()=>{setSelectedLeadId(l.id);setSelectedConvId("");switchTab("commercial");}}>${t("agency.openCommercial")}</button>
            <label class="agency-stage-select"><span>${t("agency.moveTo")}</span><select class="field" value=${l.stage} disabled=${busy==="stage"||!NEXT[l.stage]?.length} onChange=${e=>moveLead(l.id,e.currentTarget.value)}><option value=${l.stage}>${t(`agency.stage.${l.stage}`)}</option>${(NEXT[l.stage]||[]).map(s=>html`<option value=${s}>${t(`agency.stage.${s}`)}</option>`)}</select></label>
          </div>
        </div>
      </article>`)}</div>`}
      ${tab==="leads"&&rows.items?.length>0&&leadViewMode==="kanban"&&html`<div class="agency-kanban">
        ${["new","qualified","proposal","won","lost"].map(stage=>{
          const col=rows.items.filter(l=>l.stage===stage);
          return html`<div class="agency-kanban-col">
            <div class="agency-kanban-head"><strong>${t(`agency.stage.${stage}`)}</strong><span class="agency-count-pill">${col.length}</span></div>
            ${col.map(l=>html`<article class="agency-commercial-card">
              <strong>${companyOptions.find(c=>c.id===l.companyId)?.name||l.companyId}</strong>
              <small>${l.notes||l.source||"—"}</small>
              <div class="agency-commercial-actions">
                <button class="btn" type="button" onClick=${()=>{setSelectedLeadId(l.id);setSelectedConvId("");switchTab("commercial");}}>${t("agency.openCommercial")}</button>
                <select class="field" aria-label=${t("agency.moveTo")} value=${l.stage} disabled=${busy==="stage"||!NEXT[l.stage]?.length} onChange=${e=>moveLead(l.id,e.currentTarget.value)}><option value=${l.stage}>${t(`agency.stage.${l.stage}`)}</option>${(NEXT[l.stage]||[]).map(s=>html`<option value=${s}>${t(`agency.stage.${s}`)}</option>`)}</select>
              </div>
            </article>`)}
          </div>`;
        })}
      </div>`}
      ${tab==="leads"&&!busy&&!rows.items?.length&&html`<${Empty} title=${t("agency.noLeads")} detail=${query?t("agency.noSearchResults"):t("agency.noLeadsHint")}/>`}
      ${(tab==="companies"||tab==="leads")&&rows.total>SIZE&&html`<div class="agency-pagination"><button class="btn" disabled=${page===0} onClick=${()=>setPage(v=>Math.max(0,v-1))}>${t("agency.previous")}</button><span>${t("agency.page",{current:page+1,total:Math.ceil(rows.total/SIZE)})}</span><button class="btn" disabled=${(page+1)*SIZE>=rows.total} onClick=${()=>setPage(v=>v+1)}>${t("agency.next")}</button></div>`}
      ${tab==="catalog"&&html`<div class="agency-commercial-grid">
        <section class="agency-commercial-section">
          <div class="agency-commercial-head">
            <h2>${t("agency.catalogTitle")}</h2>
            <button class="btn primary" type="button" onClick=${()=>setCatalogFormOpen(v=>!v)}><${Icon} name=${catalogFormOpen?"close":"plus"} size="sm"/>${catalogFormOpen?t("agency.cancel"):t("agency.newCatalogItem")}</button>
          </div>
          ${catalogFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${createCatalogItem}>
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
          </form>`}
          <div class="agency-commercial-list">
            ${!catalogItems.length&&html`<p class="agency-muted">${t("agency.noCatalogItems")}</p>`}
            ${catalogItems.map(item=>html`<article class="agency-commercial-card">
              <div class="agency-commercial-head"><strong>${item.name} · ${item.code}</strong><span class="agency-whatsapp-state">${t(`agency.solutionType.${item.category}`)}</span></div>
              <p>${item.description}</p>
              <div class="agency-commercial-head">
                <strong class="agency-price-hero">${fmtNum(item.priceBase)} ${cur}</strong>
                <small>${fmtNum(item.priceMin)}–${fmtNum(item.priceMax)} ${cur} · ${item.estimatedDays}d</small>
              </div>
              <div class="agency-commercial-actions"><button class="btn" type="button" onClick=${()=>previewTiers(item.id)}>${t("agency.previewTiers")}</button></div>
            </article>`)}
            ${tierPreview.length>0&&html`<div class="agency-tier-grid">
              ${tierPreview.map(tier=>html`<article class="agency-commercial-card">
                <div class="agency-commercial-head"><strong>${tier.title}</strong><span class="agency-whatsapp-state accepted">${t("agency.marginLabel",{pct:tier.marginPct})}</span></div>
                <strong class="agency-price-hero">${fmtNum(tier.price)} ${cur}</strong>
                <p>${tier.scopeSummary}</p>
                <small>${tier.estimatedDays}d</small>
              </article>`)}
            </div>`}
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
      ${tab==="commercial"&&html`<div class="agency-ops-stack">
        <div class="agency-context-bar">
          <label class="agency-stage-select"><span>${t("agency.selectLead")}</span><select class="field" value=${selectedLeadId} onChange=${e=>{setSelectedLeadId(e.currentTarget.value);setSelectedConvId("");}}>
            <option value="">—</option>${leadOptions.map(l=>html`<option value=${l.id}>${companyOptions.find(c=>c.id===l.companyId)?.name||l.companyId} · ${t(`agency.stage.${l.stage}`)}</option>`)}
          </select></label>
          ${selectedLeadId&&html`<div class="agency-subtabs" role="tablist">
            <button type="button" role="tab" aria-selected=${commercialSubTab==="conversations"} class=${commercialSubTab==="conversations"?"active":""} onClick=${()=>setCommercialSubTab("conversations")}>${t("agency.subtabConversations")}</button>
            <button type="button" role="tab" aria-selected=${commercialSubTab==="quotes"} class=${commercialSubTab==="quotes"?"active":""} onClick=${()=>setCommercialSubTab("quotes")}>${t("agency.subtabQuotes")}</button>
            <button type="button" role="tab" aria-selected=${commercialSubTab==="contracts"} class=${commercialSubTab==="contracts"?"active":""} onClick=${()=>setCommercialSubTab("contracts")}>${t("agency.subtabContracts")}</button>
          </div>`}
          ${emailStatus&&html`<span class="agency-tool-chip"><span class=${"agency-dot "+(emailStatus.configured?"ok":"off")}></span><span>${t("agency.emailOutboxTitle")}: ${emailStatus.configured?t("agency.emailConfigured"):t("agency.emailNotConfigured")}</span></span>`}
        </div>
        ${!selectedLeadId&&html`<${Empty} title=${t("agency.noLeadSelected")} detail=${t("agency.noLeadsHint")}/>`}
        ${selectedLeadId&&commercialSubTab==="conversations"&&html`<div class="agency-commercial-grid">
          <section class="agency-commercial-section">
            <div class="agency-commercial-head">
              <h3>${t("agency.conversationsTitle")}</h3>
              <button class="btn primary" type="button" onClick=${()=>setConvFormOpen(v=>!v)}><${Icon} name=${convFormOpen?"close":"plus"} size="sm"/>${convFormOpen?t("agency.cancel"):t("agency.newConversation")}</button>
            </div>
            ${convFormOpen&&html`<form class="agency-form" onSubmit=${startConversation}>
              <label class="agency-field"><span>${t("agency.channel")}</span><select class="field" value=${convDraft.channel} onChange=${e=>update(setConvDraft,"channel",e.currentTarget.value)}>${CHANNELS.map(ch=>html`<option value=${ch}>${ch}</option>`)}</select></label>
              <${Field} label=${t("agency.subject")} value=${convDraft.subject} required onInput=${v=>update(setConvDraft,"subject",v)}/>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.startConversation")}</button></div>
            </form>`}
            <div class="agency-commercial-list">
              ${!conversations.filter(c=>c.leadId===selectedLeadId).length&&html`<p class="agency-muted">${t("agency.noConversations")}</p>`}
              ${conversations.filter(c=>c.leadId===selectedLeadId).map(conv=>html`<article class=${"agency-commercial-card"+(conv.id===selectedConvId?" selected":"")}>
                <div class="agency-commercial-head"><button class="text" type="button" onClick=${()=>setSelectedConvId(conv.id)}><strong>${conv.subject}</strong></button><span class="agency-whatsapp-state">${t(`agency.conversationStatus.${conv.status}`)}</span></div>
                <small>${conv.channel}</small>
                <div class="agency-commercial-actions"><button class="btn" type="button" onClick=${()=>setSelectedConvId(conv.id)}>${conv.id===selectedConvId?"•":t("agency.open")}</button>${conv.status!=="opted_out"&&conv.status!=="handoff_human"&&html`<button class="text" type="button" onClick=${()=>handoffConv(conv.id)}>${t("agency.handoffHuman")}</button>`}</div>
              </article>`)}
            </div>
            ${selectedConvId&&html`<div class="agency-commercial-card">
              <div class="agency-msg-list">${convMessages.map(m=>html`<div class=${"agency-msg-row "+m.direction}><strong>${m.direction} · ${m.signal}</strong><span>${m.body}</span></div>`)}</div>
              ${suggestNotice&&html`<p class="agency-research-feedback" role="status">${suggestNotice}</p>`}
              <${Field} label=${t("agency.messageBody")} value=${msgBody} onInput=${setMsgBody}/>
              <div class="agency-commercial-actions">
                <button class="btn" type="button" disabled=${!!busy} onClick=${suggestReply}>${busy==="suggest"?t("agency.suggestingReply"):t("agency.suggestReplyBtn")}</button>
                <button class="btn" type="button" disabled=${!!busy} onClick=${extractNeeds}>${t("agency.extractNeedsBtn")}</button>
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
        </div>`}
        ${selectedLeadId&&commercialSubTab==="quotes"&&html`<section class="agency-commercial-section">
            <div class="agency-commercial-head">
              <h3>${t("agency.quotesTitle")}</h3>
              <div class="agency-commercial-actions">
                <button class="btn" type="button" disabled=${!!busy} onClick=${()=>{estimateQuote();setQuoteFormOpen(true);}}><${Icon} name="spark" size="sm"/>${t("agency.estimateQuoteBtn")}</button>
                <button class="btn primary" type="button" onClick=${()=>setQuoteFormOpen(v=>!v)}><${Icon} name=${quoteFormOpen?"close":"plus"} size="sm"/>${quoteFormOpen?t("agency.cancel"):t("agency.newQuote")}</button>
              </div>
            </div>
            ${quoteFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${createQuote}>
              ${catalogItems.length>0&&html`<label class="agency-field agency-form-wide"><span>${t("agency.prefillFromCatalog")}</span><select class="field" value="" onChange=${e=>{
                const it=catalogItems.find(x=>x.id===e.currentTarget.value);
                if(it){
                  setQuoteDraft(cur=>({...cur,title:it.name}));
                  setQuoteLines([{label:it.name,unitPrice:String(it.priceBase),unitCost:String(it.estimatedCost),estimatedDays:String(it.estimatedDays)}]);
                }
              }}><option value="">${t("agency.chooseCatalogService")}</option>${catalogItems.map(it=>html`<option value=${it.id}>${it.name} · ${it.priceBase} (${it.estimatedDays}d)</option>`)}</select></label>`}
              <${Field} label=${t("agency.quoteTitle")} value=${quoteDraft.title} required onInput=${v=>update(setQuoteDraft,"title",v)}/>
              <label class="agency-field"><span>${t("agency.quoteTier")}</span><select class="field" value=${quoteDraft.tier} onChange=${e=>update(setQuoteDraft,"tier",e.currentTarget.value)}><option value="essential">essential</option><option value="standard">standard</option><option value="advanced">advanced</option><option value="custom">custom</option></select></label>
              <${Field} label=${t("agency.discountPct")} value=${quoteDraft.discountPct} type="number" onInput=${v=>update(setQuoteDraft,"discountPct",v)}/>
              ${quoteLines.map((ln,idx)=>html`<div class="agency-form-wide agency-commercial-actions">
                <input class="field" placeholder=${t("agency.lineLabel")} value=${ln.label} required onInput=${e=>{const val=e.currentTarget.value;setQuoteLines(prev=>prev.map((x,i)=>i===idx?{...x,label:val}:x));}}/>
                <input class="field" type="number" placeholder=${t("agency.linePrice")} value=${ln.unitPrice} required onInput=${e=>{const val=e.currentTarget.value;setQuoteLines(prev=>prev.map((x,i)=>i===idx?{...x,unitPrice:val}:x));}}/>
                <input class="field" type="number" placeholder=${t("agency.lineCost")} value=${ln.unitCost} required onInput=${e=>{const val=e.currentTarget.value;setQuoteLines(prev=>prev.map((x,i)=>i===idx?{...x,unitCost:val}:x));}}/>
                <input class="field" type="number" placeholder=${t("agency.lineDays")} value=${ln.estimatedDays} required onInput=${e=>{const val=e.currentTarget.value;setQuoteLines(prev=>prev.map((x,i)=>i===idx?{...x,estimatedDays:val}:x));}}/>
                ${quoteLines.length>1&&html`<button class="text" type="button" onClick=${()=>setQuoteLines(prev=>prev.filter((_,i)=>i!==idx))}>${t("agency.removeLineBtn")}</button>`}
              </div>`)}
              <div class="agency-form-actions">
                <button class="btn" type="button" onClick=${()=>setQuoteLines(prev=>[...prev,{label:"",unitPrice:"1500",unitCost:"700",estimatedDays:"5"}])}>${t("agency.addQuoteLineBtn")}</button>
                <button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.createQuote")}</button>
              </div>
            </form>`}
            <div class="agency-commercial-list">
              ${!quotes.filter(q=>q.leadId===selectedLeadId).length&&html`<p class="agency-muted">${t("agency.noQuotes")}</p>`}
              ${quotes.filter(q=>q.leadId===selectedLeadId).map(q=>{
                const ap=approvals.find(a=>a.id===q.approvalId);
                return html`<article class="agency-commercial-card">
                  <div class="agency-commercial-head"><strong>v${q.version} · ${q.title}</strong><span class=${"agency-whatsapp-state "+q.status}>${t(`agency.quoteStatus.${q.status}`)}</span></div>
                  <div class="agency-commercial-head">
                    <strong class="agency-price-hero">${fmtNum(q.netTotal)} ${q.currency}</strong>
                    <small>${t("agency.marginLabel",{pct:q.marginPct})} · ${q.deliveryDays}d</small>
                  </div>
                  <div class="agency-commercial-actions">
                    <a class="btn" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/quotes/${enc(q.id)}/document`}>${t("agency.previewDocument")}</a>
                    <a class="text" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/quotes/${enc(q.id)}/document?download=1`}>${t("agency.downloadDocument")}</a>
                    <button class="btn" type="button" disabled=${!!busy} onClick=${()=>reviseQuote(q.id)}>${t("agency.reviseQuoteBtn")}</button>
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
          </section>`}
        ${selectedLeadId&&commercialSubTab==="contracts"&&html`<section class="agency-commercial-section">
            <h3>${t("agency.contractsTitle")}</h3>
            <div class="agency-commercial-list">
              ${!contracts.filter(c=>c.leadId===selectedLeadId).length&&html`<p class="agency-muted">${t("agency.noContracts")}</p>`}
              ${contracts.filter(c=>c.leadId===selectedLeadId).map(c=>{
                const ap=approvals.find(a=>a.id===c.approvalId);
                return html`<article class="agency-commercial-card">
                  <div class="agency-commercial-head"><strong>${c.title}</strong><span class=${"agency-whatsapp-state "+c.status}>${t(`agency.contractStatus.${c.status}`)}</span></div>
                  <div class="agency-commercial-head">
                    <strong class="agency-price-hero">${fmtNum(c.totalAmount)} ${c.currency}</strong>
                    <span class=${"agency-whatsapp-state "+c.depositStatus}>${c.depositStatus==="paid"?t("agency.depositPaidLabel"):t("agency.depositUnpaidLabel")} (${fmtNum(c.depositAmount)})</span>
                  </div>
                  <div class="agency-commercial-actions">
                    <a class="btn" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/contracts/${enc(c.id)}/document`}>${t("agency.previewDocument")}</a>
                    <a class="text" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/contracts/${enc(c.id)}/document?download=1`}>${t("agency.downloadDocument")}</a>
                    ${c.status==="draft"&&html`<button class="btn" type="button" onClick=${()=>contractAction(c.id,"request-approval",{reason:"Review contract before signature"})}>${t("agency.requestContractApproval")}</button>`}
                    ${c.status==="pending_approval"&&ap?.status==="pending"&&html`<button class="btn primary" type="button" onClick=${()=>approveRecord(ap.id)}>${t("agency.approveAndSend")}</button>`}
                    ${c.status==="pending_approval"&&ap?.status==="approved"&&html`<button class="btn primary" type="button" onClick=${()=>contractAction(c.id,"sign")}>${t("agency.signContractBtn")}</button>`}
                    ${c.status==="signed"&&c.depositStatus==="unpaid"&&html`<input class="field" placeholder=${t("agency.depositRef")} value=${depositRefByContract[c.id]||""} onInput=${e=>setDepositRefByContract(p=>({...p,[c.id]:e.currentTarget.value}))}/><button class="btn primary" type="button" disabled=${!(depositRefByContract[c.id]||"").trim()} onClick=${()=>contractAction(c.id,"deposit",{status:"paid",reference:depositRefByContract[c.id]})}>${t("agency.recordDepositBtn")}</button>`}
                    ${c.status==="signed"&&(c.depositAmount===0||c.depositStatus==="paid")&&html`<button class="btn primary" type="button" onClick=${()=>{setProjectDraft(cur=>({...cur,contractId:c.id,title:c.title}));setProjectFormOpen(true);switchTab("projects");}}>${t("agency.launchProject")}</button>`}
                  </div>
                </article>`;
              })}
            </div>
          </section>`}
      </div>`}
      ${tab==="projects"&&html`<div class="agency-ops-stack">
        <div class="agency-project-bar">
          <div class="agency-project-bar-left">
            ${projects.length>0&&html`<select class="field" aria-label=${t("agency.projectsTitle")} value=${selectedProjectId} onChange=${e=>setSelectedProjectId(e.currentTarget.value)}>
              ${projects.map(p=>html`<option value=${p.id}>${p.title} (${fmtNum(p.budgetAmount)} ${p.currency})</option>`)}
            </select>`}
            ${selectedProject&&html`<span class=${"agency-whatsapp-state "+selectedProject.status}>${t(`agency.projectStatus.${selectedProject.status}`)}</span>`}
          </div>
          <div class="agency-commercial-actions">
            <button class="btn primary" type="button" onClick=${()=>setProjectFormOpen(v=>!v)}><${Icon} name=${projectFormOpen?"close":"plus"} size="sm"/>${projectFormOpen?t("agency.cancel"):t("agency.handoffProjectTitle")}</button>
            ${selectedProject&&html`
              <button class="btn" type="button" disabled=${!!busy} onClick=${()=>initWorkspace(selectedProject.id)}>${t("agency.initWorkspaceBtn")}</button>
              <button class="btn" type="button" disabled=${!!busy} onClick=${()=>runAutoQa(selectedProject.id)}>${busy==="qa-run"?t("agency.runningAutoQa"):t("agency.runAutoQaBtn")}</button>
              <label class="agency-stage-select"><span>${t("agency.projectStatusAction")}</span>
                <select class="field" value=${selectedProject.status} disabled=${busy==="proj-status"||!(PROJECT_NEXT[selectedProject.status]||[]).length} onChange=${e=>updateProjectStatus(selectedProject.id,e.currentTarget.value)}>
                  <option value=${selectedProject.status}>${t(`agency.projectStatus.${selectedProject.status}`)}</option>
                  ${(PROJECT_NEXT[selectedProject.status]||[]).map(st=>html`<option value=${st}>${t(`agency.projectStatus.${st}`)}</option>`)}
                </select>
              </label>
            `}
          </div>
        </div>
        ${projectFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${createProjectHandoff}>
          <div class="agency-form-head"><strong>${t("agency.handoffProjectTitle")}</strong><button type="button" class="text" onClick=${()=>setProjectFormOpen(false)}>${t("agency.cancel")}</button></div>
          <label class="agency-field"><span>${t("agency.selectContract")}</span><select class="field" value=${projectDraft.contractId} required onChange=${e=>update(setProjectDraft,"contractId",e.currentTarget.value)}>
            <option value="">—</option>
            ${contracts.filter(c=>c.status==="signed"&&(c.depositAmount===0||c.depositStatus==="paid")).map(c=>html`<option value=${c.id}>${c.title} (${c.totalAmount} ${c.currency})</option>`)}
          </select></label>
          <${Field} label=${t("agency.workspacePath")} value=${projectDraft.workspacePath} placeholder="workspaces/projects/..." onInput=${v=>update(setProjectDraft,"workspacePath",v)}/>
          <${Field} label=${t("agency.targetStack")} value=${projectDraft.targetStack} onInput=${v=>update(setProjectDraft,"targetStack",v)}/>
          <${Field} label=${t("agency.technicalSpecs")} value=${projectDraft.technicalSpecs} onInput=${v=>update(setProjectDraft,"technicalSpecs",v)}/>
          <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy||!projectDraft.contractId}>${t("agency.createProjectBtn")}</button></div>
        </form>`}
        ${!selectedProject&&!projectFormOpen&&html`<${Empty} title=${t("agency.noProjects")} detail=${t("agency.handoffProjectTitle")}/>`}
        ${selectedProject&&html`<div class="agency-ops-stack">
          ${workspaceNotice&&html`<p class="agency-research-feedback" role="status">${workspaceNotice}</p>`}
          <div class="agency-subtabs" role="tablist">
            <button type="button" role="tab" aria-selected=${projectSubTab==="lots"} class=${projectSubTab==="lots"?"active":""} onClick=${()=>setProjectSubTab("lots")}>${t("agency.projTabLots")}</button>
            <button type="button" role="tab" aria-selected=${projectSubTab==="studio"} class=${projectSubTab==="studio"?"active":""} onClick=${()=>setProjectSubTab("studio")}>${t("agency.projTabStudio")}</button>
            <button type="button" role="tab" aria-selected=${projectSubTab==="scope"} class=${projectSubTab==="scope"?"active":""} onClick=${()=>setProjectSubTab("scope")}>${t("agency.projTabScope")}</button>
            <button type="button" role="tab" aria-selected=${projectSubTab==="qa"} class=${projectSubTab==="qa"?"active":""} onClick=${()=>setProjectSubTab("qa")}>${t("agency.projTabQa")}</button>
            <button type="button" role="tab" aria-selected=${projectSubTab==="delivery"} class=${projectSubTab==="delivery"?"active":""} onClick=${()=>setProjectSubTab("delivery")}>${t("agency.projTabDelivery")}</button>
          </div>
          ${projectSubTab==="studio"&&html`<${ProjectStudio} orgId=${orgId} project=${selectedProject} onChanged=${()=>setRevision(v=>v+1)}/>`}
          ${projectSubTab==="lots"&&html`<section class="agency-project-section">
            <div class="agency-commercial-head">
              <h3>${t("agency.projectLotsTitle")}</h3>
              <div class="agency-commercial-actions">
                <button class="btn" type="button" disabled=${!!busy} onClick=${()=>autoPlanLots(selectedProject.id)}><${Icon} name="spark" size="sm"/>${t("agency.autoPlanLotsBtn")}</button>
                <button class="btn primary" type="button" onClick=${()=>setLotFormOpen(v=>!v)}><${Icon} name=${lotFormOpen?"close":"plus"} size="sm"/>${lotFormOpen?t("agency.cancel"):t("agency.createLotBtn")}</button>
              </div>
            </div>
            ${lotFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${createProjectLot}>
              <${Field} label=${t("agency.lotTitle")} value=${lotDraft.title} required onInput=${v=>update(setLotDraft,"title",v)}/>
              <${Field} label=${t("agency.lotDescription")} value=${lotDraft.description} onInput=${v=>update(setLotDraft,"description",v)}/>
              <${Field} label=${t("agency.lotCriteria")} value=${lotDraft.acceptanceCriteria} onInput=${v=>update(setLotDraft,"acceptanceCriteria",v)}/>
              <label class="agency-field"><span>${t("agency.lotOwnerRole")}</span><select class="field" value=${lotDraft.ownerRole} onChange=${e=>update(setLotDraft,"ownerRole",e.currentTarget.value)}>${AGENT_ROLES.map(r=>html`<option value=${r}>${r}</option>`)}</select></label>
              <${Field} label=${t("agency.lotEstimatedHours")} value=${lotDraft.estimatedHours} type="number" onInput=${v=>update(setLotDraft,"estimatedHours",v)}/>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.createLotBtn")}</button></div>
            </form>`}
            <div class="agency-commercial-list">
              ${!projectLots.length&&html`<p class="agency-muted">${t("agency.noLots")}</p>`}
              ${projectLots.map(lot=>html`<article class="agency-commercial-card">
                <div class="agency-commercial-head"><strong>#${lot.lotOrder} · ${lot.title} (${lot.ownerRole})</strong><span class=${"agency-whatsapp-state "+lot.status}>${t(`agency.lotStatus.${lot.status}`)}</span></div>
                ${lot.evidenceSummary&&html`<small>${lot.evidenceSummary}</small>`}
                <div class="agency-commercial-actions">
                  <input class="field" placeholder=${t("agency.lotVerifyEvidence")} value=${lotEvidenceById[lot.id]||""} onInput=${e=>setLotEvidenceById(p=>({...p,[lot.id]:e.currentTarget.value}))}/>
                  ${lot.status==="pending"&&html`<button class="btn" type="button" onClick=${()=>updateLotStatus(lot.id,"in_progress")}>${t("agency.markLotInProgress")}</button>`}
                  ${lot.status!=="verified"&&lot.status!=="done"&&html`<button class="btn primary" type="button" disabled=${!(lotEvidenceById[lot.id]||lot.evidenceSummary).trim()} onClick=${()=>updateLotStatus(lot.id,"verified")}>${t("agency.markLotVerified")}</button>`}
                  <button class="text" type="button" onClick=${()=>generateBrief(lot.id)}>${t("agency.generateBriefBtn")}</button>
                </div>
              </article>`)}
            </div>
            ${briefModal&&html`<div><div class="agency-contact-heading"><strong>${t("agency.generateBriefBtn")}</strong><button class="text" type="button" onClick=${()=>setBriefModal("")}>${t("agency.close")}</button></div><div class="agency-brief-md"><${Markdown} text=${briefModal}/></div></div>`}
          </section>`}
          ${projectSubTab==="scope"&&html`<section class="agency-project-section">
            <div class="agency-commercial-head">
              <h3>${t("agency.projTabScope")}</h3>
              <button class="btn primary" type="button" onClick=${()=>setScopeFormOpen(v=>!v)}><${Icon} name=${scopeFormOpen?"close":"plus"} size="sm"/>${scopeFormOpen?t("agency.cancel"):t("agency.proposeScopeChangeBtn")}</button>
            </div>
            ${scopeFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${proposeScopeChange}>
              <${Field} label=${t("agency.scopeChangeTitle")} value=${scopeDraft.title} required onInput=${v=>update(setScopeDraft,"title",v)}/>
              <${Field} label=${t("agency.budgetDelta")} value=${scopeDraft.budgetDelta} type="number" onInput=${v=>update(setScopeDraft,"budgetDelta",v)}/>
              <${Field} label=${t("agency.daysDelta")} value=${scopeDraft.daysDelta} type="number" onInput=${v=>update(setScopeDraft,"daysDelta",v)}/>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.proposeScopeChangeBtn")}</button></div>
            </form>`}
            <div class="agency-commercial-list">
              ${!scopeChanges.length&&html`<p class="agency-muted">${t("agency.noScopeChanges")}</p>`}
              ${scopeChanges.map(sc=>{
                const ap=approvals.find(a=>a.id===sc.approvalId);
                return html`<article class="agency-commercial-card">
                  <div class="agency-commercial-head"><strong>${sc.title} (${sc.budgetDelta >= 0 ? "+" : ""}${sc.budgetDelta}, ${sc.daysDelta >= 0 ? "+" : ""}${sc.daysDelta}d)</strong><span class=${"agency-whatsapp-state "+sc.status}>${t(`agency.scopeChangeStatus.${sc.status}`)}</span></div>
                  <div class="agency-commercial-actions">
                    ${sc.status==="proposed"&&html`<button class="btn" type="button" onClick=${()=>scopeChangeAction(sc.id,"request-approval",{reason:"Scope addendum review"})}>${t("agency.requestScopeApproval")}</button>`}
                    ${sc.status==="approval_requested"&&ap?.status==="pending"&&html`<button class="btn primary" type="button" onClick=${()=>approveRecord(ap.id)}>${t("agency.approveAndSend")}</button>`}
                    ${sc.status==="approval_requested"&&ap?.status==="approved"&&html`<button class="btn primary" type="button" onClick=${()=>scopeChangeAction(sc.id,"apply",{})}>${t("agency.applyScopeChangeBtn")}</button>`}
                  </div>
                </article>`;
              })}
            </div>
          </section>`}
          ${projectSubTab==="qa"&&html`<section class="agency-project-section">
            <div class="agency-commercial-head">
              <h3>${t("agency.qaGateTitle")}</h3>
              <div class="agency-commercial-actions">
                <button class="btn primary" type="button" disabled=${!!busy} onClick=${()=>runFourAxisQa(selectedProject.id)}>${t("agency.qaAuditAllBtn")}</button>
                <button class="btn" type="button" onClick=${()=>setQaFormOpen(v=>!v)}><${Icon} name=${qaFormOpen?"close":"plus"} size="sm"/>${qaFormOpen?t("agency.cancel"):t("agency.recordQaCheckBtn")}</button>
              </div>
            </div>
            ${qaGate&&html`<div class=${"agency-qa-gate "+(qaGate.readyForDelivery?"ready":"blocked")}>
              <strong>${qaGate.readyForDelivery?t("agency.qaGateReady"):t("agency.qaGateBlocked")}</strong>
              <small>${qaGate.verifiedLots}/${qaGate.totalLots} · ${qaGate.passedCategories.length}/4</small>
              ${!qaGate.readyForDelivery&&qaGate.blockers.length>0&&html`<small>${t("agency.qaBlockers")}: ${qaGate.blockers.join(", ")}</small>`}
            </div>`}
            ${qaFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${recordQaCheck}>
              <label class="agency-field"><span>${t("agency.qaCategoryLabel")}</span><select class="field" value=${qaDraft.category} onChange=${e=>update(setQaDraft,"category",e.currentTarget.value)}>${QA_CATEGORIES.map(c=>html`<option value=${c}>${t(`agency.qaCategory.${c}`)}</option>`)}</select></label>
              <label class="agency-field"><span>${t("agency.qaStatusLabel")}</span><select class="field" value=${qaDraft.status} onChange=${e=>update(setQaDraft,"status",e.currentTarget.value)}>${QA_STATUSES.map(s=>html`<option value=${s}>${t(`agency.qaCheckStatus.${s}`)}</option>`)}</select></label>
              <${Field} label=${t("agency.qaCheckTitle")} value=${qaDraft.title} required onInput=${v=>update(setQaDraft,"title",v)}/>
              <${Field} label=${t("agency.qaEvidence")} value=${qaDraft.evidence} onInput=${v=>update(setQaDraft,"evidence",v)}/>
              <${Field} label=${t("agency.qaFindings")} value=${qaDraft.findings} onInput=${v=>update(setQaDraft,"findings",v)}/>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.recordQaCheckBtn")}</button></div>
            </form>`}
            <div class="agency-commercial-list">
              ${!qaChecks.length&&html`<p class="agency-muted">${t("agency.noQaChecks")}</p>`}
              ${qaChecks.map(c=>html`<article class="agency-commercial-card">
                <div class="agency-commercial-head"><strong>${t(`agency.qaCategory.${c.category}`)} · ${c.title}</strong><span class=${"agency-whatsapp-state "+c.status}>${t(`agency.qaCheckStatus.${c.status}`)}</span></div>
                ${c.evidence&&html`<small>${c.evidence}</small>`}
              </article>`)}
            </div>
          </section>`}
          ${projectSubTab==="delivery"&&html`<div class="agency-commercial-grid">
            <section class="agency-project-section">
              <div class="agency-commercial-head">
                <h3>${t("agency.deliveriesTitle")}</h3>
                <div class="agency-commercial-actions">
                  <a class="btn" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/projects/${enc(selectedProject.id)}/delivery-report`}>${t("agency.deliveryReportBtn")}</a>
                  <a class="btn" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/projects/${enc(selectedProject.id)}/package.zip`}>${t("agency.downloadZipBtn")}</a>
                  <button class="btn primary" type="button" disabled=${!qaGate?.readyForDelivery} onClick=${()=>setDeliveryFormOpen(v=>!v)}><${Icon} name=${deliveryFormOpen?"close":"plus"} size="sm"/>${deliveryFormOpen?t("agency.cancel"):t("agency.prepareDeliveryBtn")}</button>
                </div>
              </div>
              ${deliveryFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${prepareDelivery}>
                <${Field} label=${t("agency.deliveryEnvUrl")} value=${deliveryDraft.environmentUrl} placeholder="https://" onInput=${v=>update(setDeliveryDraft,"environmentUrl",v)}/>
                <${Field} label=${t("agency.deliveryNotes")} value=${deliveryDraft.releaseNotes} onInput=${v=>update(setDeliveryDraft,"releaseNotes",v)}/>
                <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy||!qaGate?.readyForDelivery}>${t("agency.prepareDeliveryBtn")}</button></div>
              </form>`}
              <div class="agency-commercial-list">
                ${!deliveries.length&&html`<p class="agency-muted">${t("agency.noDeliveries")}</p>`}
                ${deliveries.map(d=>{
                  const ap=approvals.find(a=>a.id===d.approvalId);
                  return html`<article class="agency-commercial-card">
                    <div class="agency-commercial-head"><strong>v${d.version} · ${d.environmentUrl||"—"}</strong><span class=${"agency-whatsapp-state "+d.status}>${t(`agency.deliveryStatus.${d.status}`)}</span></div>
                    <small>${d.qaSummary}</small>
                    <div class="agency-commercial-actions">
                      ${d.status==="prepared"&&html`<button class="btn" type="button" onClick=${()=>deliveryAction(d.id,"request-approval",{reason:"Production deployment approval"})}>${t("agency.requestDeployApproval")}</button>`}
                      ${d.status==="approval_requested"&&ap?.status==="pending"&&html`<button class="btn primary" type="button" onClick=${()=>approveRecord(ap.id)}>${t("agency.approveAndSend")}</button>`}
                      ${d.status==="approval_requested"&&ap?.status==="approved"&&html`<button class="btn primary" type="button" onClick=${()=>deliveryAction(d.id,"deploy",{})}>${t("agency.deployProductionBtn")}</button>`}
                      ${d.status==="deployed"&&html`<input class="field" placeholder=${t("agency.clientFeedback")} value=${feedbackByDelivery[d.id]||""} onInput=${e=>setFeedbackByDelivery(p=>({...p,[d.id]:e.currentTarget.value}))}/><button class="btn primary" type="button" onClick=${()=>deliveryAction(d.id,"accept",{accepted:true,feedback:feedbackByDelivery[d.id]||""})}>${t("agency.acceptDeliveryBtn")}</button><button class="text" type="button" onClick=${()=>deliveryAction(d.id,"accept",{accepted:false,feedback:feedbackByDelivery[d.id]||""})}>${t("agency.rejectDeliveryBtn")}</button>`}
                    </div>
                  </article>`;
                })}
              </div>
            </section>
            <section class="agency-project-section">
              <div class="agency-commercial-head">
                <h3>${t("agency.followUpsTitle")}</h3>
                <button class="btn primary" type="button" onClick=${()=>setFollowUpFormOpen(v=>!v)}><${Icon} name=${followUpFormOpen?"close":"plus"} size="sm"/>${followUpFormOpen?t("agency.cancel"):t("agency.scheduleFollowUpBtn")}</button>
              </div>
              ${followUpFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${scheduleFollowUp}>
                <label class="agency-field"><span>${t("agency.followUpTypeLabel")}</span><select class="field" value=${followUpDraft.type} onChange=${e=>update(setFollowUpDraft,"type",e.currentTarget.value)}>${FOLLOWUP_TYPES.map(ft=>html`<option value=${ft}>${t(`agency.followUpType.${ft}`)}</option>`)}</select></label>
                <${Field} label=${t("agency.followUpNotes")} value=${followUpDraft.notes} onInput=${v=>update(setFollowUpDraft,"notes",v)}/>
                <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.scheduleFollowUpBtn")}</button></div>
              </form>`}
              <div class="agency-commercial-list">
                ${!followUps.filter(f=>f.projectId===selectedProjectId).length&&html`<p class="agency-muted">${t("agency.noFollowUps")}</p>`}
                ${followUps.filter(f=>f.projectId===selectedProjectId).map(fu=>html`<article class="agency-commercial-card">
                  <div class="agency-commercial-head"><strong>${t(`agency.followUpType.${fu.type}`)}</strong><span class=${"agency-whatsapp-state "+fu.status}>${t(`agency.followUpStatus.${fu.status}`)}</span></div>
                  <small>${fu.notes||"—"}</small>
                  ${(fu.status==="scheduled"||fu.status==="completed")&&html`<div class="agency-commercial-actions">
                    ${fu.status==="scheduled"&&html`<button class="btn" type="button" onClick=${()=>completeFollowUp(fu.id)}>${t("agency.completeFollowUpBtn")}</button>`}
                    <button class="btn primary" type="button" disabled=${!!busy} onClick=${()=>convertFollowUp(fu.id)}>${t("agency.convertOpportunityBtn")}</button>
                  </div>`}
                </article>`)}
              </div>
            </section>
          </div>`}
        </div>`}
      </div>`}
      ${tab==="operations"&&html`<div class="agency-ops-stack">
        <div class="agency-quick-strip">
          <button type="button" class="agency-quick-tile" onClick=${()=>{setProspectOpen(true);switchTab("companies");}}>
            <span class="agency-quick-icon tone-blue"><${Icon} name="globe" size="sm"/></span>
            <strong>${t("agency.prospectSearchTitle")}</strong>
          </button>
          <button type="button" class="agency-quick-tile" onClick=${()=>switchTab("leads")}>
            <span class="agency-quick-icon tone-teal"><${Icon} name="user" size="sm"/></span>
            <strong>${t("agency.leads")}</strong>
          </button>
          <button type="button" class="agency-quick-tile" onClick=${()=>switchTab("commercial")}>
            <span class="agency-quick-icon tone-amber"><${Icon} name="banknotes" size="sm"/></span>
            <strong>${t("agency.commercial")}</strong>
          </button>
          <button type="button" class="agency-quick-tile" onClick=${()=>switchTab("copilot")}>
            <span class="agency-quick-icon tone-purple"><${Icon} name="spark" size="sm"/></span>
            <strong>${t("agency.copilot")}</strong>
          </button>
        </div>
        ${metrics&&html`<div class="agency-kpi-grid">
          <${Metric} label=${t("agency.kpiSignedRevenue")} value=${`${fmtNum(metrics.signedRevenue)} ${cur}`.trim()} icon="banknotes" tone="green"/>
          <${Metric} label=${t("agency.depositPaidLabel")} value=${`${fmtNum(metrics.collectedDeposits)} ${cur}`.trim()} icon="wallet" tone="teal"/>
          <${Metric} label=${t("agency.kpiQuoteAcceptance")} value=${`${metrics.quoteAcceptanceRate}%`} icon="trend" tone="blue"/>
          <${Metric} label=${t("agency.kpiQaFirstPass")} value=${`${metrics.qaFirstPassRate}%`} icon="shield" tone="purple"/>
          <${Metric} label=${t("agency.kpiProjectsDelivered")} value=${metrics.projectsDelivered} icon="folder" tone="green"/>
          <${Metric} label=${t("agency.approvalsTitle")} value=${metrics.pendingApprovalsCount} icon="clipboardCheck" tone="amber"/>
          <${Metric} label=${t("agency.kpiOpenMissions")} value=${metrics.openMissions} icon="code" tone="blue"/>
          <${Metric} label=${t("agency.kpiPendingFollowUps")} value=${metrics.pendingFollowUps} icon="user" tone="purple"/>
        </div>`}
        <div class="agency-ops-bento">
          <div class="agency-commercial-col">
            <section class="agency-project-section">
              <div class="agency-commercial-head">
                <h3>${t("agency.approvalsTitle")}</h3>
                <span class="agency-count-pill">${approvals.filter(a=>a.status==="pending").length}</span>
              </div>
              <div class="agency-commercial-list">
                ${!approvals.filter(a=>a.status==="pending").length&&html`<p class="agency-muted">${t("agency.noPendingApprovals")}</p>`}
                ${approvals.filter(a=>a.status==="pending").map(ap=>html`<article class="agency-commercial-card">
                  <div class="agency-commercial-head"><strong>${ap.actionType}</strong><span class="agency-whatsapp-state pending">${ap.subjectType} · ${ap.subjectId}</span></div>
                  ${ap.reason&&html`<small>${ap.reason}</small>`}
                  <div class="agency-commercial-actions">
                    <button class="btn primary" type="button" disabled=${!!busy} onClick=${()=>decideApproval(ap.id,"approved")}>${t("agency.approveAndSend")}</button>
                    <button class="text" type="button" disabled=${!!busy} onClick=${()=>decideApproval(ap.id,"rejected")}>${t("agency.rejectBtn")}</button>
                  </div>
                </article>`)}
              </div>
            </section>
            <section class="agency-project-section">
              <div class="agency-commercial-head">
                <h3>${t("agency.auditTitle")}</h3>
                <button class="btn" type="button" disabled=${!!busy} onClick=${verifyAuditChain}>${t("agency.verifyAuditBtn")}</button>
              </div>
              ${auditVerify&&html`<p class="agency-research-feedback" role="status">${auditVerify.valid?t("agency.auditValid"):t("agency.qaGateBlocked")} (${auditVerify.checkedEvents??auditVerify.eventsChecked??0})</p>`}
              <div class="agency-commercial-list">
                ${auditEvents.slice(0,6).map(ev=>html`<div class="agency-audit-row"><strong>${ev.action}</strong><span>${new Date(ev.createdAt).toLocaleTimeString()}</span></div>`)}
              </div>
            </section>
            <section class="agency-project-section">
              <div class="agency-commercial-head">
                <h3>${t("agency.executionNodeTitle")}</h3>
                <span class="agency-tool-chip">
                  <span class=${"agency-dot "+(execNodeStatus?.connected?"ok":execNodeStatus?.state==="active"?"warn":"off")}></span>
                  <span>${execNodeStatus?(typeof execNodeStatus==="string"?execNodeStatus:(execNodeStatus.state||execNodeStatus.mode||"—")):"—"}</span>
                </span>
              </div>
              <div class="agency-tool-list">
                ${devTools.map(tool=>html`<div class="agency-tool-chip"><span class=${"agency-dot "+(tool.available?"ok":"off")}></span><strong>${tool.name}</strong><span>${tool.available?(tool.version||t("agency.toolAvailable")):t("agency.toolMissing")}</span></div>`)}
              </div>
              <div class="agency-role-grid">
                ${agentProfiles.map(ag=>html`<button type="button" class="agency-tool-chip" onClick=${()=>switchTab("agents")}><span class=${"agency-dot "+(ag.config?.enabled===false?"off":"ok")}></span><strong>${t(`agency.agentRoleNames.${ag.role}`)}</strong></button>`)}
              </div>
            </section>
          </div>
          <section class="agency-project-section">
            <div class="agency-commercial-head">
              <h3>${t("agency.missionsTitle")}</h3>
              <button class="btn primary" type="button" onClick=${()=>setMissionFormOpen(v=>!v)}><${Icon} name=${missionFormOpen?"close":"plus"} size="sm"/>${missionFormOpen?t("agency.cancel"):t("agency.createMissionBtn")}</button>
            </div>
            ${missionFormOpen&&html`<form class="agency-form agency-form-grid" onSubmit=${createMission}>
              <label class="agency-field"><span>${t("agency.missionProjectLabel")}</span><select class="field" value=${missionDraft.projectId} onChange=${e=>update(setMissionDraft,"projectId",e.currentTarget.value)}><option value="">—</option>${projects.map(p=>html`<option value=${p.id}>${p.title}</option>`)}</select></label>
              <label class="agency-field"><span>${t("agency.missionRoleLabel")}</span><select class="field" value=${missionDraft.agentRole} onChange=${e=>update(setMissionDraft,"agentRole",e.currentTarget.value)}>${AGENT_ROLES.map(r=>html`<option value=${r}>${r}</option>`)}</select></label>
              <${Field} label=${t("agency.missionTitle")} value=${missionDraft.title} required onInput=${v=>update(setMissionDraft,"title",v)}/>
              <${Field} label=${t("agency.missionObjective")} value=${missionDraft.objective} onInput=${v=>update(setMissionDraft,"objective",v)}/>
              <${Field} label=${t("agency.missionToolLabel")} value=${missionDraft.preferredTool} onInput=${v=>update(setMissionDraft,"preferredTool",v)}/>
              <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.createMissionBtn")}</button></div>
            </form>`}
            <div class="agency-commercial-list">
              ${!missions.length&&html`<p class="agency-muted">${t("agency.noMissions")}</p>`}
              ${missions.map(m=>html`<article class="agency-commercial-card">
                <div class="agency-commercial-head"><strong>${m.title} · ${m.agentRole}</strong><span class=${"agency-whatsapp-state "+m.status}>${t(`agency.missionStatus.${m.status}`)}</span></div>
                <small>${m.preferredTool||"—"}${m.projectId?` · ${projects.find(p=>p.id===m.projectId)?.title||m.projectId}`:""}</small>
                ${m.outputSummary&&html`<small><strong>${t("agency.missionOutputLabel")}:</strong> ${m.outputSummary}</small>`}
                ${m.evidencePaths?.length>0&&html`<small><strong>${t("agency.missionEvidenceLabel")}:</strong> ${m.evidencePaths.join(", ")}</small>`}
                ${m.brief&&html`<details class="agency-brief-details"><summary>${t("agency.missionBriefLabel")}</summary><div class="agency-brief-md"><${Markdown} text=${m.brief}/></div></details>`}
                <div class="agency-commercial-actions">
                  <button class="btn" type="button" disabled=${!!busy} onClick=${()=>executeMission(m.id,"brief_export")}>${t("agency.exportBriefBtn")}</button>
                  <button class="btn" type="button" disabled=${!!busy} onClick=${()=>executeMission(m.id,"llm_draft")}>${t("agency.executeLlmBtn")}</button>
                  <select class="field" aria-label=${t("agency.cliActionLabel")} value=${cliActionByMission[m.id]||"npm_test"} onChange=${e=>setCliActionByMission(p=>({...p,[m.id]:e.currentTarget.value}))}>
                    ${CLI_ACTIONS.map(([val,label])=>html`<option value=${val}>${label}</option>`)}
                  </select>
                  <button class="btn" type="button" disabled=${!!busy} onClick=${()=>executeMission(m.id,"cli_tool",cliActionByMission[m.id]||"npm_test")}>${t("agency.runCliBtn")}</button>
                  ${m.status==="planned"&&html`<button class="btn" type="button" onClick=${()=>updateMission(m.id,"running")}>${t("agency.startMissionBtn")}</button>`}
                  ${(m.status==="planned"||m.status==="running")&&html`<button class="btn primary" type="button" onClick=${()=>updateMission(m.id,"completed")}>${t("agency.completeMissionBtn")}</button>`}
                </div>
              </article>`)}
            </div>
          </section>
        </div>
      </div>`}
      ${tab==="agents"&&html`<${AgencyAgents} orgId=${orgId} agents=${agentProfiles} onSaved=${()=>setRevision(v=>v+1)}/>`}
      ${tab==="copilot"&&html`<${AgencyCopilot} orgId=${orgId} activeTab=${tab} companyId=${selected} leadId=${selectedLeadId} projectId=${selectedProjectId}/>`}
    `}
  </section>`;

}
