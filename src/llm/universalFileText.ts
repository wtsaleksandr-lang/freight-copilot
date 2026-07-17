import { inflateRawSync } from 'node:zlib';
import MsgReader from '@kenjiuno/msgreader';

export interface UniversalFileInput {
  filename: string;
  mediaType?: string;
  fileBase64: string;
}

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

function extension(filename: string): string {
  return filename.toLowerCase().split('.').pop() ?? '';
}

function decodeXml(value: string): string {
  return value
    .replace(/<w:tab\s*\/?>/g, '\t')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<a:br\s*\/?>/g, '\n')
    .replace(/<text:line-break\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function unzipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP container');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = buffer.subarray(start, start + compressedSize);
      if (method === 0) entries.set(name, compressed);
      else if (method === 8) entries.set(name, inflateRawSync(compressed));
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function docxText(entries: Map<string, Buffer>): string {
  const parts = [...entries.entries()]
    .filter(([name]) => name === 'word/document.xml' || name.startsWith('word/header') || name.startsWith('word/footer'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, data]) => decodeXml(data.toString('utf8')));
  return parts.join('\n');
}

function pptxText(entries: Map<string, Buffer>): string {
  return [...entries.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, data]) => decodeXml(data.toString('utf8')))
    .join('\n--- slide ---\n');
}

function xlsxText(entries: Map<string, Buffer>): string {
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...sharedXml.matchAll(/<si[\s>][\s\S]*?<\/si>/g)].map((m) => decodeXml(m[0]));
  const sheets = [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return sheets.map(([name, data]) => {
    const xml = data.toString('utf8');
    const rows = [...xml.matchAll(/<row[\s>][\s\S]*?<\/row>/g)].map((rowMatch) => {
      const cells = [...rowMatch[0].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
        const attrs = cell[1] ?? '';
        const body = cell[2] ?? '';
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
        return /t="s"/.test(attrs) ? (shared[Number(raw)] ?? raw) : decodeXml(raw);
      });
      return cells.join('\t');
    });
    return `[${name}]\n${rows.join('\n')}`;
  }).join('\n\n');
}

function rtfText(buffer: Buffer): string {
  return buffer.toString('utf8')
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\'[0-9a-fA-F]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function msgText(buffer: Buffer): string {
  const reader = new MsgReader(buffer);
  const data = reader.getFileData() as unknown as Record<string, unknown>;
  return [data.subject, data.senderName, data.senderEmail, data.recipients, data.body, data.bodyHTML]
    .filter(Boolean)
    .map(String)
    .join('\n');
}

export function normalizeUniversalFile(input: UniversalFileInput): NormalizedFile {
  const buffer = Buffer.from(input.fileBase64, 'base64');
  const ext = extension(input.filename);
  const mediaType = (input.mediaType || '').toLowerCase();
  if (mediaType === 'application/pdf' || ext === 'pdf') {
    return { filename: input.filename, kind: 'pdf', mediaType: 'application/pdf', fileBase64: input.fileBase64, warnings: [] };
  }
  if (IMAGE_TYPES.has(mediaType) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    const resolved = mediaType === 'image/jpg' || ext === 'jpg' ? 'image/jpeg' : (mediaType || `image/${ext}`);
    return { filename: input.filename, kind: 'image', mediaType: resolved, fileBase64: input.fileBase64, warnings: [] };
  }
  if (TEXT_EXTENSIONS.has(ext) || mediaType.startsWith('text/')) {
    return { filename: input.filename, kind: 'text', mediaType: mediaType || 'text/plain', text: buffer.toString('utf8'), warnings: [] };
  }
  if (ext === 'msg') return { filename: input.filename, kind: 'text', mediaType: 'text/plain', text: msgText(buffer), warnings: [] };
  if (ext === 'rtf') return { filename: input.filename, kind: 'text', mediaType: 'text/plain', text: rtfText(buffer), warnings: [] };
  if (['docx', 'xlsx', 'pptx', 'ods', 'odt', 'odp'].includes(ext)) {
    const entries = unzipEntries(buffer);
    let text = '';
    if (ext === 'docx') text = docxText(entries);
    else if (ext === 'xlsx') text = xlsxText(entries);
    else if (ext === 'pptx') text = pptxText(entries);
    else text = decodeXml(entries.get('content.xml')?.toString('utf8') ?? '');
    if (!text.trim()) throw new Error(`${input.filename}: no readable text was found in the office document`);
    return { filename: input.filename, kind: 'text', mediaType: 'text/plain', text, warnings: [] };
  }
  if (['doc', 'xls', 'ppt'].includes(ext)) {
    throw new Error(`${input.filename}: legacy binary .${ext} is detected but cannot be safely decoded; save it as ${ext}x, PDF, CSV, or an image first`);
  }
  throw new Error(`${input.filename}: unsupported or unrecognized file format (${mediaType || ext || 'unknown'})`);
}
