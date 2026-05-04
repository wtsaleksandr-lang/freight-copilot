// Scheduled web-agent runs. Stored in DB, polled by an in-process
// background tick (every 60s). On tick, any enabled task whose
// lastRunAt is older than intervalMinutes is launched via runAgent.
// One run at a time per task — overlapping runs are explicitly
// avoided by checking the in-memory `running` set.

import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { scheduledAgents } from '../db/schema.js';
import { runAgent } from '../agent/runAgent.js';

export type ScheduledAgent = typeof scheduledAgents.$inferSelect;

const running = new Set<number>();

export async function listScheduledAgents(): Promise<ScheduledAgent[]> {
  const db = createDbClient();
  return db.select().from(scheduledAgents);
}

export async function upsertScheduledAgent(input: {
  id?: number;
  name: string;
  url: string;
  goal: string;
  intervalMinutes?: number;
  enabled?: boolean;
  maxIterations?: number;
}): Promise<ScheduledAgent> {
  if (!/^https?:\/\//i.test(input.url)) {
    throw new Error('URL must start with http:// or https://');
  }
  if (!input.name?.trim()) throw new Error('name is required');
  if (!input.goal?.trim()) throw new Error('goal is required');
  const interval = Math.max(5, Math.floor(input.intervalMinutes ?? 60));
  const maxIter = Math.max(5, Math.min(60, Math.floor(input.maxIterations ?? 25)));
  const db = createDbClient();
  if (input.id) {
    await db
      .update(scheduledAgents)
      .set({
        name: input.name.trim(),
        url: input.url.trim(),
        goal: input.goal.trim(),
        intervalMinutes: interval,
        enabled: input.enabled ?? true,
        maxIterations: maxIter,
      })
      .where(eq(scheduledAgents.id, input.id));
    const [row] = await db
      .select()
      .from(scheduledAgents)
      .where(eq(scheduledAgents.id, input.id));
    if (!row) throw new Error('Scheduled agent not found after update');
    return row;
  } else {
    const [row] = await db
      .insert(scheduledAgents)
      .values({
        name: input.name.trim(),
        url: input.url.trim(),
        goal: input.goal.trim(),
        intervalMinutes: interval,
        enabled: input.enabled ?? true,
        maxIterations: maxIter,
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }
}

export async function deleteScheduledAgent(id: number): Promise<boolean> {
  const db = createDbClient();
  const result = await db.delete(scheduledAgents).where(eq(scheduledAgents.id, id));
  const ra = (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  return ra > 0;
}

/**
 * Launch one scheduled agent right now (called both by the manual
 * "Run now" UI button and by the background tick). Updates lastRunAt
 * + lastRunStatus on completion.
 */
export async function runScheduledAgent(id: number): Promise<{
  ok: boolean;
  status: string;
  message: string;
}> {
  if (running.has(id)) {
    return { ok: false, status: 'busy', message: 'Already running' };
  }
  const db = createDbClient();
  const [task] = await db
    .select()
    .from(scheduledAgents)
    .where(eq(scheduledAgents.id, id));
  if (!task) return { ok: false, status: 'missing', message: 'Task not found' };
  running.add(id);
  try {
    const result = await runAgent({
      url: task.url,
      goal: task.goal,
      maxIterations: task.maxIterations,
    });
    const summary = JSON.stringify({
      finished: result.finished,
      finishReason: result.finishReason ?? null,
      stepCount: result.steps?.length ?? 0,
    }).slice(0, 2000);
    await db
      .update(scheduledAgents)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: result.finished ? 'success' : 'incomplete',
        lastRunResult: summary,
      })
      .where(eq(scheduledAgents.id, id));
    return {
      ok: !!result.finished,
      status: result.finished ? 'success' : 'incomplete',
      message: result.finishReason ?? 'completed',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(scheduledAgents)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: 'failed',
        lastRunResult: msg.slice(0, 2000),
      })
      .where(eq(scheduledAgents.id, id));
    return { ok: false, status: 'failed', message: msg };
  } finally {
    running.delete(id);
  }
}

let tickHandle: NodeJS.Timeout | null = null;

/**
 * Start the background tick. Called once at server boot. Runs every
 * 60s — for any task whose `lastRunAt + intervalMinutes` is in the
 * past, launches it. Overlap is prevented by the in-memory `running`
 * set (one in-flight launch per task at most).
 */
export function startScheduledAgentTick(): void {
  if (tickHandle) return;
  console.log('[scheduled-agents] tick loop starting (60s cadence)');
  tickHandle = setInterval(async () => {
    try {
      const now = Date.now();
      const tasks = await listScheduledAgents();
      for (const t of tasks) {
        if (!t.enabled) continue;
        if (running.has(t.id)) continue;
        const last = t.lastRunAt ? new Date(t.lastRunAt).getTime() : 0;
        const dueAt = last + t.intervalMinutes * 60_000;
        if (dueAt > now) continue;
        // Fire and forget — runScheduledAgent handles its own errors.
        console.log(`[scheduled-agents] firing "${t.name}" (id ${t.id})`);
        runScheduledAgent(t.id).catch((e) =>
          console.error(`[scheduled-agents] task ${t.id} crashed:`, e)
        );
      }
    } catch (err) {
      console.error('[scheduled-agents] tick error:', err);
    }
  }, 60_000);
}
