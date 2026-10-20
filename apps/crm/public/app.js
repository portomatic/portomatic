import {companyList,companyDetail} from './companies.js';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl=s=>{try{const u=new URL(s);return ['https:','http:'].includes(u.protocol)?esc(u.href):'#';}catch{return '#';}};
const fmt=(s,time=false)=>s?new Intl.DateTimeFormat(undefined,time?{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}:{month:'short',day:'numeric',year:'numeric'}).format(new Date(s)):'—';
const number=n=>Number(n||0).toLocaleString();
const bytes=n=>n?`${(Number(n)/1e9).toFixed(2)} GB`:'—';
const duration=n=>n?`${Math.round(Number(n)/60000)} min`:'';
const badge=(text,type='')=>`<span class="badge ${type}">${esc(text)}</span>`;
let data=null,view='timeline',selectedPerson=null,selectedCompany=null,personReturnCompany=null,savedList='yc-slack-bots',query='',loading=0,inFlight=0;
let lastLoadError=null;
const views=['timeline','people','companies','recordings'];
const typeNames={email:'Email',meeting:'Meeting',recording:'Recording',document:'Drive document',note:'Note',connection:'LinkedIn connection',message:'Message'};
async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d;}
function notice(message){$('#notice').textContent=message||'';}
function peopleLinks(people){return (people||[]).filter(p=>p.relationship!=='founder').map(p=>`<button class="person-link" data-person="${esc(p.id)}">${esc(p.name)}</button>`).join('')||'<span class="muted">—</span>';}
async function load({silent=false}={}){
  if(silent&&inFlight)return;
  inFlight++;
  const seq=++loading;
  try{
    $('#status').textContent='Refreshing';
    const params=new URLSearchParams({limit:'150',view});
    if(query)params.set('search',query);
    if(selectedPerson)params.set('person',selectedPerson);
    if(view==='companies'){
      params.set('list',savedList);params.set('evidence',$('#company-evidence').value);
      if(selectedCompany)params.set('company',selectedCompany);
      if($('#company-category').value)params.set('category',$('#company-category').value);
    }
    if($('#owner').value)params.set('owner',$('#owner').value);
    if(view==='recordings')params.set('kind','recording');else if(view!=='companies'&&$('#kind').value)params.set('kind',$('#kind').value);
    const state=await api('/api/state?'+params);if(seq!==loading)return;
    data=state;data.selected_list=savedList;
    if(lastLoadError&&$('#notice').textContent===lastLoadError)notice();lastLoadError=null;
    if($('#owner').options.length===1)for(const m of data.members)$('#owner').add(new Option(m.name,m.member_id));
    render();$('#status').textContent=state.sync?.error?'Sync needs attention':state.sync?.refreshing?'Updating…':'';$('#updated').textContent='Updated '+fmt(state.sync?.syncedAt||new Date().toISOString(),true);
  }catch(error){lastLoadError=error.message;notice(error.message);$('#status').textContent='Connection needs attention';}finally{inFlight--;}
}
function render(){
  if(!data)return;
  const c=data.counts;
  $('#stats').innerHTML=[['People',number(c.people)],['Touchpoints',number(c.touchpoints)],['Recordings',number(c.recordings)],['Founders',number(data.members.length)]].map(([k,v])=>`<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join('');
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#kind').hidden=['people','companies','recordings'].includes(view);
  $('#company-filters').hidden=view!=='companies';
  $('#search').placeholder=view==='companies'?'Search companies, bots, batches, use cases…':'Search people, companies, conversations…';
  if(view==='companies'){
    const evidenceCount=data.lists.find(l=>l.slug===savedList);
    $('#stats').innerHTML=[['Companies shown',data.companies.length],['Published matches in list',evidenceCount?.published||0],['All researched entries',evidenceCount?.companies||0],['With people in imported network',data.companies.filter(c=>Number(c.people_count)>0).length]].map(([k,v])=>`<div class="stat"><span>${k}</span><strong>${number(v)}</strong></div>`).join('');
    $('#company-list').innerHTML=data.lists.map(l=>`<option value="${esc(l.slug)}">${esc(l.name)}</option>`).join('');$('#company-list').value=savedList;
    const category=$('#company-category').value;
    $('#company-category').innerHTML='<option value="">All use cases</option>'+data.categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');$('#company-category').value=category;
    $('#content').innerHTML=selectedCompany?companyDetail(data):companyList(data);
    if(selectedCompany&&$('#company-timeline'))$('#company-timeline').innerHTML=data.timeline.length?`<div class="table-wrap"><table><thead><tr><th class="date-col">When</th><th class="type-col">Type</th><th>Touchpoint</th><th class="people-col">People</th><th class="owner-col">Founder</th></tr></thead><tbody>${data.timeline.map(timelineRow).join('')}</tbody></table></div>`:'<p class="empty">No imported history with these people.</p>';
    return;
  }
  const people=data.people.filter(p=>p.relationship!=='founder');
  if(view==='people'&&!selectedPerson){
    const search=query.toLowerCase();
    const filtered=people.filter(p=>!search||[p.name,p.company,p.position,...p.emails,...p.profiles.map(v=>v.url)].join(' ').toLowerCase().includes(search));
    $('#content').innerHTML=`<div class="section-toolbar"><span>${number(filtered.length)} people across both founders’ history</span><span>Click a name to see the full timeline</span></div><div class="table-wrap"><table class="people-table"><thead><tr><th>Person</th><th>Company / role</th><th>Relationship</th><th>Last touch</th><th>Touchpoints</th></tr></thead><tbody>${filtered.slice(0,500).map(p=>`<tr><td><button class="title-button" data-person="${p.person_id}">${esc(p.name)}</button><span class="sub">${esc(p.emails[0]||'')}</span></td><td>${esc(p.company||'—')}<span class="sub">${esc(p.position||'')}</span></td><td>${badge(p.relationship==='unknown'?'Not classified':p.relationship)}</td><td>${fmt(p.last_touch)}</td><td>${number(p.touchpoints)}</td></tr>`).join('')}</tbody></table></div>${data.people.length>=500?'<p class="pagination-note">Showing the first 500 people. Search to narrow the list.</p>':''}`;
    if(!filtered.length)$('#content').innerHTML='<p class="empty">No matching people.</p>';return;
  }
  let head='';
  if(selectedPerson){
    const p=data.people.find(p=>p.person_id===selectedPerson);
    if(p)head=`<div class="person-heading"><div>${personReturnCompany?`<button data-company="${esc(personReturnCompany)}">← Back to company</button>`:'<button data-back>← All people</button>'}<h2>${esc(p.name)}</h2><p>${esc([p.position,p.company].filter(Boolean).join(' / '))}</p><div class="person-meta">${badge(p.relationship==='unknown'?'Not classified':p.relationship)}${p.emails.map(e=>`<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('')}${p.profiles.map(v=>`<a href="${safeUrl(v.url)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>`).join('')}</div>${p.notes?`<p>${esc(p.notes)}</p>`:''}</div><button data-edit="${p.person_id}">Edit details</button></div><form class="note-form" id="note-form"><textarea name="note" placeholder="Add a note about this person…" required aria-label="Note"></textarea><button type="submit">Add note</button></form>`;
  }
  const rows=data.timeline;
  $('#content').innerHTML=head+(rows.length?`<div class="table-wrap"><table><thead><tr><th class="date-col">When</th><th class="type-col">Type</th><th>Touchpoint</th><th class="people-col">People</th><th class="owner-col">Founder</th></tr></thead><tbody>${rows.map(t=>timelineRow(t)).join('')}</tbody></table></div><p class="pagination-note">${rows.length===150?'Latest 150 results. Search to narrow your history.':number(rows.length)+' touchpoints shown'}</p>`:'<p class="empty">No touchpoints match these filters.</p>');
}
function timelineRow(t){
  const href=t.kind==='recording'?`/api/recording/${t.touchpoint_id}`:t.recording_link?`/api/recording/${t.recording_link}`:t.source_url?safeUrl(t.source_url):null;
  const label=t.kind==='note'?(t.body||t.title):t.title;
  const title=href?`<a class="title-button" href="${href}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:esc(label);
  const job=t.transcription_job_status;
  const transcribed=t.transcript_status==='complete';
  const transcriptStatus=job==='running'?(transcribed?'Transcribed / updating…':'Transcribing…'):job==='queued'?(transcribed?'Transcribed / update queued':'Transcript queued'):job==='failed'?(transcribed?'Transcribed / update failed':'Transcription failed'):transcribed?'Transcribed':t.transcript_status==='partial'?'Partial transcript':'';
  const transcript=t.kind==='recording'?`<span class="sub">${transcriptStatus} ${!['queued','running'].includes(job)?`<button class="person-link" data-transcribe="${t.touchpoint_id}">${t.transcript_status?'Transcribe again':'Transcribe'}</button>`:''}</span>`:'';
  const speakers=t.inferred_speakers?.length?`<span class="sub" title="Names inferred from conversation and context">${t.inferred_speakers.map(esc).join(', ')} (inferred)</span>`:'';
  const sales=t.sales_feedback_status==='complete'?`<span class="sub"><a href="/api/recording/${t.touchpoint_id}/sales-feedback" target="_blank" rel="noopener noreferrer">Sales feedback ↗</a></span>`:'';
  const message=t.kind==='message'&&t.body?`<details><summary>${esc(t.body.slice(0,140))}${t.body.length>140?'…':''}</summary><div class="message-text">${esc(t.body)}</div></details>`:'';
  const type=t.source==='imessage'?'iMessage':t.kind==='message'&&t.source.startsWith('linkedin')?'LinkedIn message':typeNames[t.kind]||t.kind;
  return `<tr><td>${fmt(t.occurred_at)}<span class="time">${new Date(t.occurred_at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</span></td><td>${esc(type)}</td><td>${title}${t.source_status?badge(t.source_status):''}<span class="sub">${t.kind==='recording'?[bytes(t.bytes),duration(t.duration_ms)].filter(Boolean).join(' / '):esc(t.classification||t.source.replaceAll('-',' '))}</span>${message}${transcript}${speakers}${sales}</td><td>${peopleLinks(t.people)}</td><td>${esc(t.owner_name||'Unknown')}</td></tr>`;
}
function companyHash(){const params=new URLSearchParams({list:savedList});if(selectedCompany)params.set('company',selectedCompany);return '#companies?'+params;}
async function changeView(next){view=next;selectedPerson=null;selectedCompany=null;personReturnCompany=null;query='';$('#search').value='';history.replaceState(null,'',next==='companies'?companyHash():'#'+next);await load();}
function openPerson(id){if(view==='companies')personReturnCompany=selectedCompany;query='';$('#search').value='';selectedPerson=id;selectedCompany=null;view='people';history.replaceState(null,'','#people');load();window.scrollTo({top:0,behavior:'smooth'});}
async function openCompany(id){selectedPerson=null;personReturnCompany=null;selectedCompany=id;view='companies';query='';$('#search').value='';history.replaceState(null,'',companyHash());await load();window.scrollTo({top:0,behavior:'smooth'});}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button,a');if(!b)return;
  try{
    if(b.dataset.transcribe){b.disabled=true;await api(`/api/recording/${b.dataset.transcribe}/transcribe`,{});notice('Transcription queued.');await load();return;}
    if(b.dataset.view){await changeView(b.dataset.view);return;}
    if(b.dataset.company){await openCompany(b.dataset.company);return;}
    if(b.hasAttribute('data-companies-back')){await changeView('companies');return;}
    if(b.dataset.companyLink){await api('/api/company/person',{companyId:selectedCompany,personId:b.dataset.companyLink,status:b.dataset.decision});await load();return;}
    if(b.dataset.person){openPerson(b.dataset.person);return;}
    if(b.hasAttribute('data-back')){selectedPerson=null;await changeView('people');return;}
    if(b.dataset.edit){
      const person=data.people.find(p=>p.person_id===b.dataset.edit),form=$('#person-form');
      for(const key of ['name','company','relationship','notes'])form.elements[key].value=person[key]||'';
      form.elements.id.value=person.person_id;form.elements.addEmail.value='';$('#merge-search').value=person.name.split(' ')[0];renderMergeOptions();$('#person-dialog').showModal();return;
    }
  }catch(error){notice(error.message);}finally{b.disabled=false;}
});
document.addEventListener('submit',async e=>{
  const form=e.target;e.preventDefault();const values=Object.fromEntries(new FormData(form));const button=form.querySelector('button[type=submit]');if(button)button.disabled=true;
  try{
    if(form.id==='person-form'){await api('/api/person',values);$('#person-dialog').close();}
    if(form.id==='note-form'){await api('/api/note',{personId:selectedPerson,body:values.note});}
    if(form.id==='company-form'){await api('/api/company',values);notice('Company saved.');}
    if(form.id==='company-person-form'){
      if(!values.personId)throw new Error('Choose a person to link');
      await api('/api/company/person',{companyId:selectedCompany,personId:values.personId,status:'confirmed'});
    }
    await load();
  }catch(error){notice(error.message);}finally{if(button)button.disabled=false;}
});
let mergeSearchSeq=0,mergeTimer;
async function renderMergeOptions(){
  const seq=++mergeSearchSeq,query=$('#merge-search').value,id=$('#person-form').elements.id.value;
  try{
    const matches=await api('/api/people?'+new URLSearchParams({search:query}));if(seq!==mergeSearchSeq)return;
    $('#merge-target').innerHTML='<option value="">Choose duplicate</option>'+matches.filter(p=>p.person_id!==id).map(p=>`<option value="${p.person_id}">${esc(p.name)}${p.company?' / '+esc(p.company):''}</option>`).join('');
  }catch(error){notice(error.message);}
}
$('#merge-search').oninput=()=>{clearTimeout(mergeTimer);mergeTimer=setTimeout(renderMergeOptions,300);};
$('#merge-person').onclick=async()=>{
  const fromId=$('#merge-target').value,toId=$('#person-form').elements.id.value;
  if(!fromId){notice('Choose the duplicate person first.');return;}
  const name=$('#merge-target').selectedOptions[0].textContent,target=data.people.find(p=>p.person_id===toId)?.name;
  if(!confirm(`Combine ${name} into ${target}? Both timelines and identities will be joined. Original source records remain intact.`))return;
  try{await api('/api/merge',{fromId,toId});$('#person-dialog').close();selectedPerson=toId;await load();}catch(error){notice(error.message);}
};
$('#close-dialog').onclick=()=>$('#person-dialog').close();
$('#sync').onclick=async()=>{try{await api('/api/sync',{});await load();}catch(e){notice(e.message);}};
$('#owner').onchange=()=>load();$('#kind').onchange=()=>load();
$('#company-list').onchange=()=>{savedList=$('#company-list').value;selectedCompany=null;$('#company-category').value='';history.replaceState(null,'',companyHash());load();};
$('#company-evidence').onchange=()=>load();$('#company-category').onchange=()=>load();
let companyPeopleTimer,companyPeopleSeq=0;
document.addEventListener('input',e=>{
  if(e.target.id!=='company-person-search')return;
  const seq=++companyPeopleSeq,companyAtRequest=selectedCompany,search=e.target.value;clearTimeout(companyPeopleTimer);
  const target=$('#company-person-target');target.innerHTML='<option value="">Choose a person</option>';
  if(!search.trim())return;
  companyPeopleTimer=setTimeout(async()=>{try{
    const matches=await api('/api/people?'+new URLSearchParams({search}));
    if(seq!==companyPeopleSeq||selectedCompany!==companyAtRequest||!target.isConnected)return;
    target.innerHTML='<option value="">Choose a person</option>'+matches.map(p=>`<option value="${esc(p.person_id)}">${esc(p.name)}${p.company?' / '+esc(p.company):''}</option>`).join('');
  }catch(error){notice(error.message);}},300);
});
let timer;$('#search').oninput=e=>{query=e.target.value;if(view==='companies'&&selectedCompany){selectedCompany=null;history.replaceState(null,'',companyHash());}clearTimeout(timer);timer=setTimeout(()=>load(),300);};
function readRoute(){const [v,raw='']=location.hash.slice(1).split('?');view=views.includes(v)?v:'timeline';const params=new URLSearchParams(raw);selectedCompany=view==='companies'?params.get('company'):null;savedList=params.get('list')||savedList;selectedPerson=null;personReturnCompany=null;}
window.addEventListener('hashchange',()=>{readRoute();load();});
readRoute();if(!views.includes(location.hash.slice(1).split('?')[0]))history.replaceState(null,'','#timeline');
load();setInterval(()=>{if(!$('#person-dialog').open&&!document.activeElement?.closest('form')&&document.visibilityState==='visible')load({silent:true});},20000);
