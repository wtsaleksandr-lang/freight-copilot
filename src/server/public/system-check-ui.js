(function installSystemCheckUi(){
'use strict';
const LABELS={ready:'Working',review_required:'Working — verify output',setup_required:'Action needed',experimental:'Experimental',unavailable:'Unavailable'};
const PRIORITY={unavailable:0,setup_required:1,review_required:2,experimental:3,ready:4};
function esc(value){const div=document.createElement('div');div.textContent=String(value??'');return div.innerHTML;}
function close(){document.getElementById('system-check-dialog')?.remove();}
function badge(state){return `<span class="feature-state feature-state-${esc(state)}">${esc(LABELS[state]||state)}</span>`;}
function card(feature){return `<article class="feature-readiness-row"><div class="feature-readiness-main"><strong>${esc(feature.name)}</strong><p>${esc(feature.summary)}</p>${feature.action?`<small>${esc(feature.action)}</small>`:''}</div>${badge(feature.state)}</article>`;}
function grouped(features){
  const groups=new Map();
  for(const feature of features){const area=feature.area||'Other';if(!groups.has(area))groups.set(area,[]);groups.get(area).push(feature);}
  return Array.from(groups.entries()).map(([area,items])=>`<section class="feature-readiness-group"><h4>${esc(area)}</h4><div class="feature-readiness-list">${items.map(card).join('')}</div></section>`).join('');
}
function section(title,description,features,open=true){
  if(!features.length)return '';
  return `<details class="readiness-section" ${open?'open':''}><summary><span><strong>${esc(title)}</strong><small>${esc(description)}</small></span><b>${features.length}</b></summary><div class="readiness-section-body">${grouped(features)}</div></details>`;
}
function configValue(configuration,key,yes,no){if(!configuration||typeof configuration[key]!=='boolean')return 'Not checked';return configuration[key]?yes:no;}
function summary(result,features){
  const blockers=features.filter((f)=>f.state==='unavailable').length;
  const actions=features.filter((f)=>f.state==='setup_required').length;
  const reviews=features.filter((f)=>f.state==='review_required').length;
  const healthy=features.filter((f)=>f.state==='ready').length;
  const operational=result.database==='connected'&&blockers===0;
  const title=operational?'System operational':blockers?'Core features need attention':'System operational with setup items';
  const tone=operational?'ok':blockers?'danger':'warning';
  return `<div class="readiness-overview readiness-overview-${tone}"><div><span class="readiness-eyebrow">Current status</span><h3>${esc(title)}</h3><p>Database ${esc(result.database)} · ${esc(result.latencyMs)} ms · checked ${esc(new Date(result.checkedAt||Date.now()).toLocaleString())}</p>${result.error?`<p class="error">${esc(result.error)}</p>`:''}${result.action?`<p><strong>Next step:</strong> ${esc(result.action)}</p>`:''}</div><div class="readiness-metrics"><span><b>${blockers}</b> blocked</span><span><b>${actions}</b> actions</span><span><b>${reviews}</b> verify</span><span><b>${healthy}</b> working</span></div></div>`;
}
async function open(){
  close();
  const previous=document.activeElement;
  const backdrop=document.createElement('div');backdrop.id='system-check-dialog';backdrop.className='simple-dialog-backdrop';
  backdrop.innerHTML=`<section class="simple-dialog system-readiness-dialog readiness-v2" role="dialog" aria-modal="true" aria-labelledby="system-check-title"><div class="simple-dialog-head"><div><h2 id="system-check-title">System readiness</h2><p>Problems first, then items requiring review, optional tools and healthy features.</p></div><button type="button" class="simple-dialog-close" aria-label="Close">×</button></div><div id="system-check-result" class="system-check-result">Checking…</div><div class="row system-check-actions"><button type="button" id="system-check-again" class="btn-sm">Run checks again</button><button type="button" id="system-check-close" class="btn-sm">Close</button></div></section>`;
  document.body.appendChild(backdrop);
  const finish=()=>{close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  backdrop.querySelector('.simple-dialog-close').addEventListener('click',finish);backdrop.querySelector('#system-check-close').addEventListener('click',finish);backdrop.addEventListener('click',(event)=>{if(event.target===backdrop)finish();});backdrop.addEventListener('keydown',(event)=>{if(event.key==='Escape'){event.preventDefault();finish();}});backdrop.querySelector('#system-check-again').addEventListener('click',run);backdrop.querySelector('.simple-dialog-close').focus();await run();
}
const GROUP_META={critical:{t:'Critical action required',c:'#dc2626'},setup:{t:'Setup required',c:'#d97706'},verify:{t:'Working — verify before sending',c:'#2563eb'},operational:{t:'Operational',c:'#16a34a'},optional:{t:'Optional integrations',c:'#6b7280'},experimental:{t:'Experimental',c:'#7c3aed'}};
const PROV_STATE={stored_usable:'Stored securely',env_fallback:'Environment fallback',stored_locked:'Stored but locked',missing:'Missing'};
function priorityBlock(result){
  if(!Array.isArray(result.statusGroups))return '';
  const groups=result.statusGroups.filter((g)=>g.items&&g.items.length).map((g)=>{const m=GROUP_META[g.group]||{t:g.group,c:'#6b7280'};const items=g.items.map((it)=>`<li><strong>${esc(it.name)}</strong> — ${esc(it.detail)}${it.action?`<br><small>${esc(it.action)}</small>`:''}</li>`).join('');return `<section class="readiness-group readiness-group-${esc(g.group)}" data-group="${esc(g.group)}" style="border-left:4px solid ${m.c};padding-left:10px;margin:8px 0"><h4 style="color:${m.c};margin:.2em 0">${esc(m.t)} <b>(${g.items.length})</b></h4><ul style="margin:.2em 0">${items}</ul></section>`;}).join('');
  const mk=result.secretsKey?`<p class="muted small" data-secrets-key>Encryption master key: ${result.secretsKey.configured?'configured':'not configured'}${result.secretsKey.productionSafe?'':' — REQUIRED in production'}. SESSION_SECRET is separate.</p>`:'';
  const provs=Array.isArray(result.providers)?`<p class="muted small" data-providers>Providers — ${result.providers.map((p)=>`${esc(p.provider)}: ${esc(PROV_STATE[p.state]||p.state)}`).join(' · ')}</p>`:'';
  const dbi=result.databaseInfo?`<p class="muted small" data-db-info>Database: ${esc(result.databaseInfo.hostCategory)}${result.databaseInfo.databaseName?` (${esc(result.databaseInfo.databaseName)})`:''}${result.databaseInfo.databaseChanged?' — ⚠ differs from first-seen database; copying development to production would overwrite production data':''}</p>`:'';
  return `<div class="readiness-priority">${groups}${mk}${provs}${dbi}</div>`;
}
async function run(){
  const target=document.getElementById('system-check-result');if(!target)return;target.textContent='Checking application readiness…';
  try{
    const response=await fetch('/api/health/ready',{cache:'no-store'});const result=await response.json();const features=(Array.isArray(result.features)?result.features:[]).sort((a,b)=>(PRIORITY[a.state]??9)-(PRIORITY[b.state]??9));
    const blocked=features.filter((f)=>f.state==='unavailable');const actions=features.filter((f)=>f.state==='setup_required');const review=features.filter((f)=>f.state==='review_required');const experimental=features.filter((f)=>f.state==='experimental');const ready=features.filter((f)=>f.state==='ready');
    const tables=result.tables?Object.entries(result.tables).map(([name,ok])=>`<li class="${ok?'':'readiness-table-missing'}"><span>${esc(name.replaceAll('_',' '))}</span><strong>${ok?'Working':'Missing'}</strong></li>`).join(''):'';const config=result.configuration;const provider=config?.aiProvider?esc(config.aiProvider):'Not checked';
    target.innerHTML=`${summary(result,features)}${priorityBlock(result)}${section('Needs immediate attention','Core features that are blocked or missing required data.',blocked,true)}${section('Setup actions','Configuration needed to enable additional capabilities.',actions,true)}${section('Working — verify before sending','The workflow runs, but freight, customs and commercial output needs human approval.',review,true)}${section('Optional and experimental','Useful integrations that do not determine core-system health.',experimental,false)}${section('Working normally','Healthy features; collapsed to reduce visual noise.',ready,false)}<div class="readiness-foundations"><div><h3>Data foundations</h3>${tables?`<ul class="readiness-table-list">${tables}</ul>`:'<p class="muted">Database tables could not be checked. This does not mean they were deleted.</p>'}</div><div><h3>Security and integrations</h3><p class="muted small">Secret values are never displayed.</p><ul class="readiness-table-list"><li><span>AI provider</span><strong>${provider}</strong></li><li><span>AI key</span><strong>${configValue(config,'aiConfigured','Configured','Missing')}</strong></li><li><span>Browser automation</span><strong>${configValue(config,'realChrome','Enabled','Optional — off')}</strong></li><li><span>DelayPredict</span><strong>${configValue(config,'delayPredict','Connected','Optional — off')}</strong></li><li><span>Dashboard login</span><strong>${configValue(config,'basicAuth','Enabled','Missing')}</strong></li></ul></div></div>`;
    document.dispatchEvent(new CustomEvent('system-readiness-updated',{detail:result}));
  }catch(error){target.innerHTML=`<div class="universal-rate-result"><strong>Readiness check unavailable</strong><p>${esc(error instanceof Error?error.message:String(error))}</p><p>No credential or database deletion was performed.</p></div>`;document.dispatchEvent(new CustomEvent('system-readiness-updated',{detail:{status:'unavailable'}}));}
}
document.addEventListener('system-check-open',open);window.runSystemReadinessCheck=run;
})();
