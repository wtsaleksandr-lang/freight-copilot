(function installAiRoutingUi(){
'use strict';
const esc=(value)=>{const d=document.createElement('div');d.textContent=String(value??'');return d.innerHTML;};
const modeIcon={default:'●',power:'◆',ultimate:'▲',custom:'⚙'};
let state=null;

function findHost(){
  const headings=[...document.querySelectorAll('h1,h2,h3,strong,label')];
  const heading=headings.find((el)=>/AI mode/i.test(el.textContent||''));
  if(!heading)return null;
  return heading.closest('.card,section,fieldset,div')||heading.parentElement;
}

function roleLine(role){
  const tags=(role.requiredCapabilities||[]).map((x)=>`<span class="ai-cap">${esc(x)}</span>`).join('');
  return `<li><div><strong>${esc(role.model)}</strong><span>${esc(role.provider)} · ${esc(role.purpose)}</span></div><div>${tags}${role.fallback?'<span class="ai-cap muted-cap">fallback</span>':''}</div></li>`;
}

function profileCard(profile,activeMode){
  const active=profile.mode===activeMode;
  const price=profile.monthlyTargetUsd?`Target ≤ $${profile.monthlyTargetUsd}/month`:`Limit $${profile.maxTaskCostUsd}/task`;
  return `<button type="button" class="ai-mode-card${active?' active':''}" data-ai-mode="${esc(profile.mode)}" aria-pressed="${active}">
    <span class="ai-mode-card-head"><span class="ai-mode-icon">${modeIcon[profile.mode]||'●'}</span><strong>${esc(profile.label)}</strong><span class="ai-cost ai-cost-${esc(profile.relativeCost)}">${esc(profile.relativeCost)}</span></span>
    <span class="ai-mode-summary">${esc(profile.summary)}</span>
    <span class="ai-mode-for">${esc(profile.recommendedFor)}</span>
    <span class="ai-mode-meta">${esc(price)} · Web: ${esc(profile.webPolicy)} · Cache: ${profile.promptCaching?'on':'off'}</span>
  </button>`;
}

function render(){
  const host=findHost();
  if(!host||!state)return;
  const active=state.active;
  const presets=[...state.presets];
  if(active.mode==='custom')presets.push(active);
  host.classList.add('ai-control-center');
  host.innerHTML=`<div class="ai-control-head"><div><h2>AI work mode</h2><p>Choose how much reasoning, cross-checking and cost to use. The app routes each step to the appropriate specialist.</p></div><span class="ai-active-pill">Active: ${esc(active.label)}</span></div>
    <div class="ai-mode-grid">${presets.map((p)=>profileCard(p,active.mode)).join('')}<button type="button" class="ai-mode-card${active.mode==='custom'?' active':''}" data-ai-mode="custom" aria-pressed="${active.mode==='custom'}"><span class="ai-mode-card-head"><span class="ai-mode-icon">⚙</span><strong>Custom</strong><span class="ai-cost">manual</span></span><span class="ai-mode-summary">Select every provider, model, tool and spending limit.</span><span class="ai-mode-for">Experiments and special workflows.</span><span class="ai-mode-meta">Full control</span></button></div>
    <div class="ai-route-summary"><div><h3>Routing plan</h3><p>${esc(active.summary)}</p></div><div class="ai-safety"><span>Web research: <strong>${esc(active.webPolicy)}</strong></span><span>Prompt caching: <strong>${active.promptCaching?'Enabled':'Disabled'}</strong></span><span>Approval: <strong>${active.requireHumanApproval?'Required':'Routine tasks automatic'}</strong></span><span>Max task spend: <strong>$${Number(active.maxTaskCostUsd).toFixed(2)}</strong></span></div></div>
    <details class="ai-model-details"><summary>Models and responsibilities</summary><ul>${active.roles.map(roleLine).join('')}</ul></details>
    <div class="ai-control-actions"><button type="button" class="primary" id="ai-routing-save">Save mode</button><button type="button" class="btn-sm" id="ai-routing-test">Preview task plan</button><span id="ai-routing-status" class="status-inline"></span></div>`;
  host.querySelectorAll('[data-ai-mode]').forEach((button)=>button.addEventListener('click',()=>selectMode(button.dataset.aiMode)));
  host.querySelector('#ai-routing-save')?.addEventListener('click',save);
  host.querySelector('#ai-routing-test')?.addEventListener('click',preview);
}

function selectMode(mode){
  if(mode==='custom'){
    const base=structuredClone(state.active);
    base.mode='custom';base.label='Custom';base.summary='Manually configured routing profile.';base.recommendedFor='Special tasks and provider experiments.';
    const max=prompt('Maximum cost per task in USD',String(base.maxTaskCostUsd));
    if(max===null)return;
    base.maxTaskCostUsd=Math.max(.01,Math.min(100,Number(max)||base.maxTaskCostUsd));
    state.active=base;
  }else{
    const preset=state.presets.find((p)=>p.mode===mode);
    if(preset)state.active=structuredClone(preset);
  }
  render();
}

async function save(){
  const status=document.getElementById('ai-routing-status');
  if(status)status.textContent='Saving…';
  try{
    const response=await fetch('/api/ai-routing',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(state.active)});
    const body=await response.json();
    if(!response.ok)throw new Error(body.error||'Could not save AI mode');
    state.active=body.profile;
    if(status)status.textContent='Saved';
    document.dispatchEvent(new CustomEvent('ai-routing-updated',{detail:state.active}));
    render();
  }catch(error){if(status)status.textContent=error instanceof Error?error.message:String(error);}
}

async function preview(){
  const status=document.getElementById('ai-routing-status');
  try{
    const response=await fetch('/api/ai-routing/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'complex freight quote',hasImages:true,requiresFreshData:true,highStakes:state.active.mode==='ultimate'})});
    const plan=await response.json();
    if(!response.ok)throw new Error(plan.error||'Could not build plan');
    const lines=(plan.steps||[]).map((s)=>`${s.order}. ${s.model} — ${s.purpose}`).join('\n');
    alert(`Mode: ${plan.mode}\nWeb research: ${plan.webResearch?'yes':'no'}\nParallel analysis: ${plan.parallel?'yes':'no'}\nApproval required: ${plan.humanApprovalRequired?'yes':'no'}\n\n${lines}`);
    if(status)status.textContent='Plan verified';
  }catch(error){if(status)status.textContent=error instanceof Error?error.message:String(error);}
}

async function boot(){
  try{
    const response=await fetch('/api/ai-routing',{cache:'no-store'});
    if(!response.ok)throw new Error('AI routing settings unavailable');
    state=await response.json();
    render();
    new MutationObserver(()=>{if(state&&!document.querySelector('.ai-control-center'))render();}).observe(document.body,{childList:true,subtree:true});
  }catch(error){console.warn('[ai-routing-ui]',error);}
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else void boot();
})();
