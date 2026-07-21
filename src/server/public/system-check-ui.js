(function installSystemCheckUi(){
'use strict';
const LABELS={ready:'Ready',review_required:'Ready · review required',setup_required:'Setup required',experimental:'Experimental',unavailable:'Unavailable'};
function esc(value){const div=document.createElement('div');div.textContent=String(value??'');return div.innerHTML;}
function close(){document.getElementById('system-check-dialog')?.remove();}
function badge(state){return `<span class="feature-state feature-state-${esc(state)}">${esc(LABELS[state]||state)}</span>`;}
function featureRows(features){
  if(!Array.isArray(features)||features.length===0)return '<p class="muted">No feature readiness information was returned.</p>';
  const groups=new Map();
  for(const feature of features){const area=feature.area||'Other';if(!groups.has(area))groups.set(area,[]);groups.get(area).push(feature);}
  return Array.from(groups.entries()).map(([area,items])=>`<section class="feature-readiness-group"><h3>${esc(area)}</h3><div class="feature-readiness-list">${items.map((feature)=>`<article class="feature-readiness-row"><div class="feature-readiness-main"><strong>${esc(feature.name)}</strong><p>${esc(feature.summary)}</p>${feature.action?`<small>${esc(feature.action)}</small>`:''}</div>${badge(feature.state)}</article>`).join('')}</div></section>`).join('');
}
function summary(result){
  const features=Array.isArray(result.features)?result.features:[];
  const counts=features.reduce((acc,item)=>{acc[item.state]=(acc[item.state]||0)+1;return acc;},{});
  const action=result.action?`<p><strong>Required action:</strong> ${esc(result.action)}</p>`:'';
  return `<div class="system-readiness-summary"><div><strong>${result.status==='ready'?'Core system ready':'Core system needs attention'}</strong><p>Database: ${esc(result.database)} · ${esc(result.latencyMs)} ms · checked ${esc(new Date(result.checkedAt||Date.now()).toLocaleString())}</p>${result.error?`<p class="error">${esc(result.error)}</p>`:''}${action}</div><div class="system-readiness-counts"><span>${counts.ready||0} ready</span><span>${counts.review_required||0} review</span><span>${counts.setup_required||0} setup</span><span>${counts.experimental||0} experimental</span></div></div>`;
}
function configValue(configuration,key,yes,no){
  if(!configuration||typeof configuration[key]!=='boolean')return 'Not checked';
  return configuration[key]?yes:no;
}
async function open(){
  close();
  const previous=document.activeElement;
  const backdrop=document.createElement('div');
  backdrop.id='system-check-dialog';
  backdrop.className='simple-dialog-backdrop';
  backdrop.innerHTML=`<section class="simple-dialog system-readiness-dialog" role="dialog" aria-modal="true" aria-labelledby="system-check-title"><div class="simple-dialog-head"><div><h2 id="system-check-title">Feature readiness</h2><p>Shows what is operational, what requires review, and what still needs configuration.</p></div><button type="button" class="simple-dialog-close" aria-label="Close">×</button></div><div class="readiness-legend"><span>${badge('ready')} dependable workflow</span><span>${badge('review_required')} human verification required</span><span>${badge('setup_required')} configuration missing</span><span>${badge('experimental')} may break when external sites change</span></div><div id="system-check-result" class="system-check-result">Checking…</div><div class="row system-check-actions"><button type="button" id="system-check-again" class="btn-sm">Run checks again</button><button type="button" id="system-check-close" class="btn-sm">Close</button></div></section>`;
  document.body.appendChild(backdrop);
  const finish=()=>{close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  backdrop.querySelector('.simple-dialog-close').addEventListener('click',finish);
  backdrop.querySelector('#system-check-close').addEventListener('click',finish);
  backdrop.addEventListener('click',(event)=>{if(event.target===backdrop)finish();});
  backdrop.addEventListener('keydown',(event)=>{if(event.key==='Escape'){event.preventDefault();finish();}});
  backdrop.querySelector('#system-check-again').addEventListener('click',run);
  backdrop.querySelector('.simple-dialog-close').focus();
  await run();
}
async function run(){
  const target=document.getElementById('system-check-result');
  if(!target)return;
  target.textContent='Checking application readiness…';
  try{
    const response=await fetch('/api/health/ready',{cache:'no-store'});
    const result=await response.json();
    const tableRows=result.tables?Object.entries(result.tables).map(([name,ok])=>`<li><span>${esc(name.replaceAll('_',' '))}</span><strong>${ok?'Ready':'Missing'}</strong></li>`).join(''):'';
    const config=result.configuration;
    const provider=config?.aiProvider?esc(config.aiProvider):'Not checked';
    target.innerHTML=`${summary(result)}<div class="system-readiness-layout"><div><h3>Feature audit</h3>${featureRows(result.features)}</div><aside><h3>Database foundations</h3>${tableRows?`<ul class="readiness-table-list">${tableRows}</ul>`:'<p class="muted">Database tables could not be checked. This does not mean they were deleted.</p>'}<h3>Configuration</h3><p class="muted small">Configuration status is checked separately from the database. Secret values are never displayed.</p><ul class="readiness-table-list"><li><span>AI provider</span><strong>${provider}</strong></li><li><span>AI key</span><strong>${configValue(config,'aiConfigured','Configured','Missing')}</strong></li><li><span>Real Chrome</span><strong>${configValue(config,'realChrome','Enabled','Disabled')}</strong></li><li><span>DelayPredict</span><strong>${configValue(config,'delayPredict','Connected','Not connected')}</strong></li><li><span>Basic authentication</span><strong>${configValue(config,'basicAuth','Enabled','Missing')}</strong></li></ul></aside></div>`;
    document.dispatchEvent(new CustomEvent('system-readiness-updated',{detail:result}));
  }catch(error){
    target.innerHTML=`<div class="universal-rate-result"><strong>Readiness check unavailable</strong><p>${esc(error instanceof Error?error.message:String(error))}</p><p>No credential or database deletion was performed.</p></div>`;
    document.dispatchEvent(new CustomEvent('system-readiness-updated',{detail:{status:'unavailable'}}));
  }
}
document.addEventListener('system-check-open',open);
window.runSystemReadinessCheck=run;
})();
