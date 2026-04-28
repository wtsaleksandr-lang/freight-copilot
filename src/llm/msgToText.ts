/**
 * Decode an Outlook .msg file (binary OLE Compound Document) into a
 * plain RFC-822-ish text block we can hand to Claude as a text content
 * block — same shape it sees for .eml or text/plain inputs.
 *
 * Uses @kenjiuno/msgreader, a pure-JS parser (no native deps, ~100 KB).
 */
import MsgReader from '@kenjiuno/msgreader';
import type { FieldsData } from '@kenjiuno/msgreader/lib/MsgReader.js';

function joinNameEmail(name?: string, email?: string): string {
  const n = (name ?? '').trim();
  const e = (email ?? '').trim();
  if (n && e) return `${n} <${e}>`;
  return n || e;
}

function recipientsByType(
  recipients: FieldsData[] | undefined,
  type: 'to' | 'cc' | 'bcc'
): string[] {
  if (!recipients) return [];
  // recipientType: 1=To, 2=Cc, 3=Bcc per Outlook MAPI.
  const codes = { to: 1, cc: 2, bcc: 3 } as const;
  const target = codes[type];
  return recipients
    .filter((r) => {
      // recipientType might be on the recipient FieldsData; fall back to
      // including everyone in the To list when type info is missing.
      const t = (r as unknown as { recipType?: number }).recipType;
      return t === target || (type === 'to' && t == null);
    })
    .map((r) => joinNameEmail(r.name, r.email || r.smtpAddress))
    .filter(Boolean);
}

export function convertMsgToEmailText(buf: ArrayBuffer): string {
  // msgreader accepts ArrayBuffer / DataView. The route layer slices a
  // Buffer into a real ArrayBuffer before calling us.
  const reader = new MsgReader(buf);
  const d = reader.getFileData();

  const lines: string[] = [];
  const from = joinNameEmail(d.senderName, d.senderEmail);
  if (from) lines.push(`From: ${from}`);

  const to = recipientsByType(d.recipients, 'to');
  if (to.length) lines.push(`To: ${to.join(', ')}`);
  const cc = recipientsByType(d.recipients, 'cc');
  if (cc.length) lines.push(`Cc: ${cc.join(', ')}`);
  const bcc = recipientsByType(d.recipients, 'bcc');
  if (bcc.length) lines.push(`Bcc: ${bcc.join(', ')}`);

  if (d.subject) lines.push(`Subject: ${d.subject}`);
  if (d.messageDeliveryTime) lines.push(`Date: ${d.messageDeliveryTime}`);

  // Mention attachments by name so Claude knows what was sent (we don't
  // extract their bodies — the user can drop those separately if needed).
  const attachments = (d as unknown as { attachments?: Array<{ fileName?: string }> })
    .attachments;
  if (attachments && attachments.length > 0) {
    const names = attachments
      .map((a) => a?.fileName)
      .filter((n): n is string => !!n);
    if (names.length) {
      lines.push(`Attachments: ${names.join(', ')}`);
    }
  }

  lines.push(''); // blank line separating headers from body

  // body is plain text; bodyHtml exists too but plain is what Claude wants.
  if (d.body) {
    lines.push(d.body);
  } else {
    const bodyHtml = (d as unknown as { bodyHtml?: string }).bodyHtml;
    if (bodyHtml) lines.push(bodyHtml);
  }

  return lines.join('\n');
}
