/**
 * Lightweight RFC-822 / MIME email parser.
 *
 * Turns a raw `.eml` (or the raw MIME a mail-forwarding worker POSTs) into the
 * fields the BCC-rate ingest needs: a decoded plain-text body plus the Subject,
 * From and Message-ID headers. It is intentionally dependency-free and pure so
 * it unit-tests without a network or a mail server — the same reasoning behind
 * msgToText.ts (which handles the binary .msg case).
 *
 * Scope: header unfolding, multipart walking (nested boundaries included),
 * quoted-printable + base64 transfer-decoding, and a minimal HTML→text strip
 * for html-only mails. It is not a full MIME implementation (no charset
 * transcoding beyond utf-8/latin1, no RFC 2047 word decoding of the BODY), but
 * it covers the ordinary rate-quote email a forwarder relays.
 */

export interface ParsedEmail {
  /** Decoded plain-text body (html stripped to text when that's all there is). */
  text: string;
  subject: string;
  from: string;
  /** RFC-822 Message-ID with the surrounding angle brackets removed. '' if none. */
  messageId: string;
}

interface RawPart {
  headers: Map<string, string>;
  /** Body as raw text (pre transfer-decode), boundaries already stripped. */
  body: string;
}

/** Split a raw message/part into its header block and body on the first blank line. */
function splitHeadersBody(raw: string): { headerBlock: string; body: string } {
  // Accept both CRLF and LF. The header/body separator is a blank line.
  const normalized = raw.replace(/\r\n/g, '\n');
  const idx = normalized.indexOf('\n\n');
  if (idx < 0) return { headerBlock: normalized, body: '' };
  return { headerBlock: normalized.slice(0, idx), body: normalized.slice(idx + 2) };
}

/** Parse a header block into a lower-cased-key map, unfolding continuation lines. */
function parseHeaders(headerBlock: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = headerBlock.split('\n');
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      // Continuation of the previous header (folded long value).
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // First occurrence wins for our purposes (Subject/From/Message-ID are unique).
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

/** Pull a parameter (e.g. boundary, charset) out of a Content-Type value. */
function contentTypeParam(contentType: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|([^;\\s]+))`, 'i');
  const m = contentType.match(re);
  if (!m) return null;
  return (m[2] ?? m[3] ?? '').trim();
}

function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = [];
  // Soft line breaks: "=" at end of a line joins to the next line.
  const withoutSoft = input.replace(/=\r?\n/g, '').replace(/=\n/g, '');
  for (let i = 0; i < withoutSoft.length; i++) {
    const ch = withoutSoft[i]!;
    if (ch === '=' && i + 2 < withoutSoft.length) {
      const hex = withoutSoft.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeTransfer(body: string, encoding: string): string {
  const enc = (encoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  // 7bit / 8bit / binary / none — already text.
  return body;
}

/** Minimal HTML → text: drop scripts/styles, turn breaks into newlines, unescape. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Collect the readable text out of one MIME part, recursing into multiparts.
 * Prefers text/plain leaves; falls back to text/html (stripped). Non-text
 * leaves (attachments) contribute only a mention of their filename.
 */
function extractPartText(part: RawPart, depth = 0): { plain: string[]; html: string[]; attachments: string[] } {
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as string[] };
  if (depth > 20) return out; // guard against pathological nesting
  const contentType = (part.headers.get('content-type') ?? 'text/plain').toLowerCase();
  const encoding = part.headers.get('content-transfer-encoding') ?? '';
  const disposition = part.headers.get('content-disposition') ?? '';

  if (contentType.startsWith('multipart/')) {
    const boundary = contentTypeParam(part.headers.get('content-type') ?? '', 'boundary');
    if (!boundary) return out;
    for (const sub of splitMultipart(part.body, boundary)) {
      const subParsed = splitHeadersBody(sub);
      const subPart: RawPart = { headers: parseHeaders(subParsed.headerBlock), body: subParsed.body };
      const nested = extractPartText(subPart, depth + 1);
      out.plain.push(...nested.plain);
      out.html.push(...nested.html);
      out.attachments.push(...nested.attachments);
    }
    return out;
  }

  const isAttachment = /attachment/i.test(disposition);
  const filename =
    contentTypeParam(part.headers.get('content-type') ?? '', 'name') ||
    contentTypeParam(disposition, 'filename');
  if (isAttachment || (!contentType.startsWith('text/') && filename)) {
    if (filename) out.attachments.push(filename);
    return out;
  }

  const decoded = decodeTransfer(part.body, encoding);
  if (contentType.startsWith('text/html')) out.html.push(htmlToText(decoded));
  else out.plain.push(decoded.trim());
  return out;
}

/** Split a multipart body on its boundary markers into raw sub-part strings. */
function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  const segments = body.split(marker);
  for (const seg of segments) {
    // The preamble (before the first boundary) and the closing "--" epilogue
    // are not parts. A closing boundary segment starts with "--".
    if (seg.startsWith('--')) continue; // closing marker / epilogue
    const trimmed = seg.replace(/^\r?\n/, '');
    if (trimmed.trim() === '') continue;
    parts.push(trimmed);
  }
  return parts;
}

/** Strip surrounding angle brackets and whitespace from a Message-ID value. */
function cleanMessageId(value: string | undefined): string {
  if (!value) return '';
  const m = value.match(/<([^>]+)>/);
  return (m && m[1] ? m[1] : value).trim();
}

export function parseRawEmail(raw: string): ParsedEmail {
  const source = typeof raw === 'string' ? raw : String(raw ?? '');
  const { headerBlock, body } = splitHeadersBody(source);
  const headers = parseHeaders(headerBlock);
  const rootPart: RawPart = { headers, body };
  const collected = extractPartText(rootPart);

  const plain = collected.plain.filter((s) => s.trim()).join('\n\n').trim();
  const html = collected.html.filter((s) => s.trim()).join('\n\n').trim();
  let text = plain || html;
  if (collected.attachments.length) {
    text += `${text ? '\n\n' : ''}Attachments: ${collected.attachments.join(', ')}`;
  }

  return {
    text,
    subject: headers.get('subject') ?? '',
    from: headers.get('from') ?? '',
    messageId: cleanMessageId(headers.get('message-id')),
  };
}

/**
 * Render a ParsedEmail into the RFC-822-ish text block Claude reads — the same
 * shape convertMsgToEmailText produces for .msg files, so the ocean extractor
 * sees a consistent input regardless of source format.
 */
export function parsedEmailToPromptText(email: ParsedEmail): string {
  const lines: string[] = [];
  if (email.from) lines.push(`From: ${email.from}`);
  if (email.subject) lines.push(`Subject: ${email.subject}`);
  lines.push('');
  lines.push(email.text);
  return lines.join('\n').trim();
}
