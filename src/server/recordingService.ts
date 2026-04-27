import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCarrier } from '../carriers/registry.js';

export interface RecordingMeta {
  id: string;
  url: string;
  carrierCode: string | null;
  description: string | null;
  outFile: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'finished' | 'failed';
  exitCode: number | null;
  errorMessage: string | null;
}

interface ActiveRecording extends RecordingMeta {
  proc: ChildProcess | null;
}

const recordings = new Map<string, ActiveRecording>();

export interface StartRecordingInput {
  url: string;
  carrierCode?: string;
  description?: string;
}

export async function startRecording(
  input: StartRecordingInput
): Promise<RecordingMeta> {
  if (!/^https?:\/\//i.test(input.url)) {
    throw new Error('URL must start with http:// or https://');
  }

  // Resolve output folder.
  let outDir: string;
  let carrierCode: string | null = null;
  if (input.carrierCode) {
    const carrier = getCarrier(input.carrierCode); // throws if unknown
    carrierCode = carrier.code;
    outDir = resolve(`./samples/${carrier.code.toLowerCase()}/recordings`);
  } else {
    outDir = resolve('./samples/_recordings');
  }
  await mkdir(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = resolve(outDir, `${ts}.ts`);
  const id = randomUUID();

  // Spawn Playwright Codegen. shell:true so `pnpm` resolves on Windows.
  const proc = spawn(
    'pnpm',
    [
      'exec',
      'playwright',
      'codegen',
      '--output',
      outFile,
      '--target',
      'javascript',
      input.url,
    ],
    { stdio: 'pipe', shell: true, detached: false }
  );

  const meta: ActiveRecording = {
    id,
    url: input.url,
    carrierCode,
    description: input.description ?? null,
    outFile,
    startedAt: new Date(),
    finishedAt: null,
    status: 'running',
    exitCode: null,
    errorMessage: null,
    proc,
  };
  recordings.set(id, meta);

  proc.on('close', (code) => {
    const r = recordings.get(id);
    if (!r) return;
    r.finishedAt = new Date();
    r.exitCode = code;
    r.status = code === 0 ? 'finished' : 'failed';
    r.proc = null;
    console.log(
      `[recording ${id}] codegen exited (code ${code}) — output at ${outFile}`
    );
  });

  proc.on('error', (err) => {
    const r = recordings.get(id);
    if (!r) return;
    r.finishedAt = new Date();
    r.status = 'failed';
    r.errorMessage = err.message;
    r.proc = null;
    console.error(`[recording ${id}] spawn error:`, err);
  });

  return stripProc(meta);
}

export function getRecording(id: string): RecordingMeta | null {
  const r = recordings.get(id);
  return r ? stripProc(r) : null;
}

export function listRecordings(): RecordingMeta[] {
  return Array.from(recordings.values())
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .map(stripProc);
}

export function stopRecording(id: string): boolean {
  const r = recordings.get(id);
  if (!r || !r.proc) return false;
  try {
    r.proc.kill();
    return true;
  } catch {
    return false;
  }
}

export async function readRecordingFile(id: string): Promise<string> {
  const r = recordings.get(id);
  if (!r) throw new Error(`Recording ${id} not found`);
  return readFile(r.outFile, 'utf8');
}

function stripProc(r: ActiveRecording): RecordingMeta {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { proc, ...meta } = r;
  return meta;
}
