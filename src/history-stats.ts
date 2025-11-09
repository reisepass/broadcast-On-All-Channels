#!/usr/bin/env tsx
/**
 * Historical Statistics Viewer
 *
 * Displays statistics from SQLite chat databases
 *
 * Usage:
 *   npm run stats -- [database-path]
 *   tsx src/history-stats.ts ./data/chat.db
 *   tsx src/history-stats.ts ./data/continuous-test-*.db
 */

import { ChatDatabase } from './database.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface Stats {
  totalMessages: number;
  totalAcknowledgments: number;
  messagesWithReceipts: number;
  uniqueConversations: number;
  dateRange: { earliest: number; latest: number };
  protocols: Map<string, {
    totalDelivered: number;
    avgLatency: number;
    minLatency: number;
    maxLatency: number;
  }>;
  topConversations: Array<{
    from: string;
    to: string;
    count: number;
  }>;
}

async function getStats(db: ChatDatabase): Promise<Stats> {
  const stats: Stats = {
    totalMessages: 0,
    totalAcknowledgments: 0,
    messagesWithReceipts: 0,
    uniqueConversations: 0,
    dateRange: { earliest: Infinity, latest: 0 },
    protocols: new Map(),
    topConversations: [],
  };

  // Query messages
  const messagesResult = await (db as any).db.execute(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN is_acknowledgment = 1 THEN 1 END) as acks,
      MIN(timestamp) as earliest,
      MAX(timestamp) as latest,
      COUNT(DISTINCT from_identity || '-' || to_identity) as conversations
    FROM messages
  `);

  const msgRow = messagesResult.rows[0];
  if (msgRow) {
    stats.totalMessages = msgRow.total as number;
    stats.totalAcknowledgments = msgRow.acks as number;
    stats.dateRange.earliest = msgRow.earliest as number || 0;
    stats.dateRange.latest = msgRow.latest as number || 0;
    stats.uniqueConversations = msgRow.conversations as number;
  }

  // Query message receipts
  const receiptsResult = await (db as any).db.execute(`
    SELECT
      protocol,
      COUNT(*) as delivered,
      AVG(latency_ms) as avg_latency,
      MIN(latency_ms) as min_latency,
      MAX(latency_ms) as max_latency
    FROM message_receipts
    GROUP BY protocol
  `);

  for (const row of receiptsResult.rows) {
    stats.protocols.set(row.protocol as string, {
      totalDelivered: row.delivered as number,
      avgLatency: Math.round(row.avg_latency as number),
      minLatency: row.min_latency as number,
      maxLatency: row.max_latency as number,
    });
  }

  // Count messages with receipts
  const withReceiptsResult = await (db as any).db.execute(`
    SELECT COUNT(DISTINCT message_uuid) as count
    FROM message_receipts
  `);
  stats.messagesWithReceipts = withReceiptsResult.rows[0]?.count as number || 0;

  // Top conversations
  const topConvResult = await (db as any).db.execute(`
    SELECT
      from_identity,
      to_identity,
      COUNT(*) as count
    FROM messages
    WHERE is_acknowledgment = 0
    GROUP BY from_identity, to_identity
    ORDER BY count DESC
    LIMIT 5
  `);

  stats.topConversations = topConvResult.rows.map(row => ({
    from: (row.from_identity as string).substring(0, 50) + '...',
    to: (row.to_identity as string).substring(0, 50) + '...',
    count: row.count as number,
  }));

  return stats;
}

function displayStats(dbPath: string, stats: Stats) {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log(`║ DATABASE: ${dbPath.substring(0, 60).padEnd(60)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');

  // Overall statistics
  console.log('║ OVERALL STATISTICS                                                       ║');
  console.log('╟──────────────────────────────────────────────────────────────────────────╢');
  console.log(`║ Total Messages:              ${String(stats.totalMessages).padStart(10)} (${stats.totalAcknowledgments} acks)           ║`);
  console.log(`║ Messages with Receipts:      ${String(stats.messagesWithReceipts).padStart(10)}                         ║`);
  console.log(`║ Unique Conversations:        ${String(stats.uniqueConversations).padStart(10)}                         ║`);

  if (stats.dateRange.earliest > 0 && stats.dateRange.latest > 0) {
    const earliest = new Date(stats.dateRange.earliest).toLocaleString();
    const latest = new Date(stats.dateRange.latest).toLocaleString();
    const duration = stats.dateRange.latest - stats.dateRange.earliest;
    const durationStr = formatDuration(duration);

    console.log(`║ Time Range:                  ${earliest.padEnd(30)}       ║`);
    console.log(`║                              to ${latest.padEnd(27)}       ║`);
    console.log(`║ Duration:                    ${durationStr.padEnd(40)} ║`);
  }

  // Protocol performance
  if (stats.protocols.size > 0) {
    console.log('╟──────────────────────────────────────────────────────────────────────────╢');
    console.log('║ PROTOCOL PERFORMANCE                                                     ║');
    console.log('╟────────────────┬──────────┬──────────┬──────────┬─────────────────────────╢');
    console.log('║ Protocol       │ Delivered│ Avg (ms) │ Min (ms) │ Max (ms)                ║');
    console.log('╟────────────────┼──────────┼──────────┼──────────┼─────────────────────────╢');

    // Sort by avg latency
    const sorted = Array.from(stats.protocols.entries()).sort((a, b) => a[1].avgLatency - b[1].avgLatency);

    for (const [protocol, pstats] of sorted) {
      const name = protocol.padEnd(14);
      const delivered = String(pstats.totalDelivered).padStart(8);
      const avg = String(pstats.avgLatency).padStart(8);
      const min = String(pstats.minLatency).padStart(8);
      const max = String(pstats.maxLatency).padStart(8);

      console.log(`║ ${name} │ ${delivered} │ ${avg} │ ${min} │ ${max}          ║`);
    }
  }

  // Top conversations
  if (stats.topConversations.length > 0) {
    console.log('╟──────────────────────────────────────────────────────────────────────────╢');
    console.log('║ TOP CONVERSATIONS                                                        ║');
    console.log('╟──────────────────────────────────────────────────────────────────────────╢');

    for (const conv of stats.topConversations) {
      console.log(`║ From: ${conv.from.padEnd(40)} ${String(conv.count).padStart(3)} msgs ║`);
      console.log(`║   To: ${conv.to.padEnd(63)} ║`);
    }
  }

  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function findDatabaseFiles(pattern?: string): string[] {
  const dataDir = './data';

  if (!existsSync(dataDir)) {
    return [];
  }

  const files = readdirSync(dataDir)
    .filter(f => f.endsWith('.db') && !f.includes('-shm') && !f.includes('-wal'))
    .map(f => join(dataDir, f));

  if (pattern) {
    return files.filter(f => f.includes(pattern));
  }

  return files;
}

async function main() {
  const args = process.argv.slice(2);

  let dbPaths: string[] = [];

  if (args.length > 0) {
    // Check if arg is a specific file or pattern
    const arg = args[0];

    if (existsSync(arg)) {
      dbPaths = [arg];
    } else if (arg.includes('*')) {
      // Pattern matching
      const pattern = arg.replace('*', '');
      dbPaths = findDatabaseFiles(pattern);
    } else {
      console.error(`Error: Database file not found: ${arg}`);
      process.exit(1);
    }
  } else {
    // Find all databases in data directory
    dbPaths = findDatabaseFiles();
  }

  if (dbPaths.length === 0) {
    console.log('No database files found in ./data directory');
    console.log('');
    console.log('Usage:');
    console.log('  npm run stats                          # Show all databases');
    console.log('  npm run stats -- ./data/chat.db        # Specific database');
    console.log('  npm run stats -- continuous-test       # Pattern match');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('  HISTORICAL DATABASE STATISTICS');
  console.log('═══════════════════════════════════════════════════════════════════════════');

  for (const dbPath of dbPaths) {
    try {
      const db = await ChatDatabase.create(dbPath);
      const stats = await getStats(db);
      displayStats(dbPath, stats);
      db.close();
    } catch (error) {
      console.error(`\nError reading ${dbPath}:`, error);
    }
  }

  console.log('\n');
}

main().catch(console.error);
