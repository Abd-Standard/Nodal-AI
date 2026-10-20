/**
 * backend/triggers.ts
 * 
 * Event-driven triggers for autonomous PayFi.
 * "when X arrives from Y, do Z" - persisted and deduplicated.
 */

import { PayFiAgent, AgentTask } from './agent';
import { config } from './config';
import { createLogger } from './utils/logger';
import { db } from './db/client';

const log = createLogger('triggers');

export type TriggerSource = 'payment' | 'contract_event' | 'storage_change';

export interface TriggerFilter {
  /** Filter by source asset code (e.g., 'USDC') */
  assetCode?: string;
  /** Filter by sender public key */
  from?: string;
  /** Filter by amount threshold */
  minAmount?: string;
  /** Filter by contract ID */
  contractId?: string;
  /** Filter by event topics */
  eventTopics?: string[];
  /** Filter by storage key */
  storageKey?: string;
}

export interface Trigger {
  id: string;
  source: TriggerSource;
  filter: TriggerFilter;
  /** Task to execute when trigger fires */
  task: AgentTask;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
}

/**
 * Persist trigger to database.
 */
async function saveTrigger(trigger: Trigger): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO triggers (id, source, filter, task, enabled, created_at, last_fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      trigger.id,
      trigger.source,
      JSON.stringify(trigger.filter),
      JSON.stringify(trigger.task),
      trigger.enabled ? 1 : 0,
      trigger.createdAt,
      trigger.lastFiredAt ?? null,
    ]
  );
}

/**
 * Load all triggers from database.
 */
async function loadTriggers(): Promise<Trigger[]> {
  try {
    const rows = await db.select<Array<{
      id: string;
      source: string;
      filter: string;
      task: string;
      enabled: number;
      created_at: string;
      last_fired_at: string | null;
    }>>('SELECT * FROM triggers');
    
    return rows.map(row => ({
      id: row.id,
      source: row.source as TriggerSource,
      filter: JSON.parse(row.filter),
      task: JSON.parse(row.task),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastFiredAt: row.last_fired_at ?? undefined,
    }));
  } catch {
    // Table doesn't exist yet
    return [];
  }
}

/**
 * Record that a trigger fired for an event (dedupe).
 */
async function recordTriggerFired(triggerId: string, eventId: string): Promise<boolean> {
  const key = `trigger:${triggerId}:event:${eventId}`;
  const existing = await db.select<Array<{ key: string }>>(
    'SELECT key FROM trigger_events WHERE key = ?',
    [key]
  );
  
  if (existing.length > 0) return false; // Already fired for this event
  
  await db.execute(
    'INSERT INTO trigger_events (key, fired_at) VALUES (?, ?)',
    [key, new Date().toISOString()]
  );
  
  return true;
}

/**
 * Check if event matches trigger filter.
 */
function matchesFilter(event: unknown, filter: TriggerFilter): boolean {
  const e = event as Record<string, unknown>;
  
  if (filter.assetCode) {
    const eventAsset = (e.assetCode as string) ?? (e.asset as string);
    if (eventAsset !== filter.assetCode) return false;
  }
  
  if (filter.from) {
    if (e.from !== filter.from && e.source !== filter.from) return false;
  }
  
  if (filter.minAmount) {
    const eventAmount = parseFloat(String(e.amount ?? e.value ?? '0'));
    const minAmount = parseFloat(filter.minAmount);
    if (eventAmount < minAmount) return false;
  }
  
  if (filter.contractId) {
    if (e.contractId !== filter.contractId) return false;
  }
  
  if (filter.eventTopics?.length) {
    const eventTopics = (e.topics as string[]) ?? [];
    if (!filter.eventTopics.some(t => eventTopics.includes(t))) return false;
  }
  
  return true;
}

/**
 * TriggerManager - handles event-driven automation.
 */
export class TriggerManager {
  private triggers: Map<string, Trigger> = new Map();
  private agent: PayFiAgent;
  private unlistenPayment?: () => void;
  private unlistenContract?: () => void;
  private unlistenStorage?: () => void;

  constructor(agent: PayFiAgent) {
    this.agent = agent;
  }

  /**
   * Load triggers from database and start listening.
   */
  async start(): Promise<void> {
    const loaded = await loadTriggers();
    for (const trigger of loaded) {
      this.triggers.set(trigger.id, trigger);
    }
    log.info({ count: this.triggers.size }, 'Triggers loaded');
    
    // Set up listeners
    this.setupPaymentListener();
    this.setupContractListener();
    this.setupStorageListener();
  }

  private setupPaymentListener(): void {
    this.agent.startListening('trigger', async (challenge) => {
      const payment = {
        assetCode: challenge.assetCode,
        from: challenge.payTo, // Incoming payment
        amount: challenge.amount,
      };
      
      for (const [id, trigger] of this.triggers) {
        if (!trigger.enabled || trigger.source !== 'payment') continue;
        if (!matchesFilter(payment, trigger.filter)) continue;
        
        // Dedupe by event
        const eventId = challenge.nonce;
        const isNew = await recordTriggerFired(id, eventId);
        if (!isNew) continue;
        
        // Check spending limit before execution
        const p = trigger.task.payload as Record<string, unknown>;
        if (p.amount) {
          const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
          const amount = parseFloat(String(p.amount));
          if (amount > limit) {
            log.warn({ triggerId: id, amount }, 'Trigger exceeds spending limit');
            continue;
          }
        }
        
        log.info({ triggerId: id, eventId }, 'Trigger firing');
        await this.agent.run(trigger.task);
        
        // Update last fired
        trigger.lastFiredAt = new Date().toISOString();
        await saveTrigger(trigger);
      }
    });
  }

  private setupContractListener(): void {
    // Contract events are set up per-contract
  }

  private setupStorageListener(): void {
    // Storage changes are set up per-contract
  }

  /**
   * Create a new trigger.
   */
  async createTrigger(options: {
    source: TriggerSource;
    filter: TriggerFilter;
    task: AgentTask;
  }): Promise<Trigger> {
    const trigger: Trigger = {
      id: `trig_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      source: options.source,
      filter: options.filter,
      task: options.task,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    
    this.triggers.set(trigger.id, trigger);
    await saveTrigger(trigger);
    
    log.info({ triggerId: trigger.id, source: trigger.source }, 'Trigger created');
    return trigger;
  }

  /**
   * Enable/disable a trigger.
   */
  async setTriggerEnabled(id: string, enabled: boolean): Promise<void> {
    const trigger = this.triggers.get(id);
    if (!trigger) throw new Error(`Trigger not found: ${id}`);
    
    trigger.enabled = enabled;
    await saveTrigger(trigger);
    log.info({ triggerId: id, enabled }, 'Trigger updated');
  }

  /**
   * Delete a trigger.
   */
  async deleteTrigger(id: string): Promise<void> {
    this.triggers.delete(id);
    await db.execute('DELETE FROM triggers WHERE id = ?', [id]);
    log.info({ triggerId: id }, 'Trigger deleted');
  }

  /**
   * Get all triggers.
   */
  getTriggers(): Trigger[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Stop all listeners and cleanup.
   */
  stop(): void {
    this.agent.stopListening();
    this.agent.stopContractListener();
    this.agent.stopStorageWatcher();
    this.triggers.clear();
    log.info('TriggerManager stopped');
  }
}