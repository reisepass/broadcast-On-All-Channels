#!/usr/bin/env bun
/**
 * CLI Chat Client
 *
 * Features:
 * - Creates or loads identity
 * - Connects to all or selected protocols
 * - Interactive chat mode
 * - Shows acknowledgments with checkmarks
 * - Color-coded received messages
 * - Displays message delivery times per protocol
 *
 * Usage:
 *   tsx src/cli.ts [options]
 *
 * Options:
 *   --protocols <list>    Comma-separated list of protocols (xmtp,nostr,mqtt,waku,iroh)
 *   --user <name>         Use specific user identity
 *   --chat <magnet-link>  Start chatting with this user immediately
 *   --help                Show this help message
 */

import * as readline from 'node:readline/promises';
import chalk from 'chalk';

import type { UnifiedIdentity } from './identity.js';
import { ChatDatabase } from './database.js';
import { ChatBroadcaster } from './chat-broadcaster.js';
import type { ChatMessage } from './message-types.js';
import { UserManager, type UserProfile } from './user-manager.js';
import type { BroadcasterOptions } from './broadcaster.js';
import { initLogger, type Logger } from './logger.js';

interface CLIArgs {
  protocols?: string[];
  user?: string;
  chat?: string;
  help?: boolean;
  verbose?: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--protocols' || arg === '-p') {
      const protocolList = argv[++i];
      if (protocolList) {
        args.protocols = protocolList.split(',').map(p => p.trim().toLowerCase());
      }
    } else if (arg === '--user' || arg === '-u') {
      args.user = argv[++i];
    } else if (arg === '--chat' || arg === '-c') {
      args.chat = argv[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
    }
  }

  return args;
}

function showHelp() {
  console.log(chalk.cyan.bold('Multi-Protocol Chat Client\n'));
  console.log('Usage:');
  console.log('  tsx src/cli.ts [options]\n');
  console.log('  npm run chat -- [options]\n');
  console.log('Options:');
  console.log('  --protocols, -p <list>    Use only specified protocols (comma-separated)');
  console.log('                            Available: xmtp, nostr, mqtt, waku, iroh');
  console.log('                            Example: --protocols xmtp,nostr,mqtt');
  console.log('                            Default: all protocols\n');
  console.log('  --user, -u <name>         Use specific user identity');
  console.log('                            Example: --user happy-blue-falcon\n');
  console.log('  --chat, -c <magnet-link>  Start chatting with this user immediately');
  console.log('                            Example: --chat magnet:?xt=urn%3A...\n');
  console.log('  --verbose, -v             Enable verbose logging to console');
  console.log('                            Logs are always saved to ~/.broadcast-on-all-channels/logs/<user>.log\n');
  console.log('  --help, -h                Show this help message\n');
  console.log('Examples:');
  console.log('  # Use only XMTP and Nostr');
  console.log('  tsx src/cli.ts --protocols xmtp,nostr\n');
  console.log('  # Use specific user and start chatting');
  console.log('  tsx src/cli.ts --user happy-blue-falcon --chat magnet:?xt=...\n');
  console.log('  # Use only MQTT with verbose logging');
  console.log('  npm run chat -- --protocols mqtt --verbose\n');
}

class ChatClient {
  private identity!: UnifiedIdentity;
  private db!: ChatDatabase;
  private broadcaster!: ChatBroadcaster;
  private chatPartner?: string;
  private rl!: readline.Interface;
  private userManager: UserManager;
  private currentUser!: UserProfile;
  private args: CLIArgs;
  private logger!: Logger;

  constructor(args: CLIArgs = {}) {
    this.userManager = new UserManager();
    this.args = args;
  }

  async start() {
    console.log(chalk.cyan.bold('═══════════════════════════════════════════════════════════'));
    console.log(chalk.cyan.bold('  Multi-Protocol Chat Client'));
    console.log(chalk.cyan.bold('═══════════════════════════════════════════════════════════\n'));

    // Select or create user (with optional pre-selection)
    await this.selectUser();

    // Initialize logger after user is selected
    this.logger = initLogger({
      username: this.currentUser.name,
      verbose: this.args.verbose || false,
    });

    if (this.args.verbose) {
      console.log(chalk.gray(`\n📝 Verbose logging enabled. Logs saved to: ${this.logger.getLogFilePath()}\n`));
    } else {
      console.log(chalk.gray(`\n📝 Logs saved to: ${this.logger.getLogFilePath()}`));
      console.log(chalk.gray(`   Use --verbose or -v to see logs in console\n`));
    }

    // Initialize database with user-specific path
    this.db = new ChatDatabase(this.userManager.getUserDbPath(this.currentUser.name));

    // Initialize broadcaster with protocol selection
    this.broadcaster = new ChatBroadcaster(this.identity, this.db, this.logger, this.getProtocolOptions());

    // Set up message handler
    this.broadcaster.onMessage((message, protocol) => {
      this.handleIncomingMessage(message, protocol);
    });

    // Set up receipt handler for timing updates
    this.broadcaster.onReceipt((messageUuid, protocol, isDuplicate) => {
      this.handleReceipt(messageUuid, protocol, isDuplicate);
    });

    // Initialize broadcaster
    console.log(chalk.yellow('🚀 Connecting to protocols...\n'));
    try {
      await this.broadcaster.initialize();
      await this.broadcaster.startListening();
      console.log(chalk.green('✅ Connected and listening for messages\n'));
    } catch (error) {
      console.log(chalk.yellow('⚠️  Some protocols may have connection issues'));
      console.log(chalk.gray(`   ${error}\n`));
      console.log(chalk.green('✅ Continuing with available protocols\n'));
    }

    // If --chat was provided, start chatting immediately
    if (this.args.chat) {
      this.chatPartner = this.args.chat;
      console.log(chalk.green(`✅ Starting chat with: ${this.chatPartner.slice(0, 50)}...`));
      console.log(chalk.gray('Type your messages and press Enter to send\n'));
      await this.showConversationHistory();
    }

    // Start interactive mode
    await this.interactiveMode();
  }

  private getProtocolOptions(): Partial<BroadcasterOptions> {
    const options: Partial<BroadcasterOptions> = {};

    if (this.args.protocols && this.args.protocols.length > 0) {
      // Show which protocols are being used
      console.log(chalk.yellow(`🔧 Using selected protocols: ${this.args.protocols.join(', ')}\n`));

      // Disable all protocols by default, then enable only selected ones
      options.xmtpEnabled = this.args.protocols.includes('xmtp');
      options.nostrEnabled = this.args.protocols.includes('nostr');
      options.mqttEnabled = this.args.protocols.includes('mqtt');
      options.wakuEnabled = this.args.protocols.includes('waku');
      options.irohEnabled = this.args.protocols.includes('iroh');
    }

    return options;
  }

  private async selectUser() {
    const users = this.userManager.listUsers();

    // If user specified via CLI args, use that
    if (this.args.user) {
      const user = this.userManager.loadUser(this.args.user);
      if (user) {
        this.currentUser = user;
        this.userManager.updateLastUsed(this.currentUser.name);
        console.log(chalk.green(`✅ Using user: ${chalk.bold(this.currentUser.name)}\n`));
        this.identity = this.currentUser.identity;
        return;
      } else {
        console.log(chalk.red(`❌ User '${this.args.user}' not found. Available users:\n`));
        users.forEach(u => console.log(chalk.gray(`  - ${u.name}`)));
        console.log('');
        process.exit(1);
      }
    }

    if (users.length === 0) {
      console.log(chalk.blue('👋 Welcome! Creating your first user...\n'));
      this.currentUser = this.userManager.createUser();
      console.log(chalk.green(`✅ Created user: ${chalk.bold(this.currentUser.name)}\n`));
    } else {
      console.log(chalk.yellow('📋 Select a user or create a new one:\n'));

      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const lastUsed = new Date(user.lastUsedAt).toLocaleString();
        console.log(chalk.gray(`  ${i + 1}. ${chalk.white(user.name)} (last used: ${lastUsed})`));
      }
      console.log(chalk.gray(`  ${users.length + 1}. ${chalk.green('Create new user')}`));
      console.log('');

      // Create temporary readline interface for selection
      const tempRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      while (true) {
        const answer = await tempRl.question(chalk.yellow('Your choice: '));
        const choice = parseInt(answer);

        if (choice >= 1 && choice <= users.length) {
          this.currentUser = users[choice - 1];
          this.userManager.updateLastUsed(this.currentUser.name);
          console.log(chalk.green(`\n✅ Using user: ${chalk.bold(this.currentUser.name)}\n`));
          tempRl.close();
          break;
        } else if (choice === users.length + 1) {
          this.currentUser = this.userManager.createUser();
          console.log(chalk.green(`\n✅ Created user: ${chalk.bold(this.currentUser.name)}\n`));
          tempRl.close();
          break;
        } else {
          console.log(chalk.red('Invalid choice. Please try again.'));
        }
      }
    }

    // Set identity from user profile
    this.identity = this.currentUser.identity;

    // Display identity
    console.log(chalk.cyan('Your Identity:\n'));
    console.log(chalk.gray('User Name:'), chalk.white.bold(this.currentUser.name));
    console.log('');
    console.log(chalk.gray('secp256k1 (XMTP, Nostr, Waku, MQTT):'));
    console.log(chalk.gray('  Ethereum Address:'), chalk.white(this.identity.secp256k1.ethereumAddress));
    console.log('');
    console.log(chalk.gray('Ed25519 (IROH):'));
    console.log(chalk.gray('  Node ID:'), chalk.white(this.identity.ed25519.nodeId.slice(0, 16) + '...'));
    console.log('');
    console.log(chalk.yellow('📎 Your Magnet Link (share this):'));
    console.log(chalk.cyan(this.identity.magnetLink));
    console.log('');
  }

  private async interactiveMode() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(chalk.yellow('\n💬 Interactive Chat Mode\n'));
    console.log(chalk.gray('Commands:'));
    console.log(chalk.gray('  /chat <magnet-link> - Start chatting with someone'));
    console.log(chalk.gray('  /history - Show conversation history'));
    console.log(chalk.gray('  /status - Show protocol status'));
    console.log(chalk.gray('  /quit - Exit'));
    console.log('');

    while (true) {
      const input = await this.rl.question(
        this.chatPartner
          ? chalk.green('You: ')
          : chalk.yellow('Command: ')
      );

      if (!input.trim()) continue;

      if (input.startsWith('/')) {
        await this.handleCommand(input);
      } else {
        if (!this.chatPartner) {
          console.log(chalk.red('❌ Not in chat mode. Use /chat <magnet-link> to start chatting'));
          continue;
        }
        await this.sendMessage(input);
      }
    }
  }

  private async handleCommand(input: string) {
    const parts = input.split(' ');
    const command = parts[0].toLowerCase();

    switch (command) {
      case '/chat':
        if (parts.length < 2) {
          console.log(chalk.red('❌ Usage: /chat <magnet-link>'));
          return;
        }
        this.chatPartner = parts.slice(1).join(' ');
        console.log(chalk.green(`✅ Now chatting with: ${this.chatPartner.slice(0, 50)}...`));
        console.log(chalk.gray('Type your messages and press Enter to send\n'));
        await this.showConversationHistory();
        break;

      case '/history':
        await this.showConversationHistory();
        break;

      case '/status':
        await this.showProtocolStatus();
        break;

      case '/quit':
        console.log(chalk.yellow('\n👋 Goodbye!'));
        this.db.close();
        process.exit(0);

      default:
        console.log(chalk.red(`❌ Unknown command: ${command}`));
    }
  }

  private async sendMessage(content: string) {
    if (!this.chatPartner) return;

    const sentAt = Date.now();
    console.log(chalk.gray(`\n📤 Sending...`));

    try {
      const results = await this.broadcaster.sendMessage(this.chatPartner, content);

      // Display results with checkmarks
      console.log(chalk.gray('Delivery status:'));
      for (const result of results) {
        if (result.success) {
          console.log(chalk.green(`  ✓ ${result.protocol.padEnd(20)} ${result.latencyMs}ms`));
        } else {
          console.log(chalk.red(`  ✗ ${result.protocol.padEnd(20)} Failed`));
        }
      }
      console.log('');
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error}`));
    }
  }

  private handleIncomingMessage(message: ChatMessage, protocol: string) {
    // Only show if from current chat partner
    if (this.chatPartner && message.fromMagnetLink !== this.chatPartner) {
      return;
    }

    // Skip acknowledgments (we handle them silently)
    if (message.type === 'acknowledgment') {
      // Get the original message and show checkmark
      const receipts = this.db.getMessageReceipts(message.content.replace('ACK: ', ''));
      if (receipts.length > 0) {
        console.log(chalk.green(`\n  ✓ Acknowledged via ${protocol} (+${Date.now() - message.timestamp}ms)`));
      }
      return;
    }

    // Get all receipts for this message
    const receipts = this.db.getMessageReceipts(message.uuid);
    const firstReceipt = receipts[0];

    // Display the message
    console.log('');
    console.log(chalk.blue.bold(`Them: ${message.content}`));

    // Show first protocol (fastest)
    if (firstReceipt) {
      console.log(chalk.green(`  ⚡ First received via: ${chalk.bold(firstReceipt.protocol)}`));
    } else {
      console.log(chalk.green(`  ⚡ First received via: ${chalk.bold(protocol)}`));
    }

    // Show subsequent receipts with time deltas
    if (receipts.length > 1) {
      console.log(chalk.gray(`  📡 Also received via:`));
      for (let i = 1; i < receipts.length; i++) {
        const receipt = receipts[i];
        const delta = receipt.receivedAt - firstReceipt.receivedAt;
        console.log(chalk.gray(`     • ${chalk.white(receipt.protocol)} ${chalk.yellow(`+${delta}ms slower`)}`));
      }
    }
    console.log('');

    // Redraw prompt
    if (this.chatPartner) {
      process.stdout.write(chalk.green('You: '));
    }
  }

  private handleReceipt(messageUuid: string, protocol: string, isDuplicate: boolean) {
    // Only show updates for duplicate receipts (subsequent protocols)
    if (!isDuplicate) {
      return;
    }

    try {
      // Get all receipts for this message
      const receipts = this.db.getMessageReceipts(messageUuid);
      if (receipts.length < 2) {
        return; // First receipt only, nothing to compare yet
      }

      const firstReceipt = receipts[0];
      const currentReceipt = receipts.find(r => r.protocol === protocol);

      if (!currentReceipt || !firstReceipt) {
        return; // Safety check - receipt not found
      }

      const delta = currentReceipt.receivedAt - firstReceipt.receivedAt;

      // Show the update
      console.log(chalk.gray(`\n  📡 Also received via: ${chalk.white(protocol)} ${chalk.yellow(`+${delta}ms slower`)}`));

      // Redraw prompt
      if (this.chatPartner) {
        process.stdout.write(chalk.green('You: '));
      }
    } catch (error) {
      // Silently ignore - this is just for display, not critical
      this.logger.debug('Error in handleReceipt:', error);
    }
  }

  private async showConversationHistory() {
    if (!this.chatPartner) {
      console.log(chalk.red('❌ Not in chat mode'));
      return;
    }

    const messages = await this.db.getConversation(this.identity.magnetLink, this.chatPartner, 20);

    if (messages.length === 0) {
      console.log(chalk.gray('\n📭 No message history\n'));
      return;
    }

    console.log(chalk.cyan('\n📜 Conversation History:\n'));

    for (const msg of messages) {
      if (msg.isAcknowledgment) continue; // Skip acks in history

      const isFromMe = msg.fromIdentity === this.identity.magnetLink;
      const prefix = isFromMe ? chalk.green('You:') : chalk.blue('Them:');
      const time = new Date(msg.timestamp).toLocaleTimeString();

      console.log(`${chalk.gray(`[${time}]`)} ${prefix} ${msg.content}`);

      if (msg.firstReceivedProtocol) {
        console.log(chalk.gray(`  via ${msg.firstReceivedProtocol}`));
      }
    }
    console.log('');
  }

  private async showProtocolStatus() {
    const performance = await this.db.getProtocolPerformance();

    console.log(chalk.cyan('\n📊 Protocol Performance:\n'));

    if (performance.length === 0) {
      console.log(chalk.gray('No data yet\n'));
      return;
    }

    for (const perf of performance) {
      const successRate = perf.totalSent > 0
        ? ((perf.totalAcked / perf.totalSent) * 100).toFixed(1)
        : '0.0';

      console.log(chalk.white(perf.protocol));
      console.log(chalk.gray(`  Sent: ${perf.totalSent}, Acked: ${perf.totalAcked} (${successRate}%)`));
      console.log(chalk.gray(`  Avg Latency: ${perf.avgLatencyMs || 'N/A'}ms`));
      console.log('');
    }
  }
}

// Parse command-line arguments
const args = parseArgs();

// Show help and exit if requested
if (args.help) {
  showHelp();
  process.exit(0);
}

// Start the client with parsed arguments
const client = new ChatClient(args);
client.start().catch(console.error);
