import type { Express, Request, Response } from 'express';
import { loadEnv } from '../config.js';
import { getPostgresPool } from '../db/client.js';
import { ensureShipmentOperationTables } from '../db/shipmentOperations.js';
import { getAiRoutingProfile } from './aiRoutingService.js';
import { listConfiguredAiProviders } from './aiProviderKeys.js';

const REQUIRED_TABLES=['shipments','quote_bundles','drayage_quotes','trucking_quotes','shipment_containers','shipment_follow_ups'] as const;
type FeatureState='ready'|'review_required'|'setup_required'|'experimental'|'unavailable';
type FeatureReadiness={id:string;name:string;area:string;state:FeatureState;summary:string;action?:string};

function conciseDatabaseError(error:unknown){const raw=error instanceof Error?error.message:String(error);return{code:'database_unavailable',message:'The application database could not be reached. Configuration checks remain valid, but database-backed features could not be verified.',action:`Verify the Replit PostgreSQL connection and run the readiness check again. ${raw.slice(0,180)}`};}
function featureReadiness(tables:Record<string,boolean>,env:ReturnType<typeof loadEnv>,providers:string[],databaseAvailable=true):FeatureReadiness[]{
 const aiConfigured=providers.length>0;const databaseAction=databaseAvailable?'Run the schema repair or deployment migration.':'Restore database access, then check again.';
 return[
 {id:'shipments',name:'Shipment workspace',area:'Core operations',state:tables.shipments?'ready':'unavailable',summary:'Editable shipment board, document uploads, notes and history.',action:tables.shipments?undefined:databaseAction},
 {id:'shipment-operations',name:'Containers, milestones and follow-ups',area:'Core operations',state:tables.shipment_containers&&tables.shipment_follow_ups?'ready':'unavailable',summary:'Container-level tracking, reminders and operational notes.',action:tables.shipment_containers&&tables.shipment_follow_ups?undefined:databaseAction},
 {id:'shipment-ai-intake',name:'Shipment document extraction',area:'AI-assisted work',state:aiConfigured?'review_required':'unavailable',summary:'Reads PDFs, screenshots and email files into shipment fields.',action:aiConfigured?'Verify extracted fields before accepting them.':'Add at least one AI provider key in Secrets.'},
 {id:'ocean-sheets',name:'Routed ocean rate-sheet analysis',area:'AI-assisted work',state:aiConfigured?'review_required':'unavailable',summary:'Uses the active AI mode, provider fallback and budget controls to extract lanes and charges.',action:aiConfigured?'Verify lane, equipment, validity, disagreements and totals.':'Add at least one AI provider key in Secrets.'},
 {id:'drayage',name:'Drayage quote workspace',area:'Quotation tools',state:tables.drayage_quotes?'review_required':'unavailable',summary:'Stores provider quotes and compares historical lanes.',action:tables.drayage_quotes?'Confirm rates and accessorials with the provider.':databaseAction},
 {id:'trucking',name:'Regular trucking quotes',area:'Quotation tools',state:tables.trucking_quotes?'review_required':'unavailable',summary:'Stores and compares FTL and LTL pricing.',action:tables.trucking_quotes?'Confirm equipment, validity and accessorials.':databaseAction},
 {id:'customs',name:'Customs clearance quote builder',area:'Quotation tools',state:'review_required',summary:'Builds USA import, Canada import and export-clearance quotations.',action:'Verify classification, statutory charges, duties and taxes.'},
 {id:'client-quotes',name:'Client quote preview and PDF',area:'Quotation tools',state:'ready',summary:'Creates customer-facing previews while keeping markup internal.'},
 {id:'ai-routing',name:'Shared multi-provider AI executor',area:'AI system',state:aiConfigured?'ready':'setup_required',summary:`Executable providers: ${providers.join(', ')||'none'}. Applies mode routing, fallbacks, parallel Ultimate analysis and estimated spending limits.`,action:aiConfigured?undefined:'Add provider keys to enable model routing.'},
 {id:'ocean-live',name:'Carrier portal browser automation',area:'Optional integrations',state:'experimental',summary:'Runs recorded browser workflows against carrier websites.',action:env.USE_REAL_CHROME?'Verify every result because carrier sites can change.':'Optional: enable real Chrome and create carrier sessions.'},
 {id:'tracking',name:'DelayPredict tracking',area:'Optional integrations',state:env.DELAYPREDICT_URL?'ready':'experimental',summary:'Adds external prediction data to shipment rows.',action:env.DELAYPREDICT_URL?undefined:'Optional: connect a DelayPredict service URL.'},
 {id:'scheduled-agents',name:'Scheduled AI agents',area:'Optional integrations',state:aiConfigured?'experimental':'setup_required',summary:'Runs configured background automation tasks.',action:aiConfigured?'Review unattended outputs regularly.':'Add an AI provider key before enabling agents.'},
 {id:'security',name:'Dashboard login protection',area:'Security',state:env.BASIC_AUTH_USER&&env.BASIC_AUTH_PASS?'ready':'setup_required',summary:'Protects the deployed dashboard with HTTP Basic authentication.',action:env.BASIC_AUTH_USER&&env.BASIC_AUTH_PASS?undefined:'Set BASIC_AUTH_USER and BASIC_AUTH_PASS.'},
 ];
}

export function registerRuntimeHealthRoute(app:Express):void{
 app.get('/api/health/ready',async(_req:Request,res:Response)=>{const started=Date.now();const env=loadEnv();try{
   await ensureShipmentOperationTables();const pool=getPostgresPool();
   const [tableResult,profile,providers]=await Promise.all([
    pool.query(`SELECT to_regclass('public.shipments')::text AS shipments,to_regclass('public.quote_bundles')::text AS quote_bundles,to_regclass('public.drayage_quotes')::text AS drayage_quotes,to_regclass('public.trucking_quotes')::text AS trucking_quotes,to_regclass('public.shipment_containers')::text AS shipment_containers,to_regclass('public.shipment_follow_ups')::text AS shipment_follow_ups`),
    getAiRoutingProfile(),listConfiguredAiProviders(),
   ]);
   const row=(tableResult.rows[0]??{}) as Record<string,string|null>;const tables=Object.fromEntries(REQUIRED_TABLES.map((name)=>[name,Boolean(row[name])]));const aiConfigured=providers.length>0;const missingTables=REQUIRED_TABLES.filter((name)=>!tables[name]);const ready=missingTables.length===0&&aiConfigured;
   res.status(ready?200:503).json({status:ready?'ready':'degraded',database:'connected',databaseDriver:'postgres',latencyMs:Date.now()-started,tables,missingTables,features:featureReadiness(tables,env,providers),configuration:{source:'encrypted app secrets and environment fallback',aiProvider:profile.mode,aiMode:profile.label,aiConfigured,configuredProviders:providers,sharedExecutor:true,webPolicy:profile.webPolicy,promptCaching:profile.promptCaching,maxTaskCostUsd:profile.maxTaskCostUsd,realChrome:env.USE_REAL_CHROME,delayPredict:Boolean(env.DELAYPREDICT_URL),basicAuth:Boolean(env.BASIC_AUTH_USER&&env.BASIC_AUTH_PASS)},checkedAt:new Date().toISOString()});
  }catch(error){const databaseError=conciseDatabaseError(error);const tables=Object.fromEntries(REQUIRED_TABLES.map((name)=>[name,false]));const providers=(await listConfiguredAiProviders().catch(()=>[]));res.status(503).json({status:'unavailable',database:'unavailable',databaseDriver:'postgres',latencyMs:Date.now()-started,tables:null,missingTables:[],features:featureReadiness(tables,env,providers,false),configuration:{source:'environment fallback',aiProvider:env.AI_PROVIDER,aiConfigured:providers.length>0,configuredProviders:providers,sharedExecutor:true,realChrome:env.USE_REAL_CHROME,delayPredict:Boolean(env.DELAYPREDICT_URL),basicAuth:Boolean(env.BASIC_AUTH_USER&&env.BASIC_AUTH_PASS)},errorCode:databaseError.code,error:databaseError.message,action:databaseError.action,checkedAt:new Date().toISOString()});}
 });
}
