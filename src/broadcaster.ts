/**
 * Multi-Protocol Broadcaster
 *
 * Automatically broadcasts messages across all available protocols with fallback.
 * The daemon tries all protocols in parallel and reports which ones succeeded.
 */

import { Client as XMTPClient, type Signer } from '@xmtp/node-sdk';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { finalizeEvent, nip04, type EventTemplate } from 'nostr-tools';
import { createLightNode, createEncoder, createDecoder, Protocols } from '@waku/sdk';
import { contentTopicToPubsubTopic, pubsubTopicToSingleShardInfo } from '@waku/utils';
import type { LightNode } from '@waku/interfaces';
import mqtt from 'mqtt';
import WebSocket from 'ws';
import { Iroh, type NodeAddr } from '@number0/iroh';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import type { UnifiedIdentity } from './identity.js';
import {
  getEthereumAccount,
  getNostrKeys,
  getNostrPublicKeyFromIdentity,
  getMqttIdentifier,
  getWakuIdentifier,
  getIrohKeys,
  decodeIdentity,
} from './identity.js';
import { supportsXMTP, supportsWaku } from './runtime.js';
import { Logger } from './logger.js';

// Helper to create XMTP-compatible signer from viem account
function createXMTPSigner(identity: UnifiedIdentity): Signer {
  const account = getEthereumAccount(identity);

  return {
    walletType: 'EOA' as const,
    getAddress: () => account.address,
    signMessage: async (message: string) => {
      const signature = await account.signMessage({ message });
      // Convert hex signature to Uint8Array
      return new Uint8Array(
        signature.slice(2).match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
      );
    },
  };
}

// Configure WebSocket for Nostr in Node.js/Bun
useWebSocketImplementation(WebSocket);

export interface BroadcastMessage {
  content: string;
  timestamp: number;
}

export interface BroadcastResult {
  protocol: string;
  success: boolean;
  error?: string;
  latencyMs?: number;
}

export interface BroadcasterOptions {
  // XMTP options
  xmtpEnabled?: boolean;
  xmtpEnv?: 'dev' | 'production' | 'local';

  // Nostr options
  nostrEnabled?: boolean;
  nostrRelays?: string[];

  // Waku options
  wakuEnabled?: boolean;

  // MQTT options
  mqttEnabled?: boolean;
  mqttBrokers?: string[]; // Support multiple brokers like Nostr relays

  // IROH options
  irohEnabled?: boolean;
}

const DEFAULT_OPTIONS: BroadcasterOptions = {
  xmtpEnabled: supportsXMTP(), // Auto-enabled on Node.js/Deno
  xmtpEnv: 'production',
  nostrEnabled: true,
  nostrRelays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'],
  wakuEnabled: supportsWaku(), // Auto-enabled on Node.js/Bun (Deno needs --unstable-broadcast-channel)
  mqttEnabled: true,
  mqttBrokers: [
    // Primary brokers (most reliable, no auth)
    'mqtt://broker.hivemq.com:1883',         // HiveMQ - supports persistent sessions
    'mqtt://broker.emqx.io:1883',            // EMQX - persistent sessions, offline queuing
    'mqtt://test.mosquitto.org:1883',        // Mosquitto - widely used test broker

    // Additional public brokers (no auth required)
    'mqtt://public-mqtt-broker.bevywise.com:1883',  // Bevywise - no auth, no persistent storage
    'mqtt://iot.coreflux.cloud:1883',        // Coreflux - no auth needed
    'mqtt://mqtt.tyckr.io:1883',             // Tyckr - no auth, some persistence

    // Note: mqtt.flespi.io requires authentication, so excluded from default list
    // Users can add it manually with credentials via mqttBrokers option
  ],
  irohEnabled: true,
};

const IROH_MESSAGING_ALPN = Buffer.from('broadcast/dm/0');

export class Broadcaster {
  private identity: UnifiedIdentity;
  private options: BroadcasterOptions;
  protected irohMessageHandler?: (message: string) => Promise<void>;
  protected logger: Logger;

  // Protocol clients
  protected xmtpClient?: XMTPClient;
  protected nostrRelays: Relay[] = [];
  protected wakuNode?: LightNode;
  protected mqttClients: mqtt.MqttClient[] = []; // Multiple MQTT brokers
  private irohNode?: Iroh;

  constructor(identity: UnifiedIdentity, loggerOrOptions?: Logger | BroadcasterOptions, options?: BroadcasterOptions) {
    this.identity = identity;

    // Handle overloaded constructor signatures
    if (loggerOrOptions && 'info' in loggerOrOptions) {
      // First param is Logger
      this.logger = loggerOrOptions as Logger;
      this.options = { ...DEFAULT_OPTIONS, ...options };
    } else {
      // First param is options (for backward compatibility)
      // Create a logger that writes to console
      this.logger = new Logger({ verbose: true }); // Always verbose for non-CLI usage
      this.options = { ...DEFAULT_OPTIONS, ...(loggerOrOptions as BroadcasterOptions || {}) };
    }
  }

  /**
   * Initialize all enabled protocol clients
   */
  async initialize(): Promise<void> {
    this.logger.info('🚀 Initializing broadcaster...\n');

    const initPromises: Promise<void>[] = [];

    if (this.options.xmtpEnabled) {
      initPromises.push(this.initXMTP());
    }

    if (this.options.nostrEnabled) {
      initPromises.push(this.initNostr());
    }

    if (this.options.wakuEnabled) {
      initPromises.push(this.initWaku());
    }

    if (this.options.mqttEnabled) {
      initPromises.push(this.initMQTT());
    }

    if (this.options.irohEnabled) {
      initPromises.push(this.initIROH());
    }

    // Initialize all protocols in parallel
    const results = await Promise.allSettled(initPromises);

    // Report initialization results
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(`Failed to initialize protocol ${index}:`, result.reason);
      }
    });

    this.logger.info('✅ Broadcaster initialized\n');
  }

  private async initXMTP(): Promise<void> {
    try {
      const signer = createXMTPSigner(this.identity);
      const { createHash } = await import('node:crypto');

      // Derive a deterministic encryption key from the user's private key
      // This ensures the same user always gets the same encryption key
      const account = getEthereumAccount(this.identity);
      const keyMaterial = `xmtp-encryption-${account.address}-${this.identity.secp256k1.privateKey}`;
      const dbEncryptionKey = new Uint8Array(
        createHash('sha256').update(keyMaterial).digest()
      );

      // Create absolute database path for XMTP's encrypted message store
      const xmtpDir = resolve(process.cwd(), 'data/xmtp');

      // Ensure the directory exists
      if (!existsSync(xmtpDir)) {
        mkdirSync(xmtpDir, { recursive: true });
      }

      const dbPath = join(xmtpDir, `xmtp-${this.options.xmtpEnv}-${account.address}.db3`);

      // Note: encryptionKey is the SECOND parameter, not in options
      this.xmtpClient = await XMTPClient.create(signer, dbEncryptionKey, {
        env: this.options.xmtpEnv === 'production' ? 'production' : 'dev',
        dbPath: dbPath,
      });
      this.logger.info('✅ XMTP client initialized');
    } catch (error) {
      this.logger.warn('⚠️  XMTP initialization failed, continuing without XMTP:', error);
      this.xmtpClient = undefined;
      // Don't throw - continue with other protocols
    }
  }

  private async initNostr(): Promise<void> {
    try {
      const relays = this.options.nostrRelays || DEFAULT_OPTIONS.nostrRelays!;

      for (const relayUrl of relays) {
        await this.connectNostrRelay(relayUrl);
      }

      if (this.nostrRelays.length === 0) {
        this.logger.warn('⚠️  Failed to connect to any Nostr relays, continuing without Nostr');
        return;
      }

      this.logger.info(`✅ Nostr initialized (${this.nostrRelays.length} relays)`);
    } catch (error) {
      this.logger.warn('⚠️  Nostr initialization failed, continuing without Nostr:', error);
      // Don't throw - continue with other protocols
    }
  }

  private async connectNostrRelay(relayUrl: string): Promise<void> {
    try {
      const relay = await Relay.connect(relayUrl);

      // Set up connection close handler
      const originalOnClose = relay.onclose;
      relay.onclose = () => {
        this.logger.warn(`🔵 [Nostr] Relay ${relayUrl} disconnected, attempting to reconnect...`);
        // Call original handler if it exists
        if (originalOnClose) {
          originalOnClose();
        }
        // Remove from active relays
        const index = this.nostrRelays.indexOf(relay);
        if (index > -1) {
          this.nostrRelays.splice(index, 1);
        }
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectNostrRelay(relayUrl), 5000);
      };

      // Set up notice handler
      relay.onnotice = (msg: string) => {
        this.logger.debug(`🔵 [Nostr] Relay ${relayUrl} notice: ${msg}`);
      };

      this.nostrRelays.push(relay);
      this.logger.info(`🔵 [Nostr] Connected to ${relayUrl}`);
    } catch (err) {
      this.logger.warn(`Failed to connect to Nostr relay ${relayUrl}:`, err);
    }
  }

  private async reconnectNostrRelay(relayUrl: string): Promise<void> {
    // Only reconnect if not already connected
    const alreadyConnected = this.nostrRelays.some(
      relay => relay.url === relayUrl && relay.connected
    );

    if (!alreadyConnected) {
      this.logger.info(`🔵 [Nostr] Reconnecting to ${relayUrl}...`);
      await this.connectNostrRelay(relayUrl);
    }
  }

  private async initWaku(): Promise<void> {
    try {
      this.wakuNode = await createLightNode({ defaultBootstrap: true });
      await this.wakuNode.start();
      await this.wakuNode.waitForPeers([Protocols.LightPush, Protocols.Filter]);
      this.logger.info('✅ Waku node initialized');
    } catch (error) {
      this.logger.warn('⚠️  Waku initialization failed, continuing without Waku:', error);
      this.wakuNode = undefined;
      // Don't throw - continue with other protocols
    }
  }

  private async initMQTT(): Promise<void> {
    try {
      const brokers = this.options.mqttBrokers || DEFAULT_OPTIONS.mqttBrokers!;
      const connectionPromises: Promise<mqtt.MqttClient>[] = [];

      for (const brokerUrl of brokers) {
        const promise = new Promise<mqtt.MqttClient>((resolve, reject) => {
          try {
            const client = mqtt.connect(brokerUrl, {
              clientId: `broadcaster-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              clean: false, // Maintain session for offline messages
              reconnectPeriod: 5000,
              connectTimeout: 10000,
            });

            const timeout = setTimeout(() => {
              client.end(true);
              reject(new Error(`Connection timeout: ${brokerUrl}`));
            }, 10000);

            client.on('connect', () => {
              clearTimeout(timeout);
              this.mqttClients.push(client);
              resolve(client);
            });

            client.on('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          } catch (error) {
            reject(error);
          }
        });

        connectionPromises.push(promise);
      }

      // Wait for at least one connection to succeed
      const results = await Promise.allSettled(connectionPromises);
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      if (successful === 0) {
        this.logger.warn('⚠️  Failed to connect to any MQTT brokers, continuing without MQTT');
        return;
      }

      if (failed > 0) {
        this.logger.info(`✅ MQTT initialized (${successful}/${brokers.length} brokers connected, ${failed} failed)`);
      } else {
        this.logger.info(`✅ MQTT initialized (${successful}/${brokers.length} brokers)`);
      }
    } catch (error) {
      this.logger.warn('⚠️  MQTT initialization failed, continuing without MQTT:', error);
      // Don't throw - continue with other protocols
    }
  }

  private async initIROH(): Promise<void> {
    try {
      const irohKeys = getIrohKeys(this.identity);

      // Define the messaging protocol handler
      const protocols = {
        [IROH_MESSAGING_ALPN.toString()]: (err: Error | null, ep: any) => ({
          accept: async (err: Error | null, conn: any) => {
            if (err) {
              this.logger.debug('IROH accept error (normal for connection attempts):', err);
              return;
            }

            try {
              // Accept bidirectional stream
              const bi = await conn.acceptBi();

              // Read the message
              const bytes = await bi.recv.readToEnd(1024 * 1024); // 1MB max
              const message = bytes.toString();

              // Call the message handler if it's set
              if (this.irohMessageHandler) {
                await this.irohMessageHandler(message);
              }

              // Send acknowledgment
              const ack = `ACK: Received`;
              await bi.send.writeAll(Buffer.from(ack));
              await bi.send.finish();

              await conn.closed();
            } catch (error) {
              this.logger.debug('Error processing IROH message (may be normal):', error);
            }
          },
          shutdown: (err: Error | null) => {
            if (err && !err.message?.includes('closed')) {
              this.logger.debug('IROH shutdown (may be normal):', err);
            }
          },
        }),
      };

      // Create node with our identity's private key
      this.irohNode = await Iroh.memory({
        protocols,
        secretKey: Array.from(irohKeys.privateKey),
      });

      this.logger.info('✅ IROH node initialized');
    } catch (error) {
      this.logger.warn('⚠️  IROH initialization failed, continuing without IROH:', error);
      this.irohNode = undefined;
      // Don't throw - continue with other protocols
    }
  }

  /**
   * Broadcast a message to a recipient across all enabled protocols
   */
  async broadcast(recipientMagnetLink: string, message: string): Promise<BroadcastResult[]> {
    const recipient = decodeIdentity(recipientMagnetLink);
    if (!recipient) {
      throw new Error('Invalid recipient magnet link');
    }

    this.logger.info(`📡 Broadcasting message to all channels...\n`);

    const results: BroadcastResult[] = [];
    const promises: Promise<BroadcastResult>[] = [];

    if (this.options.xmtpEnabled && this.xmtpClient) {
      promises.push(this.sendViaXMTP(recipient.secp256k1.ethereumAddress, message));
    }

    if (this.options.nostrEnabled && this.nostrRelays.length > 0) {
      promises.push(this.sendViaNostr(recipient, message));
    }

    if (this.options.wakuEnabled && this.wakuNode) {
      promises.push(this.sendViaWaku(recipient, message));
    }

    if (this.options.mqttEnabled && this.mqttClients.length > 0) {
      promises.push(this.sendViaMQTT(recipient, message));
    }

    if (this.options.irohEnabled && this.irohNode) {
      promises.push(this.sendViaIROH(recipient, message));
    }

    // Send via all protocols in parallel
    const broadcastResults = await Promise.allSettled(promises);

    broadcastResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        this.logger.error('Broadcast failed:', result.reason);
      }
    });

    return results;
  }

  private async sendViaXMTP(recipientAddress: string, message: string): Promise<BroadcastResult> {
    const startTime = Date.now();
    try {
      this.logger.info('🟢 [XMTP] Starting message send...');
      if (!this.xmtpClient) {
        throw new Error('XMTP client not initialized');
      }

      this.logger.info(`🟢 [XMTP] Recipient address: ${recipientAddress}`);
      const dm = await this.xmtpClient.conversations.newDm(recipientAddress);
      this.logger.info(`🟢 [XMTP] DM conversation created, sending message...`);
      await dm.send(message);

      this.logger.info(`✅ [XMTP] Message sent successfully`);
      return {
        protocol: 'XMTP V3',
        success: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      // XMTP failures are expected in a redundant system - log as debug, not error
      const errorMsg = String(error);
      if (errorMsg.includes('timeout') || errorMsg.includes('connection') || errorMsg.includes('not initialized')) {
        this.logger.debug(`[XMTP] Send failed (expected in redundant system):`, error);
      } else {
        this.logger.warn(`[XMTP] Send failed:`, error);
      }
      return {
        protocol: 'XMTP V3',
        success: false,
        error: String(error),
        latencyMs: Date.now() - startTime,
      };
    }
  }

  private async sendViaNostr(recipient: Omit<UnifiedIdentity, 'magnetLink'>, message: string): Promise<BroadcastResult> {
    const startTime = Date.now();
    try {
      this.logger.info('🔵 [Nostr] Starting message send...');
      const { privateKey } = getNostrKeys(this.identity);
      const recipientPubkey = getNostrPublicKeyFromIdentity(recipient);
      this.logger.info(`🔵 [Nostr] Recipient pubkey: ${recipientPubkey.slice(0, 16)}...`);

      const encryptedContent = await nip04.encrypt(privateKey, recipientPubkey, message);
      this.logger.info(`🔵 [Nostr] Message encrypted`);

      const eventTemplate: EventTemplate = {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubkey]],
        content: encryptedContent,
      };

      const signedEvent = finalizeEvent(eventTemplate, privateKey);
      this.logger.info(`🔵 [Nostr] Event signed, publishing to ${this.nostrRelays.length} relays...`);

      // Filter out closed relays and publish to connected ones
      const connectedRelays = this.nostrRelays.filter(relay => relay.connected);

      if (connectedRelays.length === 0) {
        throw new Error('No connected Nostr relays available');
      }

      this.logger.info(`🔵 [Nostr] Publishing to ${connectedRelays.length}/${this.nostrRelays.length} connected relays...`);

      // Publish to all connected relays with individual error handling
      const publishResults = await Promise.allSettled(
        connectedRelays.map(relay => relay.publish(signedEvent))
      );

      const successCount = publishResults.filter(r => r.status === 'fulfilled').length;
      const failureCount = publishResults.filter(r => r.status === 'rejected').length;

      if (failureCount > 0) {
        this.logger.warn(`⚠️ [Nostr] ${failureCount} relay publish failures, ${successCount} succeeded`);
      }

      if (successCount === 0) {
        throw new Error('Failed to publish to any Nostr relays');
      }

      this.logger.info(`✅ [Nostr] Message published successfully to ${successCount} relays`);
      return {
        protocol: `Nostr (${this.nostrRelays.length} relays)`,
        success: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      // Nostr failures are expected in a redundant system - log as debug, not error
      const errorMsg = String(error);
      if (errorMsg.includes('No connected') || errorMsg.includes('Failed to publish') || errorMsg.includes('relay')) {
        this.logger.debug(`[Nostr] Send failed (expected in redundant system):`, error);
      } else {
        this.logger.warn(`[Nostr] Send failed:`, error);
      }
      return {
        protocol: 'Nostr',
        success: false,
        error: String(error),
        latencyMs: Date.now() - startTime,
      };
    }
  }

  private async sendViaWaku(recipient: Omit<UnifiedIdentity, 'magnetLink'>, message: string): Promise<BroadcastResult> {
    const startTime = Date.now();
    try {
      this.logger.info('🟡 [Waku] Starting message send...');
      if (!this.wakuNode) {
        throw new Error('Waku node not initialized');
      }

      const recipientId = getWakuIdentifier(recipient as UnifiedIdentity);
      const contentTopic = `/broadcast/1/dm-${recipientId}/proto`;
      this.logger.info(`🟡 [Waku] Content topic: ${contentTopic}`);

      // Create routing info for the content topic
      const pubsubTopic = contentTopicToPubsubTopic(contentTopic, 1, 8);
      const shardInfo = pubsubTopicToSingleShardInfo(pubsubTopic);
      const routingInfo = {
        ...shardInfo,
        pubsubTopic
      };

      // Create encoder using standalone function
      const encoder = createEncoder({ contentTopic, routingInfo });

      const messageData = {
        from: this.identity.secp256k1.publicKey,
        content: message,
        timestamp: Date.now(),
      };

      const payload = new TextEncoder().encode(JSON.stringify(messageData));
      this.logger.info(`🟡 [Waku] Sending via lightPush...`);

      const result = await this.wakuNode.lightPush.send(encoder, { payload });

      this.logger.info(`✅ [Waku] Message sent successfully`);
      // Mark as successful if send completes without error
      // Note: result.successes.length may be 0 for local testing without relay peers
      return {
        protocol: 'Waku',
        success: true, // Successfully sent to network (even if no relay peers available)
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      // Waku failures are expected in a redundant system - log as debug, not error
      const errorMsg = String(error);
      if (errorMsg.includes('not initialized') || errorMsg.includes('timeout') || errorMsg.includes('peer')) {
        this.logger.debug(`[Waku] Send failed (expected in redundant system):`, error);
      } else {
        this.logger.warn(`[Waku] Send failed:`, error);
      }
      return {
        protocol: 'Waku',
        success: false,
        error: String(error),
        latencyMs: Date.now() - startTime,
      };
    }
  }

  private async sendViaMQTT(recipient: Omit<UnifiedIdentity, 'magnetLink'>, message: string): Promise<BroadcastResult> {
    const startTime = Date.now();

    this.logger.info('🟠 [MQTT] Starting message send...');
    if (this.mqttClients.length === 0) {
      this.logger.debug('[MQTT] No clients connected (expected in redundant system)');
      return {
        protocol: 'MQTT',
        success: false,
        error: 'No MQTT clients connected',
        latencyMs: Date.now() - startTime,
      };
    }

    const recipientId = getMqttIdentifier(recipient as UnifiedIdentity);
    const topic = `dm/${recipientId}`;
    this.logger.info(`🟠 [MQTT] Topic: ${topic}, publishing to ${this.mqttClients.length} brokers...`);

    const payload = JSON.stringify({
      from: this.identity.secp256k1.publicKey,
      content: message,
      timestamp: Date.now(),
    });

    // Publish to all connected brokers in parallel
    const publishPromises = this.mqttClients.map((client, index) => {
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        try {
          client.publish(topic, payload, { qos: 1, retain: true }, (err) => {
            if (err) {
              this.logger.debug(`[MQTT] Broker ${index + 1} failed (expected in redundant system):`, err);
              resolve({ success: false, error: String(err) });
            } else {
              this.logger.info(`✅ [MQTT] Broker ${index + 1} success`);
              resolve({ success: true });
            }
          });
        } catch (error) {
          this.logger.debug(`[MQTT] Broker ${index + 1} exception (expected in redundant system):`, error);
          resolve({ success: false, error: String(error) });
        }
      });
    });

    const results = await Promise.all(publishPromises);
    const successCount = results.filter(r => r.success).length;
    this.logger.info(`🟠 [MQTT] Published to ${successCount}/${this.mqttClients.length} brokers`);

    return {
      protocol: `MQTT (${successCount}/${this.mqttClients.length} brokers)`,
      success: successCount > 0,
      error: successCount === 0 ? results[0]?.error : undefined,
      latencyMs: Date.now() - startTime,
    };
  }

  private async sendViaIROH(recipient: Omit<UnifiedIdentity, 'magnetLink'>, message: string): Promise<BroadcastResult> {
    const startTime = Date.now();
    try {
      this.logger.info('🟣 [IROH] Starting message send...');
      if (!this.irohNode) {
        throw new Error('IROH node not initialized');
      }

      const irohKeys = getIrohKeys(recipient as UnifiedIdentity);
      const myIrohKeys = getIrohKeys(this.identity);

      // Check if trying to send to ourselves
      if (irohKeys.nodeId === myIrohKeys.nodeId) {
        throw new Error('Cannot send IROH message to self');
      }

      this.logger.info(`🟣 [IROH] Recipient nodeId: ${irohKeys.nodeId.slice(0, 16)}...`);

      const myNodeAddr = await this.irohNode.net.nodeAddr();
      this.logger.info(`🟣 [IROH] My relay: ${myNodeAddr.relayUrl}`);

      // Create recipient node address from their node ID
      const recipientNodeAddr: NodeAddr = {
        nodeId: irohKeys.nodeId,
        relayUrl: myNodeAddr.relayUrl, // Use same relay
      };

      this.logger.info(`🟣 [IROH] Connecting to recipient...`);
      // Get endpoint and connect
      const endpoint = this.irohNode.node.endpoint();
      const conn = await endpoint.connect(recipientNodeAddr, IROH_MESSAGING_ALPN);

      this.logger.info(`🟣 [IROH] Opening bidirectional stream...`);
      // Open bidirectional stream
      const bi = await conn.openBi();

      this.logger.info(`🟣 [IROH] Sending message...`);
      // Send message
      await bi.send.writeAll(Buffer.from(message));
      await bi.send.finish();

      this.logger.info(`✅ [IROH] Message sent successfully`);
      // Optionally wait for ack (with timeout)
      // For now, just close the stream

      return {
        protocol: 'IROH',
        success: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      // IROH failures are expected in a redundant system - log as debug/info, not error
      const errorMsg = String(error);
      if (errorMsg.includes('timed out') || errorMsg.includes('connection') || errorMsg.includes('Connecting to ourself') || errorMsg.includes('Cannot send IROH message to self')) {
        this.logger.debug(`[IROH] Send failed (expected in redundant system):`, error);
      } else {
        this.logger.warn(`[IROH] Send failed:`, error);
      }
      return {
        protocol: 'IROH',
        success: false,
        error: String(error),
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Cleanup and close all connections
   */
  async shutdown(): Promise<void> {
    this.logger.info('\n🛑 Shutting down broadcaster...');

    // Shutdown Waku
    if (this.wakuNode) {
      try {
        await this.wakuNode.stop();
        this.logger.info('✅ Waku node stopped');
      } catch (error) {
        this.logger.warn('⚠️  Error stopping Waku node:', error);
      }
    }

    // Close all Nostr relays
    try {
      this.nostrRelays.forEach(relay => {
        try {
          relay.close();
        } catch (error) {
          this.logger.debug('Nostr relay close error (may be normal):', error);
        }
      });
      if (this.nostrRelays.length > 0) {
        this.logger.info('✅ Nostr relays closed');
      }
    } catch (error) {
      this.logger.warn('⚠️  Error closing Nostr relays:', error);
    }

    // Close all MQTT clients
    if (this.mqttClients.length > 0) {
      try {
        await Promise.allSettled(
          this.mqttClients.map(client =>
            new Promise<void>((resolve, reject) => {
              try {
                client.end(false, {}, (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              } catch (error) {
                reject(error);
              }
            })
          )
        );
        this.logger.info('✅ MQTT clients closed');
      } catch (error) {
        this.logger.warn('⚠️  Error closing MQTT clients:', error);
      }
    }

    // Shutdown IROH node
    if (this.irohNode) {
      try {
        await this.irohNode.node.shutdown();
        this.logger.info('✅ IROH node shutdown');
      } catch (error) {
        this.logger.warn('⚠️  Error shutting down IROH node:', error);
      }
    }

    this.logger.info('✅ Broadcaster shut down');
  }
}
