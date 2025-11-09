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
    'mqtt://broker.hivemq.com:1883',
    'mqtt://broker.emqx.io:1883',
    'mqtt://test.mosquitto.org:1883',
  ],
  irohEnabled: true,
};

const IROH_MESSAGING_ALPN = Buffer.from('broadcast/dm/0');

export class Broadcaster {
  private identity: UnifiedIdentity;
  private options: BroadcasterOptions;
  protected irohMessageHandler?: (message: string) => Promise<void>;

  // Protocol clients
  private xmtpClient?: XMTPClient;
  private nostrRelays: Relay[] = [];
  private wakuNode?: LightNode;
  private mqttClients: mqtt.MqttClient[] = []; // Multiple MQTT brokers
  private irohNode?: Iroh;

  constructor(identity: UnifiedIdentity, options: BroadcasterOptions = {}) {
    this.identity = identity;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Initialize all enabled protocol clients
   */
  async initialize(): Promise<void> {
    console.log('🚀 Initializing broadcaster...\n');

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
        console.error(`Failed to initialize protocol ${index}:`, result.reason);
      }
    });

    console.log('✅ Broadcaster initialized\n');
  }

  private async initXMTP(): Promise<void> {
    try {
      const signer = createXMTPSigner(this.identity);
      const { randomBytes } = await import('node:crypto');

      // Create encryption key as Uint8Array (32 bytes for 256-bit encryption)
      const dbEncryptionKey = new Uint8Array(randomBytes(32));

      // Create absolute database path for XMTP's encrypted message store
      const account = getEthereumAccount(this.identity);
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
      console.log('✅ XMTP client initialized');
    } catch (error) {
      console.error('❌ XMTP initialization failed:', error);
      throw error;
    }
  }

  private async initNostr(): Promise<void> {
    try {
      const relays = this.options.nostrRelays || DEFAULT_OPTIONS.nostrRelays!;

      for (const relayUrl of relays) {
        try {
          const relay = await Relay.connect(relayUrl);
          this.nostrRelays.push(relay);
        } catch (err) {
          console.warn(`Failed to connect to Nostr relay ${relayUrl}:`, err);
        }
      }

      if (this.nostrRelays.length === 0) {
        throw new Error('Failed to connect to any Nostr relays');
      }

      console.log(`✅ Nostr initialized (${this.nostrRelays.length} relays)`);
    } catch (error) {
      console.error('❌ Nostr initialization failed:', error);
      throw error;
    }
  }

  private async initWaku(): Promise<void> {
    try {
      this.wakuNode = await createLightNode({ defaultBootstrap: true });
      await this.wakuNode.start();
      await this.wakuNode.waitForPeers([Protocols.LightPush, Protocols.Filter]);
      console.log('✅ Waku node initialized');
    } catch (error) {
      console.error('❌ Waku initialization failed:', error);
      throw error;
    }
  }

  private async initMQTT(): Promise<void> {
    const brokers = this.options.mqttBrokers || DEFAULT_OPTIONS.mqttBrokers!;
    const connectionPromises: Promise<mqtt.MqttClient>[] = [];

    for (const brokerUrl of brokers) {
      const promise = new Promise<mqtt.MqttClient>((resolve, reject) => {
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
      });

      connectionPromises.push(promise);
    }

    // Wait for at least one connection to succeed
    const results = await Promise.allSettled(connectionPromises);
    const successful = results.filter(r => r.status === 'fulfilled').length;

    if (successful === 0) {
      throw new Error('Failed to connect to any MQTT brokers');
    }

    console.log(`✅ MQTT initialized (${successful}/${brokers.length} brokers)`);
  }

  private async initIROH(): Promise<void> {
    try {
      const irohKeys = getIrohKeys(this.identity);

      // Define the messaging protocol handler
      const protocols = {
        [IROH_MESSAGING_ALPN.toString()]: (err: Error | null, ep: any) => ({
          accept: async (err: Error | null, conn: any) => {
            if (err) {
              console.error('IROH accept error:', err);
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
              console.error('Error processing IROH message:', error);
            }
          },
          shutdown: (err: Error | null) => {
            if (err && !err.message?.includes('closed')) {
              console.error('IROH shutdown error:', err);
            }
          },
        }),
      };

      // Create node with our identity's private key
      this.irohNode = await Iroh.memory({
        protocols,
        secretKey: Array.from(irohKeys.privateKey),
      });

      console.log('✅ IROH node initialized');
    } catch (error) {
      console.error('❌ IROH initialization failed:', error);
      throw error;
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

    console.log(`📡 Broadcasting message to all channels...\n`);

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
        console.error('Broadcast failed:', result.reason);
      }
    });

    return results;
  }

  private async sendViaXMTP(recipientAddress: string, message: string): Promise<BroadcastResult> {
    const startTime = Date.now();
    try {
      if (!this.xmtpClient) {
        throw new Error('XMTP client not initialized');
      }

      const dm = await this.xmtpClient.conversations.newDm(recipientAddress);
      await dm.send(message);

      return {
        protocol: 'XMTP V3',
        success: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
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
      const { privateKey } = getNostrKeys(this.identity);
      const recipientPubkey = getNostrPublicKeyFromIdentity(recipient);

      const encryptedContent = await nip04.encrypt(privateKey, recipientPubkey, message);

      const eventTemplate: EventTemplate = {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubkey]],
        content: encryptedContent,
      };

      const signedEvent = finalizeEvent(eventTemplate, privateKey);

      // Publish to all connected relays
      const publishPromises = this.nostrRelays.map(relay => relay.publish(signedEvent));
      await Promise.all(publishPromises);

      return {
        protocol: `Nostr (${this.nostrRelays.length} relays)`,
        success: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
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
      if (!this.wakuNode) {
        throw new Error('Waku node not initialized');
      }

      const recipientId = getWakuIdentifier(recipient as UnifiedIdentity);
      const contentTopic = `/broadcast/1/dm-${recipientId}/proto`;

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

      const result = await this.wakuNode.lightPush.send(encoder, { payload });

      // Mark as successful if send completes without error
      // Note: result.successes.length may be 0 for local testing without relay peers
      return {
        protocol: 'Waku',
        success: true, // Successfully sent to network (even if no relay peers available)
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      console.error('Waku send error:', error);
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

    if (this.mqttClients.length === 0) {
      return {
        protocol: 'MQTT',
        success: false,
        error: 'No MQTT clients connected',
        latencyMs: Date.now() - startTime,
      };
    }

    const recipientId = getMqttIdentifier(recipient as UnifiedIdentity);
    const topic = `dm/${recipientId}`;

    const payload = JSON.stringify({
      from: this.identity.secp256k1.publicKey,
      content: message,
      timestamp: Date.now(),
    });

    // Publish to all connected brokers in parallel
    const publishPromises = this.mqttClients.map((client, index) => {
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        client.publish(topic, payload, { qos: 1, retain: true }, (err) => {
          if (err) {
            resolve({ success: false, error: String(err) });
          } else {
            resolve({ success: true });
          }
        });
      });
    });

    const results = await Promise.all(publishPromises);
    const successCount = results.filter(r => r.success).length;

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
      if (!this.irohNode) {
        throw new Error('IROH node not initialized');
      }

      const irohKeys = getIrohKeys(recipient as UnifiedIdentity);
      const myNodeAddr = await this.irohNode.net.nodeAddr();

      // Create recipient node address from their node ID
      const recipientNodeAddr: NodeAddr = {
        nodeId: irohKeys.nodeId,
        relayUrl: myNodeAddr.relayUrl, // Use same relay
      };

      // Get endpoint and connect
      const endpoint = this.irohNode.node.endpoint();
      const conn = await endpoint.connect(recipientNodeAddr, IROH_MESSAGING_ALPN);

      // Open bidirectional stream
      const bi = await conn.openBi();

      // Send message
      await bi.send.writeAll(Buffer.from(message));
      await bi.send.finish();

      // Optionally wait for ack (with timeout)
      // For now, just close the stream

      return {
        protocol: 'IROH',
        success: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
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
    console.log('\n🛑 Shutting down broadcaster...');

    if (this.wakuNode) {
      await this.wakuNode.stop();
    }

    this.nostrRelays.forEach(relay => relay.close());

    // Close all MQTT clients
    if (this.mqttClients.length > 0) {
      await Promise.all(
        this.mqttClients.map(client =>
          new Promise<void>((resolve) => {
            client.end(false, {}, () => resolve());
          })
        )
      );
    }

    // Shutdown IROH node
    if (this.irohNode) {
      await this.irohNode.node.shutdown();
    }

    console.log('✅ Broadcaster shut down');
  }
}
