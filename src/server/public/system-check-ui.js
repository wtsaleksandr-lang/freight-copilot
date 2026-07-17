(function installSystemCheckUi(){
'use strict';
function esc(value){const div=document.createElement('div');div.textContent=String(value??'');return div.innerHTML;}
function close(){document.getElementById('system-check-dialog')?.remove();}
async function open(){
  close();
  const backdrop=document.createElement('div');
  backdrop.id='system-check-dialog';
  backdrop.className='simple-dialog-backdrop';
  backdrop.innerHTML=`<section class="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="system-check-title"><div class="simple-dialog-head"><div><h2 id="system-check-title">System check</h2><p>Verifies the live database and required application tables.</p></div><button type="button" class="simple-dialog-close" aria-label="Close">×</button></div><div id="system-check-result" style="margin-top:18px">Checking…</div><div class="row" style="margin-top:16px"><button type="button" id="system-check-again" class="btn-sm">Check again</button></div></section>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('.simple-dialog-close').addEventListener('click',close);
  backdrop.addEventListener('click',(event)=>{if(event.target===backdrop)close();});
  backdrop.querySelector('#system-check-again').addEventListener('click',run);
  await run();
}
async function run(){
  const target=document.getElementById('system-check-result');
  if(!target)return;
  target.textContent='Checking…';
  try{
    const response=await fetch('/api/health/ready',{cache:'no-store'});
    const result=await response.json();
    const tableRows=result.tables?Object.entries(result.tables).map(([name,ok])=>`<li><span>${esc(name)}</span><strong>${ok?'Ready':'Missing'}</strong></li>`).join(''):'';
    target.innerHTML=`<div class="universal-rate-result"><strong>${result.status==='ready'?'Ready':'Needs attention'}</strong><p>Database: ${esc(result.database)} · ${esc(result.latencyMs)} ms</p>${result.error?`<p>${esc(result.error)}</p>`:''}</div>${tableRows?`<ul class="ship-pending-files">${tableRows}</ul>`:''}`;
  }catch(error){target.innerHTML=`<div class="universal-rate-result"><strong>Unavailable</strong><p>${esc(error instanceof Error?error.message:String(error))}</p></div>`;}
}
document.addEventListener('system-check-open',open);
})();
