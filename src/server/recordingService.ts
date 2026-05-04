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

/**
 * Save a user-uploaded recording (Chrome DevTools Recorder JSON, Playwright
 * Codegen .ts, or plain Puppeteer .js) and register it in our in-memory list
 * so the same /api/record/analyze flow can process it.
 */
export interface UploadRecordingInput {
  content: string;
  filename?: string;
  carrierCode?: string;
  description?: string;
}

export async function saveUploadedRecording(
  input: UploadRecordingInput
): Promise<RecordingMeta> {
  if (!input.content || input.content.trim().length === 0) {
    throw new Error('Empty file content');
  }

  let outDir: string;
  let carrierCode: string | null = null;
  if (input.carrierCode) {
    const carrier = getCarrier(input.carrierCode);
    carrierCode = carrier.code;
    outDir = resolve(`./samples/${carrier.code.toLowerCase()}/recordings`);
  } else {
    outDir = resolve('./samples/_recordings');
  }
  await mkdir(outDir, { recursive: true });

  // Pick extension from filename or content shape
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let ext = 'txt';
  if (input.filename) {
    const m = input.filename.toLowerCase().match(/\.(json|ts|js)$/);
    if (m) ext = m[1]!;
  } else {
    const trimmed = input.content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) ext = 'json';
    else if (trimmed.includes('await page.')) ext = 'ts';
  }
  const outFile = resolve(outDir, `${ts}-uploaded.${ext}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outFile, input.content);

  const id = randomUUID();
  const meta: ActiveRecording = {
    id,
    url: input.filename ? `(uploaded: ${input.filename})` : '(uploaded recording)',
    carrierCode,
    description: input.description ?? null,
    outFile,
    startedAt: new Date(),
    finishedAt: new Date(),
    status: 'finished',
    exitCode: 0,
    errorMessage: null,
    proc: null,
  };
  recordings.set(id, meta);
  console.log(`[recording ${id}] uploaded -> ${outFile}`);
  return stripProc(meta);
}

function stripProc(r: ActiveRecording): RecordingMeta {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { proc, ...meta } = r;
  return meta;
}

// ---- Replay --------------------------------------------------------
//
// Re-execute a previously-saved recording. Recordings are Playwright
// scripts (codegen output is JS-syntax, saved with .ts extension) or
// uploaded files. We spawn `pnpm exec tsx <file>` so the user's local
// node + bundled Playwright browsers handle execution.

export interface ReplayMeta {
  id: string;
  recordingId: string;
  outFile: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'finished' | 'failed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface ActiveReplay extends ReplayMeta {
  proc: ChildProcess | null;
}

const replays = new Map<string, ActiveReplay>();

export function replayRecording(recordingId: string): ReplayMeta {
  const rec = recordings.get(recordingId);
  if (!rec) throw new Error(`Recording ${recordingId} not found`);
  if (rec.status === 'running') {
    throw new Error('Recording is still being captured — cannot replay yet');
  }
  const replayId = randomUUID();
  // tsx handles both JS and TS files transparently. The file might be
  // codegen output (JS-in-.ts) or a real .ts. Either works.
  const proc = spawn(
    'pnpm',
    ['exec', 'tsx', rec.outFile],
    { stdio: 'pipe', shell: true, detached: false }
  );
  const meta: ActiveReplay = {
    id: replayId,
    recordingId,
    outFile: rec.outFile,
    startedAt: new Date(),
    finishedAt: null,
    status: 'running',
    exitCode: null,
    stdout: '',
    stderr: '',
    proc,
  };
  replays.set(replayId, meta);
  proc.stdout?.on('data', (chunk) => {
    const s = chunk.toString();
    meta.stdout += s;
    // Cap to ~8 KB so a chatty script doesn't balloon memory.
    if (meta.stdout.length > 8192) meta.stdout = meta.stdout.slice(-8192);
  });
  proc.stderr?.on('data', (chunk) => {
    const s = chunk.toString();
    meta.stderr += s;
    if (meta.stderr.length > 8192) meta.stderr = meta.stderr.slice(-8192);
  });
  proc.on('close', (code) => {
    meta.finishedAt = new Date();
    meta.exitCode = code;
    meta.status = code === 0 ? 'finished' : 'failed';
    meta.proc = null;
    console.log(
      `[replay ${replayId}] exited (code ${code}) — recording ${recordingId}`
    );
  });
  proc.on('error', (err) => {
    meta.stderr += `\n[spawn error] ${err.message}`;
    meta.status = 'failed';
    meta.proc = null;
  });
  return stripReplayProc(meta);
}

export function getReplay(replayId: string): ReplayMeta | null {
  const r = replays.get(replayId);
  return r ? stripReplayProc(r) : null;
}

export function listReplays(): ReplayMeta[] {
  return Array.from(replays.values()).map(stripReplayProc);
}

function stripReplayProc(r: ActiveReplay): ReplayMeta {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { proc, ...meta } = r;
  return meta as ReplayMeta;
}
