#!/usr/bin/env node
/**
 * Detailed Statistics Viewer
 *
 * Shows comprehensive protocol performance with visual charts
 */

import { ChatDatabase } from './database.js';
import { UserManager } from './user-manager.js';
import chalk from 'chalk';

interface ProtocolStats {
  protocol: string;
  sent: number;
  acked: number;
  successRate: number;
  avgLatency: number;
  lastUsed: number;
}

function createBarChart(value: number, max: number, width: number = 20): string {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function formatLatency(ms: number): string {
  if (ms < 100) return chalk.green(`${ms}ms`);
  if (ms < 500) return chalk.yellow(`${ms}ms`);
  return chalk.red(`${ms}ms`);
}

function formatSuccessRate(rate: number): string {
  if (rate >= 95) return chalk.green(`${rate.toFixed(1)}%`);
  if (rate >= 80) return chalk.yellow(`${rate.toFixed(1)}%`);
  return chalk.red(`${rate.toFixed(1)}%`);
}

async function main() {
  const userManager = new UserManager();
  const users = userManager.listUsers();

  if (users.length === 0) {
    console.log(chalk.yellow('\nNo users found. Create a user first with: npm run chat\n'));
    return;
  }

  console.log(chalk.cyan.bold('\n╔═══════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║     Detailed Protocol Performance Statistics             ║'));
  console.log(chalk.cyan.bold('╚═══════════════════════════════════════════════════════════╝\n'));

  for (const user of users) {
    console.log(chalk.white.bold(`\n👤 User: ${user.name}`));
    console.log(chalk.gray('═'.repeat(63)));

    const dbPath = userManager.getUserDbPath(user.name);
    const db = new ChatDatabase(dbPath);

    try {
      const performance = await db.getProtocolPerformance();

      if (performance.length === 0) {
        console.log(chalk.gray('  No data collected yet. Send some messages first!\n'));
        db.close();
        continue;
      }

      // Prepare stats
      const stats: ProtocolStats[] = performance.map(perf => ({
        protocol: perf.protocol,
        sent: perf.totalSent,
        acked: perf.totalAcked,
        successRate: perf.totalSent > 0 ? (perf.totalAcked / perf.totalSent) * 100 : 0,
        avgLatency: perf.avgLatencyMs || 0,
        lastUsed: perf.lastUsedAt || 0,
      }));

      // Sort by success rate (best first)
      stats.sort((a, b) => b.successRate - a.successRate);

      const maxSent = Math.max(...stats.map(s => s.sent));
      const maxLatency = Math.max(...stats.map(s => s.avgLatency));

      console.log('');

      // Performance Overview
      console.log(chalk.cyan.bold('📊 Performance Overview:\n'));

      for (const stat of stats) {
        console.log(chalk.white.bold(`  ${stat.protocol}`));
        console.log(chalk.gray(`  ┌─────────────────────────────────────────────────────────`));

        // Messages sent
        console.log(chalk.gray(`  │ Messages Sent:  ${chalk.white(stat.sent.toString().padStart(4))} ${createBarChart(stat.sent, maxSent)}`));

        // Success rate
        console.log(chalk.gray(`  │ Success Rate:   ${formatSuccessRate(stat.successRate).padStart(18)} ${createBarChart(stat.successRate, 100)}`));

        // Latency
        if (stat.avgLatency > 0) {
          console.log(chalk.gray(`  │ Avg Latency:    ${formatLatency(stat.avgLatency).padStart(18)} ${createBarChart(stat.avgLatency, maxLatency)}`));
        }

        // Last used
        if (stat.lastUsed > 0) {
          const timeAgo = formatTimeAgo(Date.now() - stat.lastUsed);
          console.log(chalk.gray(`  │ Last Used:      ${chalk.white(timeAgo)} ago`));
        }

        console.log(chalk.gray(`  └─────────────────────────────────────────────────────────\n`));
      }

      // Ranking
      console.log(chalk.cyan.bold('🏆 Protocol Rankings:\n'));

      // By Reliability
      const byReliability = [...stats].sort((a, b) => b.successRate - a.successRate);
      console.log(chalk.yellow('  Most Reliable:'));
      byReliability.slice(0, 3).forEach((stat, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
        console.log(`  ${medal} ${chalk.white(stat.protocol.padEnd(25))} ${formatSuccessRate(stat.successRate)}`);
      });

      // By Speed
      const bySpeed = [...stats].filter(s => s.avgLatency > 0).sort((a, b) => a.avgLatency - b.avgLatency);
      if (bySpeed.length > 0) {
        console.log(chalk.yellow('\n  Fastest:'));
        bySpeed.slice(0, 3).forEach((stat, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
          console.log(`  ${medal} ${chalk.white(stat.protocol.padEnd(25))} ${formatLatency(stat.avgLatency)}`);
        });
      }

      // Summary statistics
      const totalSent = stats.reduce((sum, s) => sum + s.sent, 0);
      const totalAcked = stats.reduce((sum, s) => sum + s.acked, 0);
      const avgSuccessRate = totalSent > 0 ? (totalAcked / totalSent) * 100 : 0;
      const avgLatency = stats.reduce((sum, s) => sum + s.avgLatency, 0) / stats.filter(s => s.avgLatency > 0).length;

      console.log(chalk.cyan.bold('\n📈 Overall Statistics:\n'));
      console.log(chalk.gray(`  Total Messages Sent:      ${chalk.white(totalSent)}`));
      console.log(chalk.gray(`  Total Acknowledged:       ${chalk.white(totalAcked)}`));
      console.log(chalk.gray(`  Overall Success Rate:     ${formatSuccessRate(avgSuccessRate)}`));
      if (!isNaN(avgLatency)) {
        console.log(chalk.gray(`  Average Latency:          ${formatLatency(Math.round(avgLatency))}`));
      }
      console.log(chalk.gray(`  Active Protocols:         ${chalk.white(stats.length)}`));

      db.close();

    } catch (error: any) {
      console.error(chalk.red(`  Error: ${error.message}`));
    }

    console.log('');
  }

  console.log(chalk.gray('─'.repeat(63)));
  console.log(chalk.cyan('💡 Tip: Run ') + chalk.white('npm run chat') + chalk.cyan(' to generate more data\n'));
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

main().catch(console.error);
