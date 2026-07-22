import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { loadEnv } from '../config.js';
import { decryptSecret } from './secretsCrypto.js';

export type AiProvider = 'anthropic' | 'gemini' | 'openai' | 'xai' | 'deepseek';

const ENV_KEY: Record<AiProvider, keyof NodeJS.ProcessEnv> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export async function loadAiProviderKey(provider: AiProvider): Promise<string | null> {
  try {
    const db = createDbClient();
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.provider, provider));
    if (row?.keyEncrypted) return await decryptSecret(row.keyEncrypted);
  } catch (error) {
    console.warn(`[ai-keys] Could not read ${provider} key from encrypted storage:`, error);
  }

  const env = loadEnv();
  const configured = process.env[ENV_KEY[provider]];
  if (configured?.trim()) return configured.trim();
  if (provider === 'anthropic' && env.ANTHROPIC_API_KEY?.trim()) return env.ANTHROPIC_API_KEY.trim();
  if (provider === 'gemini' && env.GEMINI_API_KEY?.trim()) return env.GEMINI_API_KEY.trim();
  return null;
}

export async function listConfiguredAiProviders(): Promise<AiProvider[]> {
  const providers: AiProvider[] = ['anthropic', 'gemini', 'openai', 'xai', 'deepseek'];
  const checks = await Promise.all(providers.map(async (provider) => ({ provider, key: await loadAiProviderKey(provider) })));
  return checks.filter((item) => Boolean(item.key)).map((item) => item.provider);
}
