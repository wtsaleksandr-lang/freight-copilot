import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { appSettings } from '../db/schema.js';

export type AiMode = 'default' | 'power' | 'ultimate' | 'custom';
export type WebPolicy = 'automatic' | 'always' | 'never';
export type AiCapability = 'text' | 'vision' | 'web' | 'tools' | 'reasoning';

export type ModelRole = {
  provider: 'gemini' | 'anthropic' | 'xai' | 'openai' | 'deepseek';
  model: string;
  purpose: string;
  requiredCapabilities: AiCapability[];
  parallelGroup?: string;
  fallback?: boolean;
};

export type AiRoutingProfile = {
  mode: AiMode;
  label: string;
  summary: string;
  recommendedFor: string;
  relativeCost: 'lowest' | 'moderate' | 'high';
  monthlyTargetUsd?: number;
  maxTaskCostUsd: number;
  webPolicy: WebPolicy;
  promptCaching: boolean;
  requireHumanApproval: boolean;
  roles: ModelRole[];
};

const PRESETS: Record<Exclude<AiMode, 'custom'>, AiRoutingProfile> = {
  default: { mode:'default',label:'Everyday',summary:'Fast, capable routing for daily shipment work and routine quotes.',recommendedFor:'Document extraction, shipment updates, email drafting, rate calculations and routine web checks.',relativeCost:'lowest',monthlyTargetUsd:5,maxTaskCostUsd:.05,webPolicy:'automatic',promptCaching:true,requireHumanApproval:false,roles:[
    {provider:'gemini',model:'gemini-2.5-flash',purpose:'Primary document, image and screenshot extraction',requiredCapabilities:['text','vision','tools']},
    {provider:'xai',model:'grok-4.3',purpose:'Routine agent, web research and writing',requiredCapabilities:['text','web','tools']},
    {provider:'deepseek',model:'deepseek-v4-flash',purpose:'Low-cost calculations and consistency checks',requiredCapabilities:['text','reasoning'],fallback:true},
    {provider:'anthropic',model:'claude-haiku-4-5',purpose:'Fallback agent',requiredCapabilities:['text','vision','tools'],fallback:true},
  ]},
  power: { mode:'power',label:'Power',summary:'Stronger judgment and cross-checking for harder freight quotations.',recommendedFor:'Complex rate comparisons, customs work, project planning and difficult customer replies.',relativeCost:'moderate',maxTaskCostUsd:1,webPolicy:'automatic',promptCaching:true,requireHumanApproval:true,roles:[
    {provider:'anthropic',model:'claude-sonnet-5',purpose:'Primary planner, agent and final writer',requiredCapabilities:['text','vision','web','tools','reasoning']},
    {provider:'gemini',model:'gemini-3.1-pro',purpose:'Vision and source-document cross-check',requiredCapabilities:['text','vision','web','reasoning']},
    {provider:'openai',model:'gpt-5.6',purpose:'Independent reasoning fallback',requiredCapabilities:['text','vision','web','tools','reasoning'],fallback:true},
    {provider:'xai',model:'grok-4.3',purpose:'Current web research fallback',requiredCapabilities:['text','web','tools'],fallback:true},
  ]},
  ultimate: { mode:'ultimate',label:'Ultimate',summary:'Parallel multi-model analysis with reconciliation and disagreement reporting.',recommendedFor:'OOG, heavy haul, project cargo, claims and other high-value or high-risk decisions.',relativeCost:'high',maxTaskCostUsd:5,webPolicy:'automatic',promptCaching:true,requireHumanApproval:true,roles:[
    {provider:'anthropic',model:'claude-fable-5',purpose:'Primary high-depth reasoner',requiredCapabilities:['text','vision','web','tools','reasoning'],parallelGroup:'analysis'},
    {provider:'anthropic',model:'claude-sonnet-5',purpose:'Independent second opinion',requiredCapabilities:['text','vision','web','tools','reasoning'],parallelGroup:'analysis'},
    {provider:'openai',model:'gpt-5.6',purpose:'Alternative independent second opinion',requiredCapabilities:['text','vision','web','tools','reasoning'],parallelGroup:'analysis',fallback:true},
    {provider:'gemini',model:'gemini-3.1-pro',purpose:'Source-sheet reread, visual verification and live-constraint research',requiredCapabilities:['text','vision','web','reasoning'],parallelGroup:'analysis'},
    {provider:'anthropic',model:'claude-fable-5',purpose:'Synthesis, reconciliation and disagreement report',requiredCapabilities:['text','reasoning']},
  ]},
};

const SETTING_KEY='AI_ROUTING_PROFILE_V2';
const CAPABILITIES=new Set<AiCapability>(['text','vision','web','tools','reasoning']);
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
export function listAiPresets():AiRoutingProfile[]{return[clone(PRESETS.default),clone(PRESETS.power),clone(PRESETS.ultimate)];}

export function validateProfile(input:unknown):AiRoutingProfile{
 if(!input||typeof input!=='object')throw new Error('AI routing profile is required');
 const value=input as Partial<AiRoutingProfile>;
 if(!['default','power','ultimate','custom'].includes(String(value.mode)))throw new Error('Invalid AI mode');
 if(!Array.isArray(value.roles)||value.roles.length===0)throw new Error('At least one model role is required');
 if(!['automatic','always','never'].includes(String(value.webPolicy)))throw new Error('Invalid web-search policy');
 const maxTaskCostUsd=Number(value.maxTaskCostUsd);if(!Number.isFinite(maxTaskCostUsd)||maxTaskCostUsd<=0||maxTaskCostUsd>100)throw new Error('Maximum task cost must be between $0 and $100');
 const roles:ModelRole[]=value.roles.map((role)=>{
   const requiredCapabilities=(Array.isArray(role.requiredCapabilities)?role.requiredCapabilities:['text']).filter((capability):capability is AiCapability=>CAPABILITIES.has(capability as AiCapability));
   return{provider:role.provider,model:String(role.model||'').trim(),purpose:String(role.purpose||'').trim(),requiredCapabilities:requiredCapabilities.length?requiredCapabilities:['text'],parallelGroup:role.parallelGroup,fallback:Boolean(role.fallback)};
 }).filter((role)=>Boolean(role.model&&role.purpose));
 if(!roles.length)throw new Error('At least one valid model role is required');
 return{mode:value.mode as AiMode,label:String(value.label||value.mode),summary:String(value.summary||''),recommendedFor:String(value.recommendedFor||''),relativeCost:(value.relativeCost||'moderate') as AiRoutingProfile['relativeCost'],monthlyTargetUsd:value.monthlyTargetUsd==null?undefined:Number(value.monthlyTargetUsd),maxTaskCostUsd,webPolicy:value.webPolicy as WebPolicy,promptCaching:value.promptCaching!==false,requireHumanApproval:Boolean(value.requireHumanApproval),roles};
}

export async function getAiRoutingProfile():Promise<AiRoutingProfile>{try{const db=createDbClient();const[row]=await db.select().from(appSettings).where(eq(appSettings.key,SETTING_KEY));if(row?.value)return validateProfile(JSON.parse(row.value));}catch(error){console.warn('[ai-routing] could not read saved profile:',error);}return clone(PRESETS.default);}
export async function saveAiRoutingProfile(input:unknown):Promise<AiRoutingProfile>{const profile=validateProfile(input);const db=createDbClient();const now=new Date();await db.insert(appSettings).values({key:SETTING_KEY,value:JSON.stringify(profile),updatedAt:now}).onConflictDoUpdate({target:appSettings.key,set:{value:JSON.stringify(profile),updatedAt:now}});return profile;}
export function buildExecutionPlan(profile:AiRoutingProfile,task:{kind?:string;hasImages?:boolean;requiresFreshData?:boolean;highStakes?:boolean}){const requiresWeb=profile.webPolicy==='always'||(profile.webPolicy==='automatic'&&Boolean(task.requiresFreshData));const selected=profile.roles.filter((role)=>{if(task.hasImages&&role.requiredCapabilities.includes('vision'))return true;if(requiresWeb&&role.requiredCapabilities.includes('web'))return true;return role.purpose.toLowerCase().includes('primary')||role.parallelGroup==='analysis'||role.purpose.toLowerCase().includes('synthesis');});return{mode:profile.mode,task,webResearch:requiresWeb,promptCaching:profile.promptCaching,humanApprovalRequired:profile.requireHumanApproval||Boolean(task.highStakes),parallel:profile.mode==='ultimate',maxTaskCostUsd:profile.maxTaskCostUsd,steps:selected.map((role,index)=>({order:index+1,...role})),disagreementPolicy:profile.mode==='ultimate'?'Show material disagreements and require user review before client-facing output.':'Use fallback only when validation fails or confidence is low.'};}
