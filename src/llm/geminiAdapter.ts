// Gemini adapter — exposes an Anthropic-shaped extract() call backed
// by Google's Generative Language API (AI Studio / Gemini).
//
// Why an adapter? The parse pipelines (parseShipmentBriefing,
// parseDrayageRates) are written against Anthropic's tool-use shape:
// system prompt + tools[] + content blocks of {type: text|document|image}
// with base64 payloads. Gemini's API is shaped similarly but with
// different field names and a different tool/function call convention.
// This adapter translates one direction so we only have ONE prompt
// codebase, and providers swap with `AI_PROVIDER=gemini` in .env.
//
// What's covered:
//   - text content blocks → parts: [{ text }]
//   - document (PDF) blocks → inlineData: { mimeType: 'application/pdf', data }
//   - image blocks → inlineData: { mimeType: f.mediaType, data }
//   - system instruction → systemInstruction
//   - tool with input_schema → tools: [{ functionDeclarations: [...] }]
//   - tool_choice → toolConfig: { functionCallingConfig: { mode: 'ANY' } }
//   - response → first functionCall.args, mapped back to parsed-tool-input shape
//
// What's NOT covered (intentionally — fail fast if needed):
//   - Streaming. Single-shot only.
//   - Multi-turn tool dialogues. We make one call, get one structured
//     response back. Same shape as the Anthropic flow.
//   - Caching. Gemini's prompt caching has a different API (cachedContents)
//     and minimum-token requirement (1024); for the sizes we typically
//     send, the win is small. Skip for now.

import { loadEnv } from '../config.js';

export interface GeminiContentBlock {
  type: 'text' | 'document' | 'image';
  // For 'text':
  text?: string;
  // For 'document' (PDF) and 'image':
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface GeminiToolDef {
  name: string;
  description: string;
  // JSON Schema. Same shape we already feed Anthropic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input_schema: any;
}

export interface GeminiCallParams {
  modelName: string;
  systemPrompt: string;
  content: GeminiContentBlock[];
  tool: GeminiToolDef;
  maxTokens?: number;
}

/**
 * Single-tool extraction call. Returns the structured args of the
 * tool the model invoked, parsed from JSON. Shape matches what
 * Anthropic's `toolUse.input` returns, so downstream Zod parsers
 * don't need to change.
 */
export async function callGeminiTool(
  params: GeminiCallParams
): Promise<unknown> {
  // Prefer the encrypted DB vault (Carrier secrets → AI keys), fall
  // back to env. Letting the secret page beat .env means a phone-side
  // user can swap providers without SSH-ing into the server.
  const { loadAiKey } = await import('../server/apiKeysService.js');
  const env = loadEnv();
  const apiKey = (await loadAiKey('gemini')) ?? env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No Gemini API key set. Add one in the Carrier secrets page or set GEMINI_API_KEY in .env.'
    );
  }

  // Translate content blocks to Gemini "parts" format.
  const parts: Array<Record<string, unknown>> = [];
  for (const b of params.content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ text: b.text });
    } else if ((b.type === 'document' || b.type === 'image') && b.source) {
      parts.push({
        inlineData: {
          mimeType: b.source.media_type,
          data: b.source.data,
        },
      });
    }
  }

  // Strip JSON-Schema features that Gemini's stricter validator dislikes.
  // Gemini accepts a subset of OpenAPI 3.0 schema, not full JSON Schema.
  // Most-common rejections: 'enum' on union types, '$schema', '$id',
  // 'title', 'examples', and array-typed `type` (e.g. ["string","null"]).
  const sanitizeSchema = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(sanitizeSchema);
    if (s && typeof s === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
        if (k === '$schema' || k === '$id' || k === 'examples' || k === 'title') continue;
        if (k === 'type' && Array.isArray(v)) {
          // ["string","null"] → "string" + nullable: true
          const types = (v as string[]).filter((t) => t !== 'null');
          out['type'] = types[0] ?? 'string';
          if ((v as string[]).includes('null')) out['nullable'] = true;
          continue;
        }
        out[k] = sanitizeSchema(v);
      }
      return out;
    }
    return s;
  };

  const requestBody = {
    systemInstruction: {
      parts: [{ text: params.systemPrompt }],
    },
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: params.tool.name,
            description: params.tool.description,
            parameters: sanitizeSchema(params.tool.input_schema),
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [params.tool.name],
      },
    },
    generationConfig: {
      maxOutputTokens: params.maxTokens ?? 4096,
      temperature: 0,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ functionCall?: { name: string; args: unknown } }> };
    }>;
  };
  const cand = data.candidates?.[0];
  const fc = cand?.content?.parts?.find((p) => p.functionCall)?.functionCall;
  if (!fc) {
    throw new Error('Gemini did not return a function call');
  }
  // fc.args is already the parsed tool input — same shape as
  // Anthropic's toolUse.input. Zod validates it downstream.
  return fc.args;
}
