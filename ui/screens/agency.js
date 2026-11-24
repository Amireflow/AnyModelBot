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

function Field({label,value,onInput,required=false,type="text",placeholder=""}) {
  return html`<label class="agency-field"><span>${label}</span><input class="field" type=${type} value=${value} placeholder=${placeholder} required=${required} onInput=${(e)=>onInput(e.currentTarget.value)} /></label>`;
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
    const path=tab==="companies"?"/companies?":"/leads?";
    Promise.all([
      api(`/agency/${enc(orgId)}/dashboard`),
      api(`/agency/${enc(orgId)}${path}${qs({q:query,limit:SIZE,offset:page*SIZE})}`)
    ]).then(([stats,data])=>{
      if(!live)return;
      setDashboard(stats);setRows(data);
    }).catch(e=>live&&setError(e.message)).finally(()=>live&&setBusy(""));
    return ()=>{live=false;};
  },[orgId,tab,query,page,revision,lang]);

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
  const changeOrg=(id)=>{setOrgId(id);rememberOrg(id);setSelected("");setPage(0);};
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
      <div class="agency-toolbar">
        <div class="agency-tabs" role="tablist">
          <button role="tab" aria-selected=${tab==="companies"} class=${tab==="companies"?"active":""} onClick=${()=>{setTab("companies");setPage(0);}}>${t("agency.companies")}</button>
          <button role="tab" aria-selected=${tab==="leads"} class=${tab==="leads"?"active":""} onClick=${()=>{setTab("leads");setPage(0);}}>${t("agency.leads")}</button>
        </div>
        ${tab==="companies"&&html`<button class="btn" onClick=${()=>setQualificationForm(v=>!v)}>${t("agency.qualificationProfile")}</button>`}
        <label class="agency-search"><${Icon} name="search"/><input type="search" value=${query} placeholder=${t("agency.search")} onInput=${e=>{setQuery(e.currentTarget.value);setPage(0);}}/></label>
        ${tab==="companies"
          ?html`<button class="btn primary" onClick=${()=>setCompanyForm(v=>!v)}><${Icon} name="plus"/>${t("agency.newCompany")}</button>`
          :html`<button class="btn primary" disabled=${!dashboard?.companyCount} onClick=${()=>setLeadForm(v=>!v)}><${Icon} name="plus"/>${t("agency.newLead")}</button>`}
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
          <tbody>${rows.items.map(c=>html`<tr class=${selected===c.id?"selected":""}><td><button class="agency-company-link" onClick=${()=>setSelected(v=>v===c.id?"":c.id)}><strong>${c.name}</strong><small>${c.website||c.countryCode||"—"}</small></button></td><td>${c.industry||"—"}</td><td>${c.city||"—"}</td></tr>`)}</tbody>
        </table></div>
        ${selectedCompany&&html`<aside class="agency-detail"><div class="agency-detail-head"><div><span class="agency-eyebrow">${t("agency.companyDetails")}</span><h2>${selectedCompany.name}</h2></div><button class="icon-btn" aria-label=${t("agency.close")} onClick=${()=>setSelected("")}><${Icon} name="close"/></button></div>
          <dl class="agency-detail-facts"><div><dt>${t("agency.website")}</dt><dd>${selectedCompany.website||"—"}</dd></div><div><dt>${t("agency.industry")}</dt><dd>${selectedCompany.industry||"—"}</dd></div><div><dt>${t("agency.city")}</dt><dd>${selectedCompany.city||"—"}</dd></div></dl>
          <div class="agency-contact-heading"><h3>${t("agency.contacts")}</h3><button class="text" onClick=${()=>setContactForm(v=>!v)}>${t("agency.addContact")}</button></div>
          ${contactForm&&html`<form class="agency-form agency-contact-form" onSubmit=${createContact}><${Field} label=${t("agency.contactName")} value=${contact.displayName} required onInput=${v=>update(setContact,"displayName",v)}/><${Field} label=${t("agency.role")} value=${contact.role} onInput=${v=>update(setContact,"role",v)}/><${Field} label=${t("agency.email")} value=${contact.email} type="email" onInput=${v=>update(setContact,"email",v)}/><${Field} label=${t("agency.phone")} value=${contact.phone} type="tel" onInput=${v=>update(setContact,"phone",v)}/><button class="btn primary block" type="submit">${t("agency.saveContact")}</button></form>`}
          ${contacts.map(p=>html`<div class="agency-contact-row"><span class="agency-contact-avatar">${(p.displayName||"?").slice(0,1).toUpperCase()}</span><span><strong>${p.displayName}</strong><small>${p.role||p.email||p.phone||"—"}</small></span></div>`)}

          ${!contacts.length&&html`<p class="agency-muted">${t("agency.noContacts")}</p>`}
          <section class="agency-qualification">
            <div class="agency-contact-heading"><h3>${t("agency.qualificationTitle")}</h3><span class="agency-qualification-status">${qualification?t("agency.qualificationStatus."+qualification.status):"—"}</span></div>
            ${qualification&&html`<div class="agency-qualification-score"><strong>${qualification.score===null?"—":qualification.score+"/100"}</strong><span>${t("agency.qualificationCoverage",{coverage:qualification.coverage})}</span></div>
              ${qualification.criteria.map(item=>html`<div class="agency-qualification-criterion"><strong>${t("agency.qualificationCriteria."+item.id)}</strong><span class=${"agency-qualification-result "+item.result}>${t("agency.qualificationResult."+item.result)}</span><small>${t("agency.qualificationExpected",{value:item.expected.join(", ")})} · ${item.observed||t("agency.qualificationUnknownValue")} · ${t("agency.qualificationWeight",{weight:Math.round(item.weight)})}</small></div>`)}
              ${qualification.blockingReasons.length?html`<p class="agency-qualification-warning">${t("agency.qualificationBlocked")}</p>`:null}
              ${qualification.status==="unconfigured"?html`<p class="agency-muted">${t("agency.qualificationNoProfile")}</p>`:null}
            ` : html`<p class="agency-muted">${t("agency.qualificationNoProfile")}</p>`}
            <p class="agency-muted">${t("agency.qualificationManualOnly")}</p>
          </section>
          <section class="agency-research">
            <div class="agency-contact-heading"><h3>${t("agency.researchImportTitle")}</h3><button class="btn" disabled=${!!busy||activeResearchJobs.length>0||researchLaunchActive} onClick=${startResearch}>${busy==="research-start"?t("agency.startingResearch"):t("agency.startResearch")}</button></div>
            ${activeResearchJobs.map(job=>html`<div class="agency-active-job"><div><strong>${t("agency.jobStatus."+job.status)}</strong><span class="num">${job.progress}%</span></div><div class="agency-job-progress"><i style=${{width:Math.max(0,Math.min(100,job.progress))+"%"}}></i></div><small>${job.currentStep||job.id}</small></div>`)}
            ${stalledResearchJobs.map(job=>html`<div class="agency-research-stalled"><strong>${t("agency.researchStalled")}</strong><span>${job.company} · ${job.id}</span></div>`)}
            ${failedResearchJobs.map(job=>html`<div class="agency-research-failed"><strong>${t("agency.jobStatus."+job.status)}</strong><span>${job.company} · ${job.id}</span></div>`)}
            ${researchLaunch?.status==="failed"&&!failedResearchJobs.length&&html`<div class="agency-research-failed"><strong>${t("agency.researchLaunchFailed")}</strong></div>`}
            ${researchLaunch?.status==="done"&&!activeResearchJobs.length&&!completedResearchJobs.length&&!failedResearchJobs.length&&html`<div class="agency-research-stalled"><strong>${t("agency.researchFinishedNoReport")}</strong></div>`}
            ${completedResearchJobs.length?html`<div class="agency-research-import"><label class="agency-field"><span>${t("agency.chooseResearchJob")}</span><select class="field" value=${researchJobId} onChange=${e=>setResearchJobId(e.currentTarget.value)}><option value="">—</option>${completedResearchJobs.map(job=>html`<option value=${job.id}>${job.company} · ${job.sourceCount} ${t("agency.sources")} · ${job.id}</option>`)}</select></label><button class="btn" disabled=${!researchJobId||!!busy} onClick=${importResearch}>${busy==="research-import"?t("agency.importingResearch"):t("agency.importResearch")}</button></div>`:activeResearchJobs.length?null:html`<p class="agency-muted">${t("agency.noResearchJobs")}</p>`}
            ${researchImportMessage&&html`<p class="agency-research-feedback" role="status">${researchImportMessage}</p>`}
            <div class="agency-contact-heading"><h3>${t("agency.researchTitle")}</h3><button class="text" onClick=${()=>setEvidenceForm(v=>!v)}>${t("agency.addEvidence")}</button></div>
            ${research.assessment&&html`<div class="agency-research-score"><strong>${research.assessment.score}/100</strong><span>${t("agency.researchStatus."+research.assessment.status)}</span><small>${research.assessment.evidenceCount} ${t("agency.evidenceCount")} · ${research.assessment.distinctSourceHosts} ${t("agency.sources")}</small></div>`}
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
      ${tab==="leads"&&rows.items?.length>0&&html`<div class="agency-lead-list">${rows.items.map(l=>html`<article class="agency-lead-card"><div class="agency-lead-main"><div><strong>${companyOptions.find(c=>c.id===l.companyId)?.name||l.companyId}</strong><p>${l.notes||l.source||t("agency.noLeadNotes")}</p></div><${Badge} s=${t("agency.stage."+l.stage)}/></div>
        <div class="agency-lead-footer"><span>${t("agency.updated")} · ${new Date(l.updatedAt).toLocaleDateString()}</span><label class="agency-stage-select"><span>${t("agency.moveTo")}</span><select class="field" value=${l.stage} disabled=${busy==="stage"||!NEXT[l.stage]?.length} onChange=${e=>moveLead(l.id,e.currentTarget.value)}><option value=${l.stage}>${t("agency.stage."+l.stage)}</option>${(NEXT[l.stage]||[]).map(s=>html`<option value=${s}>${t("agency.stage."+s)}</option>`)}</select></label></div>
      </article>`)}</div>`}
      ${tab==="leads"&&!busy&&!rows.items?.length&&html`<${Empty} title=${t("agency.noLeads")} detail=${query?t("agency.noSearchResults"):t("agency.noLeadsHint")}/>`}
      ${rows.total>SIZE&&html`<div class="agency-pagination"><button class="btn" disabled=${page===0} onClick=${()=>setPage(v=>Math.max(0,v-1))}>${t("agency.previous")}</button><span>${t("agency.page",{current:page+1,total:Math.ceil(rows.total/SIZE)})}</span><button class="btn" disabled=${(page+1)*SIZE>=rows.total} onClick=${()=>setPage(v=>v+1)}>${t("agency.next")}</button></div>`}
    `}
  </section>`;

}
