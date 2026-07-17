import { inflateRawSync } from 'node:zlib';
import { convertMsgToEmailText } from './msgToText.js';

export interface UniversalFileInput { filename: string; mediaType?: string; fileBase64: string; }
export interface NormalizedFile {
  filename: string;
  kind: 'pdf' | 'image' | 'text';
  mediaType: string;
  fileBase64?: string;
  text?: string;
  warnings: string[];
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'eml', 'md', 'log', 'yaml', 'yml']);
const ext = (name: string) => name.toLowerCase().split('.').pop() ?? '';

function decodeXml(value: string): string {
  return value
    .replace(/<(w:tab)\s*\/?>/g, '\t')
    .replace(/<(w:br|a:br|text:line-break)\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function unzipEntries(buffer: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP-based office document');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && offset + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = buffer.subarray(start, start + size);
      if (method === 0) result.set(name, Buffer.from(compressed));
      else if (method === 8) result.set(name, inflateRawSync(compressed));
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return result;
}

function docx(entries: Map<string, Buffer>): string {
  return [...entries.entries()]
    .filter(([name]) => name === 'word/document.xml' || name.startsWith('word/header') || name.startsWith('word/footer'))
    .sort(([a], [b]) => a.localeCompare(b)).map(([, data]) => decodeXml(data.toString('utf8'))).join('\n');
}

function pptx(entries: Map<string, Buffer>): string {
  return [...entries.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, data]) => decodeXml(data.toString('utf8'))).join('\n--- slide ---\n');
}

function xlsx(entries: Map<string, Buffer>): string {
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...sharedXml.matchAll(/<si[\s>][\s\S]*?<\/si>/g)].map((match) => decodeXml(match[0]));
  return [...entries.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, data]) => {
      const rows = [...data.toString('utf8').matchAll(/<row[\s>][\s\S]*?<\/row>/g)].map((row) => {
        return [...row[0].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
          const attrs = cell[1] ?? '';
          const body = cell[2] ?? '';
          const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
          return /t="s"/.test(attrs) ? (shared[Number(raw)] ?? raw) : decodeXml(raw);
        }).join('\t');
      });
      return `[${name}]\n${rows.join('\n')}`;
    }).join('\n\n');
}

function rtf(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/\\par[d]?\b/g, '\n')
    .replace(/\\'[0-9a-fA-F]{2}/g, (match) => String.fromCharCode(parseInt(match.slice(2), 16)))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/[{}]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function msg(buffer: Buffer): string {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  return convertMsgToEmailText(arrayBuffer);
}

export function normalizeUniversalFile(input: UniversalFileInput): NormalizedFile {
  const buffer = Buffer.from(input.fileBase64, 'base64');
  const extension = ext(input.filename);
  const mediaType = (input.mediaType || '').toLowerCase();
  if (mediaType === 'application/pdf' || extension === 'pdf') return { filename: input.filename, kind: 'pdf', mediaType: 'application/pdf', fileBase64: input.fileBase64, warnings: [] };
  if (IMAGE_TYPES.has(mediaType) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    const resolved = mediaType === 'image/jpg' || extension === 'jpg' ? 'image/jpeg' : (mediaType || `image/${extension}`);
    return { filename: input.filename, kind: 'image', mediaType: resolved, fileBase64: input.fileBase64, warnings: [] };
  }
  if (TEXT_EXTENSIONS.has(extension) || mediaType.startsWith('text/') || mediaType === 'message/rfc822') return { filename: input.filename, kind: 'text', mediaType: 'text/plain', text: buffer.toString('utf8'), warnings: [] };
  if (extension === 'msg') return { filename: input.filename, kind: 'text', mediaType: 'text/plain', text: msg(buffer), warnings: [] };
  if (extension === 'rtf') return { filename: input.filename, kind: 'text', mediaType: 'text/plain', text: rtf(buffer), warnings: [] };
  if (['docx', 'xlsx', 'pptx', 'ods', 'odt', 'odp'].includes(extension)) {
    const entries = unzipEntries(buffer);
    const text = extension === 'docx' ? docx(entries) : extension === 'xlsx' ? xlsx(entries) : extension === 'pptx' ? pptx(entries) : decodeXml(entries.get('content.xml')?.toString('utf8') ?? '');
    if (!text.trim()) throw new Error(`${input.filename}: no readable text was found in the office document`);
    return { filename: input.filename, kind: 'text', mediaType: 'text/plain', text, warnings: [] };
  }
  if (['doc', 'xls', 'ppt'].includes(extension)) throw new Error(`${input.filename}: legacy binary .${extension} is detected but cannot be safely decoded; save it as ${extension}x, PDF, CSV, or an image first`);
  throw new Error(`${input.filename}: unsupported or unrecognized file format (${mediaType || extension || 'unknown'})`);
}
