(function installClientQuoteActions(){
'use strict';
const configs={
 ocean:{card:'sheet-results-card',label:'Create client quote'},
 drayage:{card:'dr-result-card',label:'Create client quote'},
 trucking:{card:'tr-result-card',label:'Create client quote'},
};
function extractRef(payload){return payload?.refId||payload?.quote?.refId||payload?.upload?.refId||payload?.request?.refId||payload?.data?.refId||null;}
function open(type,refId){document.dispatchEvent(new CustomEvent('client-quote-open',{detail:{type,refId}}));}
function addAction(type,refId){const cfg=configs[type];const card=document.getElementById(cfg.card);if(!card||!refId)return;let button=card.querySelector('[data-client-quote-action]');if(!button){button=document.createElement('button');button.type='button';button.className='btn-sm';button.dataset.clientQuoteAction='true';button.textContent=cfg.label;const header=card.querySelector('.card-header')||card.querySelector('h2')?.parentElement||card;header.appendChild(button);}button.dataset.quoteType=type;button.dataset.quoteRef=refId;button.onclick=()=>open(type,refId);card.hidden=false;}
function detect(url,method){const value=String(url||'');if(value.includes('/api/sheets/')||value.includes('/api/sheet'))return 'ocean';if(value.includes('/api/drayage/'))return 'drayage';if(value.includes('/api/trucking/'))return 'trucking';return null;}
const originalFetch=window.fetch.bind(window);
window.fetch=async function clientQuoteAwareFetch(input,init){const response=await originalFetch(input,init);try{const url=typeof input==='string'?input:input?.url||'';const type=detect(url,String(init?.method||'GET').toUpperCase());if(type&&response.ok){const payload=await response.clone().json();const refId=extractRef(payload);if(refId)setTimeout(()=>addAction(type,refId),0);}}catch(error){console.warn('[client-quote-actions-ui] could not add action:',error);}return response;};
document.addEventListener('quote-result-ready',(event)=>{const type=event.detail?.type;const refId=event.detail?.refId;if(configs[type]&&refId)addAction(type,refId);});
})();
