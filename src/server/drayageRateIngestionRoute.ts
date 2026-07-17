import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { createDbClient } from '../db/client.js';
import { drayageQuotes, drayageRates } from '../db/schema.js';
import { parseDrayageRateFiles, type ParsedDrayageRate } from '../llm/parseDrayageRateFiles.js';
import type { UniversalFileInput } from '../llm/universalFileText.js';
import { reviewDrayageRates, type ReviewedDrayageRate } from './drayageIngestionReview.js';

interface PendingPreview { createdAt:number; rates:ReviewedDrayageRate[]; warnings:string[]; files:Array<{filename:string;kind:string;warnings:string[]}>; }
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, PendingPreview>();

function refId(index:number):string { const day=new Date().toISOString().slice(0,10).replace(/-/g,''); return `DI-${day}-${Date.now().toString(36).toUpperCase()}-${index+1}`; }
function cleanExpired():void { const cutoff=Date.now()-PREVIEW_TTL_MS; for (const [id,value] of previews) if (value.createdAt<cutoff) previews.delete(id); }
function validateFiles(req:Request,res:Response):UniversalFileInput[]|null {
  const files=(req.body?.files??[]) as UniversalFileInput[];
  if (!Array.isArray(files)||files.length===0){res.status(400).json({error:'Provide at least one file.'});return null;}
  if (files.length>20){res.status(400).json({error:'Maximum 20 files per ingestion batch.'});return null;}
  if (files.some((file)=>!file?.filename||!file?.fileBase64)){res.status(400).json({error:'Each file requires filename and base64 content.'});return null;}
  return files;
}

async function saveApprovedRates(rates:ParsedDrayageRate[]) {
  const db=createDbClient(); const saved:Array<{refId:string;quoteId:number;sourceFilename:string}>=[];
  for (let i=0;i<rates.length;i++) {
    const rate=rates[i]!; const ref=refId(i);
    const [quote]=await db.insert(drayageQuotes).values({
      refId:ref, outputFolder:`drayage-rate-ingestion/${ref}`, cargoType:rate.cargo_type, containerType:rate.container_type, containerCount:rate.container_count, weightKg:rate.weight_kg?Math.round(rate.weight_kg):null,
      originType:rate.origin_type, originPortCode:rate.origin_port_code??null, originPortName:rate.origin_port_name??null, originTerminal:rate.origin_terminal??null, originAddressLine1:rate.origin_address??null, originCity:rate.origin_city??null, originState:rate.origin_state??null, originZip:rate.origin_zip??null, originCountry:rate.origin_country??null,
      destinationType:rate.destination_type, destinationPortCode:rate.destination_port_code??null, destinationPortName:rate.destination_port_name??null, destinationTerminal:rate.destination_terminal??null, destinationAddressLine1:rate.destination_address??null, destinationCity:rate.destination_city??null, destinationState:rate.destination_state??null, destinationZip:rate.destination_zip??null, destinationCountry:rate.destination_country??null,
      specialEquipment:rate.special_equipment, accessorials:rate.accessorials, notes:rate.notes??`Imported from ${rate.source_filename}`, status:'complete',
    }).returning({id:drayageQuotes.id});
    if (!quote) throw new Error('Failed to save imported drayage quote');
    await db.insert(drayageRates).values({
      drayageQuoteId:quote.id, providerName:rate.provider_name, providerCode:rate.provider_code??null,
      charges:rate.charges.map((charge)=>({name:charge.name,basis:'imported',quantity:1,unit_price:charge.amount,total:charge.amount,currency:charge.currency})),
      baseRateCents:Math.round(rate.base_rate*100), totalCostCents:Math.round(rate.total_cost*100), currency:rate.currency, transitDays:rate.transit_days??null, validUntil:rate.valid_until??null, freeTimeDays:rate.free_time_days??null, rawSourcePath:rate.source_filename, notes:rate.notes??null, rank:1,
    });
    saved.push({refId:ref,quoteId:quote.id,sourceFilename:rate.source_filename});
  }
  return saved;
}

export function registerDrayageRateIngestionRoute(app:Express):void {
  app.post('/api/drayage/rates/ingest-preview',async(req,res)=>{
    const files=validateFiles(req,res); if(!files)return;
    try { cleanExpired(); const parsed=await parseDrayageRateFiles(files); const reviewed=reviewDrayageRates(parsed.rates); const previewId=randomUUID(); previews.set(previewId,{createdAt:Date.now(),rates:reviewed,warnings:parsed.warnings,files:parsed.normalizedFiles}); res.json({previewId,expiresInMinutes:30,rates:reviewed,warnings:parsed.warnings,files:parsed.normalizedFiles,readyCount:reviewed.filter((r)=>r.readyToImport).length,blockedCount:reviewed.filter((r)=>!r.readyToImport).length}); }
    catch(err){res.status(422).json({error:err instanceof Error?err.message:String(err)});}
  });
  app.post('/api/drayage/rates/ingest-apply',async(req,res)=>{
    cleanExpired(); const previewId=String(req.body?.previewId??''); const selectedIndexes=req.body?.selectedIndexes as unknown;
    if(!previewId||!Array.isArray(selectedIndexes)){res.status(400).json({error:'previewId and selectedIndexes are required.'});return;}
    const preview=previews.get(previewId); if(!preview){res.status(409).json({error:'This preview expired or no longer exists. Extract the files again.'});return;}
    const indexes=[...new Set(selectedIndexes)].filter((value):value is number=>Number.isInteger(value)&&value>=0&&value<preview.rates.length);
    const selected=indexes.map((index)=>preview.rates[index]!).filter((rate)=>rate.readyToImport);
    if(selected.length===0){res.status(400).json({error:'Select at least one import-ready rate.'});return;}
    try { const saved=await saveApprovedRates(selected); previews.delete(previewId); res.json({importedCount:saved.length,saved}); }
    catch(err){res.status(422).json({error:err instanceof Error?err.message:String(err)});}
  });
}
