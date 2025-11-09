#!/usr/bin/env node
/**
 * View statistics from legacy database
 *
 * Shows protocol performance from existing user databases
 */

import { ChatDatabase } from './database.js';
import { UserManager } from './user-manager.js';
import chalk from 'chalk';

async function main() {
  const userManager = new UserManager();
  const users = userManager.listUsers();

  if (users.length === 0) {
    console.log(chalk.yellow('No users found. Create a user first with: npm run chat'));
    return;
  }

  console.log(chalk.cyan.bold('\n═══════════════════════════════════════════════════════════'));
  console.log(chalk.cyan.bold('  Protocol Performance Statistics (Legacy Database)'));
  console.log(chalk.cyan.bold('═══════════════════════════════════════════════════════════\n'));

  for (const user of users) {
    console.log(chalk.white.bold(`📊 User: ${user.name}`));
    console.log(chalk.gray('─'.repeat(60)));

    const dbPath = userManager.getUserDbPath(user.name);
    const db = new ChatDatabase(dbPath);

    try {
      // Get protocol performance
      const performance = await db.getProtocolPerformance();

      if (performance.length === 0) {
        console.log(chalk.gray('  No statistics available yet.\n'));
        continue;
      }

      for (const perf of performance) {
        const successRate = perf.totalSent > 0
          ? ((perf.totalAcked / perf.totalSent) * 100).toFixed(1)
          : '0.0';

        console.log(chalk.white(`\n  ${perf.protocol}`));
        console.log(chalk.gray(`    Total Sent: ${perf.totalSent}`));
        console.log(chalk.gray(`    Total Acked: ${perf.totalAcked} (${successRate}%)`));

        if (perf.avgLatencyMs) {
          console.log(chalk.gray(`    Avg Latency: ${perf.avgLatencyMs}ms`));
        }

        if (perf.lastUsedAt) {
          const lastUsed = new Date(perf.lastUsedAt);
          console.log(chalk.gray(`    Last Used: ${lastUsed.toLocaleString()}`));
        }
      }

      console.log('');

      // Get message counts
      const messages = await db.getConversation('', '', 1000);
      const totalMessages = messages.length;
      const sentMessages = messages.filter(m => !m.isAcknowledgment).length;
      const ackMessages = messages.filter(m => m.isAcknowledgment).length;

      console.log(chalk.cyan('  Message Summary:'));
      console.log(chalk.gray(`    Total Messages: ${totalMessages}`));
      console.log(chalk.gray(`    Sent: ${sentMessages}`));
      console.log(chalk.gray(`    Acknowledgments: ${ackMessages}`));

      // Get messages by protocol
      const messagesByProtocol: Record<string, number> = {};
      for (const msg of messages) {
        if (msg.firstReceivedProtocol) {
          messagesByProtocol[msg.firstReceivedProtocol] =
            (messagesByProtocol[msg.firstReceivedProtocol] || 0) + 1;
        }
      }

      if (Object.keys(messagesByProtocol).length > 0) {
        console.log(chalk.cyan('\n  Messages Received by Protocol:'));
        for (const [protocol, count] of Object.entries(messagesByProtocol)) {
          console.log(chalk.gray(`    ${protocol}: ${count}`));
        }
      }

      db.close();
      console.log('\n');

    } catch (error) {
      console.error(chalk.red(`  Error reading database: ${error}`));
      console.log('');
    }
  }
}

main().catch(console.error);
