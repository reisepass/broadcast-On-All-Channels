/**
 * SQLite Database Module
 *
 * Stores:
 * - Message history with UUIDs
 * - Channel acknowledgments per identity
 * - Channel preferences per identity
 * - Protocol performance metrics
 */

import { createClient } from '@libsql/client';
import type { Client, ResultSet } from '@libsql/client';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Message {
  id?: number;
  uuid: string;
  fromIdentity: string; // Magnet link or address
  toIdentity: string;
  content: string;
  timestamp: number;
  isAcknowledgment: boolean;
  firstReceivedProtocol?: string;
  firstReceivedAt?: number;
}

export interface MessageReceipt {
  id?: number;
  messageUuid: string;
  protocol: string;
  server?: string; // Server/relay URL (e.g., wss://relay.damus.io for Nostr, mqtt://broker.hivemq.com for MQTT)
  receivedAt: number;
  latencyMs: number;
}

export interface ChannelPreference {
  id?: number;
  identity: string; // Magnet link
  protocol: string;
  isWorking: boolean;
  lastAckAt?: number;
  avgLatencyMs?: number;
  preferenceOrder?: number; // User's stated preference
  cannotUse: boolean; // User said they can't use this channel
}

export interface ProtocolPerformance {
  protocol: string;
  totalSent: number;
  totalAcked: number;
  avgLatencyMs: number;
  lastUsedAt: number;
}

export class ChatDatabase {
  private db: Client;
  private initPromise: Promise<void>;

  constructor(dbPath: string = './data/chat.db') {
    // Ensure data directory exists
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.db = createClient({
      url: `file:${dbPath}`,
    });
    this.initPromise = this.initTables();
  }

  /**
   * Static factory method for async initialization
   */
  static async create(dbPath: string = './data/chat.db'): Promise<ChatDatabase> {
    const db = new ChatDatabase(dbPath);
    await db.initPromise;
    return db;
  }

  /**
   * Ensure initialization is complete before executing operations
   */
  private async ensureInit(): Promise<void> {
    await this.initPromise;
  }

  /**
   * Execute a query with retry logic for SQLITE_BUSY errors
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 5,
    delayMs: number = 100
  ): Promise<T> {
    let lastError: any;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        // Only retry on SQLITE_BUSY errors
        if (error.code === 'SQLITE_BUSY' && i < maxRetries - 1) {
          // Exponential backoff with jitter
          const delay = delayMs * Math.pow(2, i) + Math.random() * 50;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  private async initTables() {
    // Enable WAL mode for better concurrent access
    await this.db.execute('PRAGMA journal_mode = WAL');

    // Set a busy timeout (10 seconds)
    await this.db.execute('PRAGMA busy_timeout = 10000');

    // Messages table
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        from_identity TEXT NOT NULL,
        to_identity TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_acknowledgment INTEGER NOT NULL DEFAULT 0,
        first_received_protocol TEXT,
        first_received_at INTEGER
      )
    `);

    // Message receipts (track delivery on each protocol)
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS message_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_uuid TEXT NOT NULL,
        protocol TEXT NOT NULL,
        server TEXT,
        received_at INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        FOREIGN KEY (message_uuid) REFERENCES messages(uuid)
      )
    `);

    // Channel preferences (learned and stated)
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS channel_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity TEXT NOT NULL,
        protocol TEXT NOT NULL,
        is_working INTEGER NOT NULL DEFAULT 1,
        last_ack_at INTEGER,
        avg_latency_ms INTEGER,
        preference_order INTEGER,
        cannot_use INTEGER NOT NULL DEFAULT 0,
        UNIQUE(identity, protocol)
      )
    `);

    // Protocol performance metrics
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS protocol_performance (
        protocol TEXT PRIMARY KEY,
        total_sent INTEGER NOT NULL DEFAULT 0,
        total_acked INTEGER NOT NULL DEFAULT 0,
        avg_latency_ms INTEGER,
        last_used_at INTEGER
      )
    `);

    // Migration: Add server column to existing message_receipts tables
    try {
      // Check if server column exists
      const tableInfo = await this.db.execute('PRAGMA table_info(message_receipts)');
      const hasServerColumn = tableInfo.rows.some(row => row.name === 'server');

      if (!hasServerColumn) {
        await this.db.execute('ALTER TABLE message_receipts ADD COLUMN server TEXT');
      }
    } catch (error) {
      // Column might already exist or table doesn't exist yet
    }

    // Indexes for performance
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(uuid)
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_identity)
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_identity)
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_receipts_uuid ON message_receipts(message_uuid)
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_receipts_server ON message_receipts(server)
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_prefs_identity ON channel_preferences(identity)
    `);
  }

  // Message operations
  async saveMessage(message: Message): Promise<void> {
    await this.ensureInit();
    await this.executeWithRetry(() =>
      this.db.execute({
        sql: `
          INSERT OR IGNORE INTO messages (uuid, from_identity, to_identity, content, timestamp, is_acknowledgment, first_received_protocol, first_received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          message.uuid,
          message.fromIdentity,
          message.toIdentity,
          message.content,
          message.timestamp,
          message.isAcknowledgment ? 1 : 0,
          message.firstReceivedProtocol || null,
          message.firstReceivedAt || null,
        ],
      })
    );
  }

  async getMessage(uuid: string): Promise<Message | undefined> {
    const result = await this.db.execute({
      sql: `SELECT * FROM messages WHERE uuid = ?`,
      args: [uuid],
    });

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      id: row.id as number,
      uuid: row.uuid as string,
      fromIdentity: row.from_identity as string,
      toIdentity: row.to_identity as string,
      content: row.content as string,
      timestamp: row.timestamp as number,
      isAcknowledgment: (row.is_acknowledgment as number) === 1,
      firstReceivedProtocol: row.first_received_protocol as string | undefined,
      firstReceivedAt: row.first_received_at as number | undefined,
    };
  }

  async updateMessageFirstReceipt(uuid: string, protocol: string, receivedAt: number): Promise<void> {
    await this.executeWithRetry(() =>
      this.db.execute({
        sql: `
          UPDATE messages
          SET first_received_protocol = ?, first_received_at = ?
          WHERE uuid = ? AND first_received_protocol IS NULL
        `,
        args: [protocol, receivedAt, uuid],
      })
    );
  }

  async getConversation(identity1: string, identity2: string, limit: number = 50): Promise<Message[]> {
    const result = await this.db.execute({
      sql: `
        SELECT * FROM messages
        WHERE (from_identity = ? AND to_identity = ?)
           OR (from_identity = ? AND to_identity = ?)
        ORDER BY timestamp DESC
        LIMIT ?
      `,
      args: [identity1, identity2, identity2, identity1, limit],
    });

    return result.rows
      .map((row) => ({
        id: row.id as number,
        uuid: row.uuid as string,
        fromIdentity: row.from_identity as string,
        toIdentity: row.to_identity as string,
        content: row.content as string,
        timestamp: row.timestamp as number,
        isAcknowledgment: (row.is_acknowledgment as number) === 1,
        firstReceivedProtocol: row.first_received_protocol as string | undefined,
        firstReceivedAt: row.first_received_at as number | undefined,
      }))
      .reverse(); // Oldest first
  }

  // Message receipt operations
  async saveMessageReceipt(receipt: MessageReceipt): Promise<void> {
    await this.executeWithRetry(() =>
      this.db.execute({
        sql: `
          INSERT INTO message_receipts (message_uuid, protocol, server, received_at, latency_ms)
          VALUES (?, ?, ?, ?, ?)
        `,
        args: [receipt.messageUuid, receipt.protocol, receipt.server || null, receipt.receivedAt, receipt.latencyMs],
      })
    );
  }

  async getMessageReceipts(messageUuid: string): Promise<MessageReceipt[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM message_receipts WHERE message_uuid = ? ORDER BY received_at ASC`,
      args: [messageUuid],
    });

    return result.rows.map((row) => ({
      id: row.id as number,
      messageUuid: row.message_uuid as string,
      protocol: row.protocol as string,
      server: row.server as string | undefined,
      receivedAt: row.received_at as number,
      latencyMs: row.latency_ms as number,
    }));
  }

  // Channel preference operations
  async updateChannelPreference(pref: ChannelPreference): Promise<void> {
    await this.executeWithRetry(() =>
      this.db.execute({
        sql: `
          INSERT INTO channel_preferences (identity, protocol, is_working, last_ack_at, avg_latency_ms, preference_order, cannot_use)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(identity, protocol) DO UPDATE SET
            is_working = excluded.is_working,
            last_ack_at = excluded.last_ack_at,
            avg_latency_ms = excluded.avg_latency_ms,
            preference_order = COALESCE(excluded.preference_order, preference_order),
            cannot_use = excluded.cannot_use
        `,
        args: [
          pref.identity,
          pref.protocol,
          pref.isWorking ? 1 : 0,
          pref.lastAckAt || null,
          pref.avgLatencyMs || null,
          pref.preferenceOrder || null,
          pref.cannotUse ? 1 : 0,
        ],
      })
    );
  }

  async getChannelPreferences(identity: string): Promise<ChannelPreference[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM channel_preferences WHERE identity = ? ORDER BY preference_order ASC, avg_latency_ms ASC`,
      args: [identity],
    });

    return result.rows.map((row) => ({
      id: row.id as number,
      identity: row.identity as string,
      protocol: row.protocol as string,
      isWorking: (row.is_working as number) === 1,
      lastAckAt: row.last_ack_at as number | undefined,
      avgLatencyMs: row.avg_latency_ms as number | undefined,
      preferenceOrder: row.preference_order as number | undefined,
      cannotUse: (row.cannot_use as number) === 1,
    }));
  }

  // Protocol performance operations
  async updateProtocolPerformance(protocol: string, acked: boolean, latencyMs?: number): Promise<void> {
    const now = Date.now();
    const ackedInt = acked ? 1 : 0;

    await this.executeWithRetry(() =>
      this.db.execute({
        sql: `
          INSERT INTO protocol_performance (protocol, total_sent, total_acked, avg_latency_ms, last_used_at)
          VALUES (?, 1, ?, ?, ?)
          ON CONFLICT(protocol) DO UPDATE SET
            total_sent = total_sent + 1,
            total_acked = total_acked + ?,
            avg_latency_ms = CASE
              WHEN ? IS NOT NULL THEN
                CASE
                  WHEN avg_latency_ms IS NULL THEN ?
                  ELSE (avg_latency_ms + ?) / 2
                END
              ELSE avg_latency_ms
            END,
            last_used_at = ?
        `,
        args: [
          protocol,
          ackedInt,
          latencyMs || null,
          now,
          ackedInt,
          latencyMs || null,
          latencyMs || null,
          latencyMs || null,
          now,
        ],
      })
    );
  }

  async getProtocolPerformance(): Promise<ProtocolPerformance[]> {
    const result = await this.db.execute(`
      SELECT * FROM protocol_performance ORDER BY avg_latency_ms ASC
    `);

    return result.rows.map((row) => ({
      protocol: row.protocol as string,
      totalSent: row.total_sent as number,
      totalAcked: row.total_acked as number,
      avgLatencyMs: row.avg_latency_ms as number,
      lastUsedAt: row.last_used_at as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}
