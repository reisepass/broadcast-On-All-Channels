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

interface ProtocolStats {
  totalDelivered: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  last1min: number;
  last1hour: number;
  last1day: number;
  last1week: number;
  servers: Map<string, {
    delivered: number;
    avgLatency: number;
    minLatency: number;
    maxLatency: number;
  }>;
}

interface Stats {
  totalMessages: number;
  totalAcknowledgments: number;
  messagesWithReceipts: number;
  uniqueConversations: number;
  dateRange: { earliest: number; latest: number };
  protocols: Map<string, ProtocolStats>;
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

  // Query message receipts with time-based counts
  const now = Date.now();
  const oneMinAgo = now - (60 * 1000);
  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

  const receiptsResult = await (db as any).db.execute(`
    SELECT
      protocol,
      COUNT(*) as delivered,
      AVG(latency_ms) as avg_latency,
      MIN(latency_ms) as min_latency,
      MAX(latency_ms) as max_latency,
      SUM(CASE WHEN received_at >= ${oneMinAgo} THEN 1 ELSE 0 END) as last_1min,
      SUM(CASE WHEN received_at >= ${oneHourAgo} THEN 1 ELSE 0 END) as last_1hour,
      SUM(CASE WHEN received_at >= ${oneDayAgo} THEN 1 ELSE 0 END) as last_1day,
      SUM(CASE WHEN received_at >= ${oneWeekAgo} THEN 1 ELSE 0 END) as last_1week
    FROM message_receipts
    GROUP BY protocol
  `);

  for (const row of receiptsResult.rows) {
    stats.protocols.set(row.protocol as string, {
      totalDelivered: row.delivered as number,
      avgLatency: Math.round(row.avg_latency as number),
      minLatency: row.min_latency as number,
      maxLatency: row.max_latency as number,
      last1min: row.last_1min as number,
      last1hour: row.last_1hour as number,
      last1day: row.last_1day as number,
      last1week: row.last_1week as number,
      servers: new Map(),
    });
  }

  // Query per-server statistics
  const serverStatsResult = await (db as any).db.execute(`
    SELECT
      protocol,
      server,
      COUNT(*) as delivered,
      AVG(latency_ms) as avg_latency,
      MIN(latency_ms) as min_latency,
      MAX(latency_ms) as max_latency
    FROM message_receipts
    WHERE server IS NOT NULL
    GROUP BY protocol, server
  `);

  for (const row of serverStatsResult.rows) {
    const protocol = row.protocol as string;
    const server = row.server as string;
    const protocolStats = stats.protocols.get(protocol);

    if (protocolStats && server) {
      protocolStats.servers.set(server, {
        delivered: row.delivered as number,
        avgLatency: Math.round(row.avg_latency as number),
        minLatency: row.min_latency as number,
        maxLatency: row.max_latency as number,
      });
    }
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

    // Time-based message counts
    console.log('╟──────────────────────────────────────────────────────────────────────────╢');
    console.log('║ TIME-BASED MESSAGE COUNTS                                                ║');
    console.log('╟────────────────┬──────────┬──────────┬──────────┬─────────────────────────╢');
    console.log('║ Protocol       │  1 min   │  1 hour  │  1 day   │  1 week   │ Total       ║');
    console.log('╟────────────────┼──────────┼──────────┼──────────┼───────────┼─────────────╢');

    for (const [protocol, pstats] of sorted) {
      const name = protocol.padEnd(14);
      const min1 = String(pstats.last1min).padStart(8);
      const hour1 = String(pstats.last1hour).padStart(8);
      const day1 = String(pstats.last1day).padStart(8);
      const week1 = String(pstats.last1week).padStart(9);
      const total = String(pstats.totalDelivered).padStart(5);

      console.log(`║ ${name} │ ${min1} │ ${hour1} │ ${day1} │ ${week1} │ ${total}       ║`);
    }

    // Per-server statistics (only for protocols with multiple servers)
    for (const [protocol, pstats] of sorted) {
      if (pstats.servers.size > 1) {
        console.log('╟──────────────────────────────────────────────────────────────────────────╢');
        console.log(`║ ${protocol.toUpperCase()} - PER-SERVER BREAKDOWN${' '.repeat(73 - protocol.length - 27)}║`);
        console.log('╟────────────────┬──────────┬──────────┬──────────┬─────────────────────────╢');
        console.log('║ Server         │ Delivered│ Avg (ms) │ Min (ms) │ Max (ms)                ║');
        console.log('╟────────────────┼──────────┼──────────┼──────────┼─────────────────────────╢');

        // Sort servers by avg latency
        const sortedServers = Array.from(pstats.servers.entries()).sort((a, b) => a[1].avgLatency - b[1].avgLatency);

        for (const [server, sstats] of sortedServers) {
          // Extract server hostname for display
          const serverDisplay = server.replace(/^(wss?|mqtt):\/\//, '').replace(/:\d+$/, '').substring(0, 14).padEnd(14);
          const delivered = String(sstats.delivered).padStart(8);
          const avg = String(sstats.avgLatency).padStart(8);
          const min = String(sstats.minLatency).padStart(8);
          const max = String(sstats.maxLatency).padStart(8);

          console.log(`║ ${serverDisplay} │ ${delivered} │ ${avg} │ ${min} │ ${max}          ║`);
        }
      }
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
