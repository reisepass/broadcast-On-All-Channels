/**
 * Chat Broadcaster with Message Receiving and Acknowledgments
 *
 * Extends the basic broadcaster to:
 * - Listen for incoming messages on all protocols
 * - Send acknowledgments automatically
 * - Track channel performance
 * - Deduplicate messages by UUID
 */

import { Broadcaster, type BroadcastResult } from './broadcaster.js';
import type { UnifiedIdentity } from './identity.js';
import { ChatDatabase } from './database.js';
import { supportsXMTP, supportsWaku } from './runtime.js';
import {
  type ChatMessage,
  type AcknowledgmentMessage,
  type ChannelPreferenceInfo,
  deserializeMessage,
  serializeMessage,
  createAcknowledgment,
  isAcknowledgment,
} from './message-types.js';
import { Relay } from 'nostr-tools/relay';
import { finalizeEvent, nip04, type VerifiedEvent } from 'nostr-tools';
import { getNostrKeys, getEthereumAccount } from './identity.js';
import type { Client as XMTPClient } from '@xmtp/node-sdk';

export interface MessageHandler {
  (message: ChatMessage, protocol: string): Promise<void> | void;
}

export class ChatBroadcaster extends Broadcaster {
  private db: ChatDatabase;
  private messageHandlers: MessageHandler[] = [];
  private seenMessageUuids: Set<string> = new Set();
  private myMagnetLink: string;

  constructor(identity: UnifiedIdentity, db: ChatDatabase, options?: Partial<BroadcasterOptions>) {
    // Merge provided options with defaults
    const defaultOptions: BroadcasterOptions = {
      xmtpEnabled: supportsXMTP(), // Auto-enabled on Node.js/Deno
      xmtpEnv: 'dev',
      nostrEnabled: true,
      wakuEnabled: supportsWaku(),  // Auto-enabled on Node.js/Bun (Deno needs --unstable-broadcast-channel)
      mqttEnabled: true,  // ✅ Enabled - using multiple public brokers
      mqttBrokers: [
        'mqtt://broker.hivemq.com:1883',
        'mqtt://broker.emqx.io:1883',
        'mqtt://test.mosquitto.org:1883',
      ],
      irohEnabled: true,
    };

    // Override defaults with provided options
    const mergedOptions = { ...defaultOptions, ...options };

    super(identity, mergedOptions);

    this.db = db;
    this.myMagnetLink = identity.magnetLink;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  private async handleIncomingMessage(message: ChatMessage, protocol: string, server?: string): Promise<void> {
    // Deduplicate by UUID
    if (this.seenMessageUuids.has(message.uuid)) {
      // Already seen this message, just record the receipt
      await this.db.saveMessageReceipt({
        messageUuid: message.uuid,
        protocol,
        server,
        receivedAt: Date.now(),
        latencyMs: Date.now() - message.timestamp,
      });
      return;
    }

    this.seenMessageUuids.add(message.uuid);

    // Save message to database
    await this.db.saveMessage({
      uuid: message.uuid,
      fromIdentity: message.fromMagnetLink,
      toIdentity: this.myMagnetLink,
      content: message.content,
      timestamp: message.timestamp,
      isAcknowledgment: message.type === 'acknowledgment',
      firstReceivedProtocol: protocol,
      firstReceivedAt: Date.now(),
    });

    // Save receipt
    await this.db.saveMessageReceipt({
      messageUuid: message.uuid,
      protocol,
      server,
      receivedAt: Date.now(),
      latencyMs: Date.now() - message.timestamp,
    });

    // Update channel preferences if this is an acknowledgment
    if (isAcknowledgment(message)) {
      const ackMessage = message as AcknowledgmentMessage;

      // Update that this channel works for this identity
      await this.db.updateChannelPreference({
        identity: message.fromMagnetLink,
        protocol: ackMessage.receivedVia,
        isWorking: true,
        lastAckAt: Date.now(),
        avgLatencyMs: Date.now() - message.timestamp,
        cannotUse: false,
      });

      // Update their stated preferences
      if (message.channelPreferences) {
        for (const pref of message.channelPreferences) {
          await this.db.updateChannelPreference({
            identity: message.fromMagnetLink,
            protocol: pref.protocol,
            isWorking: !pref.cannotUse,
            preferenceOrder: pref.preferenceOrder,
            cannotUse: pref.cannotUse,
            lastAckAt: undefined,
            avgLatencyMs: undefined,
          });
        }
      }
    }

    // Notify handlers
    for (const handler of this.messageHandlers) {
      await handler(message, protocol);
    }

    // Send acknowledgment (unless this IS an acknowledgment)
    if (!isAcknowledgment(message)) {
      await this.sendAcknowledgment(message, protocol);
    }
  }

  private async sendAcknowledgment(originalMessage: ChatMessage, receivedVia: string): Promise<void> {
    // Get my channel preferences (auto-disabled based on runtime)
    const myPreferences: ChannelPreferenceInfo[] = [
      { protocol: 'nostr', preferenceOrder: 1, cannotUse: false },
      { protocol: 'XMTP V3', preferenceOrder: 2, cannotUse: !supportsXMTP() },
      { protocol: 'MQTT', preferenceOrder: 3, cannotUse: false },
      { protocol: 'IROH', preferenceOrder: 4, cannotUse: false },
      { protocol: 'Waku', preferenceOrder: 5, cannotUse: !supportsWaku() },
    ];

    const ack = createAcknowledgment(
      originalMessage,
      receivedVia,
      this.myMagnetLink,
      myPreferences
    );

    const serialized = serializeMessage(ack);

    // Save acknowledgment to database
    await this.db.saveMessage({
      uuid: ack.uuid,
      fromIdentity: this.myMagnetLink,
      toIdentity: originalMessage.fromMagnetLink,
      content: serialized,
      timestamp: ack.timestamp,
      isAcknowledgment: true,
    });

    // Send via all channels (robust delivery)
    try {
      await this.broadcast(originalMessage.fromMagnetLink, serialized);
    } catch (error) {
      console.error('Failed to send acknowledgment:', error);
    }
  }

  async startListening(): Promise<void> {
    // Listen on Nostr
    await this.startNostrListener();

    // Listen on XMTP
    await this.startXMTPListener();

    // Listen on MQTT
    await this.startMQTTListener();

    // Listen on IROH
    await this.startIROHListener();

    // Listen on Waku
    await this.startWakuListener();
  }

  private async startNostrListener(): Promise<void> {
    if (this.nostrRelays.length === 0) {
      return;
    }

    const { publicKey } = getNostrKeys(this.identity);

    // Subscribe to direct messages sent to us
    for (const relay of this.nostrRelays) {
      const relayUrl = relay.url;
      const sub = relay.subscribe(
        [
          {
            kinds: [4], // Encrypted DM
            '#p': [publicKey], // Sent to us
          },
        ],
        {
          onevent: async (event: VerifiedEvent) => {
            try {
              // Decrypt the message
              const { privateKey } = getNostrKeys(this.identity);
              const decrypted = await nip04.decrypt(
                privateKey,
                event.pubkey,
                event.content
              );

              // Deserialize
              const message = deserializeMessage(decrypted);
              if (!message) {
                console.error('Failed to deserialize Nostr message');
                return;
              }

              // Handle the message with relay URL
              this.handleIncomingMessage(message, 'nostr', relayUrl);
            } catch (error) {
              console.error('Error processing Nostr message:', error);
            }
          },
        }
      );
    }
  }

  private async startXMTPListener(): Promise<void> {
    if (!this.xmtpClient) {
      return;
    }

    try {
      // Stream all DM messages
      const stream = await this.xmtpClient.conversations.streamAllDmMessages();

      // Process messages in the background (don't await this loop)
      (async () => {
        try {
          for await (const message of stream) {
            try {
              // Deserialize the message content
              const chatMessage = deserializeMessage(message.content);
              if (!chatMessage) {
                console.error('Failed to deserialize XMTP message');
                continue;
              }

              // Handle the message
              this.handleIncomingMessage(chatMessage, 'XMTP V3');
            } catch (error) {
              console.error('Error processing XMTP message:', error);
            }
          }
        } catch (error) {
          console.error('Error in XMTP message stream:', error);
        }
      })();

      // Return immediately after starting the stream
    } catch (error) {
      console.error('Error starting XMTP listener:', error);
    }
  }

  private async startMQTTListener(): Promise<void> {
    if (this.mqttClients.length === 0) {
      return;
    }

    const { publicKey } = getNostrKeys(this.identity);
    const myTopic = `dm/${publicKey}`;

    for (const client of this.mqttClients) {
      // Get the broker URL from client options
      const brokerUrl = (client as any).options?.href || (client as any).options?.host || 'unknown';

      // Subscribe to messages sent to our public key
      client.subscribe(myTopic, { qos: 1 }, (err) => {
        if (err) {
          console.error('Error subscribing to MQTT topic:', err);
        }
      });

      // Handle incoming messages
      client.on('message', (topic: string, payload: Buffer) => {
        if (topic !== myTopic) return;

        try {
          const data = JSON.parse(payload.toString());

          // Deserialize the chat message from the content field
          const chatMessage = deserializeMessage(data.content);
          if (!chatMessage) {
            console.error('Failed to deserialize MQTT message');
            return;
          }

          // Handle the message with broker URL
          this.handleIncomingMessage(chatMessage, 'MQTT', brokerUrl);
        } catch (error) {
          console.error('Error processing MQTT message:', error);
        }
      });
    }
  }

  private async startIROHListener(): Promise<void> {
    // Set up the message handler for IROH
    // The broadcaster's protocol handler will call this when messages arrive
    this.irohMessageHandler = async (message: string) => {
      try {
        // Deserialize the chat message
        const chatMessage = deserializeMessage(message);
        if (!chatMessage) {
          console.error('Failed to deserialize IROH message');
          return;
        }

        // Handle the message
        await this.handleIncomingMessage(chatMessage, 'IROH');
      } catch (error) {
        // Silently ignore connection errors - they're expected when no peer is available
        const errMsg = String(error);
        if (!errMsg.includes('connection lost') && !errMsg.includes('closed by peer')) {
          console.error('Error processing IROH message:', error);
        }
      }
    };
  }

  private async startWakuListener(): Promise<void> {
    if (!this.wakuNode) {
      return;
    }

    const { publicKey } = getNostrKeys(this.identity);
    const contentTopic = `/broadcast/1/dm-${publicKey}/proto`;

    const { createDecoder } = await import('@waku/sdk');
    const { contentTopicToPubsubTopic, pubsubTopicToSingleShardInfo } = await import('@waku/utils');

    // Create routing info for the content topic
    const pubsubTopic = contentTopicToPubsubTopic(contentTopic, 1, 8);
    const shardInfo = pubsubTopicToSingleShardInfo(pubsubTopic);
    const routingInfo = {
      ...shardInfo,
      pubsubTopic
    };

    const decoder = createDecoder(contentTopic, routingInfo);

    // Subscribe to messages
    await this.wakuNode.filter.subscribe([decoder], async (wakuMessage) => {
      if (!wakuMessage.payload) return;

      try {
        const data = JSON.parse(new TextDecoder().decode(wakuMessage.payload));
        const chatMessage = deserializeMessage(data.content);

        if (!chatMessage) {
          console.error('Failed to deserialize Waku message');
          return;
        }

        // Handle the message
        await this.handleIncomingMessage(chatMessage, 'Waku');
      } catch (error) {
        console.error('Error processing Waku message:', error);
      }
    });
  }

  async sendMessage(recipientMagnetLink: string, content: string): Promise<BroadcastResult[]> {
    const message: ChatMessage = {
      uuid: crypto.randomUUID(),
      type: 'message',
      content,
      timestamp: Date.now(),
      fromMagnetLink: this.myMagnetLink,
    };

    const serialized = serializeMessage(message);

    // Save to database
    await this.db.saveMessage({
      uuid: message.uuid,
      fromIdentity: this.myMagnetLink,
      toIdentity: recipientMagnetLink,
      content,
      timestamp: message.timestamp,
      isAcknowledgment: false,
    });

    // Broadcast across all protocols
    const results = await this.broadcast(recipientMagnetLink, serialized);

    // Update protocol performance
    for (const result of results) {
      await this.db.updateProtocolPerformance(result.protocol, result.success, result.latencyMs);
    }

    return results;
  }
}
