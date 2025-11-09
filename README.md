# Broadcast On All Channels

A multi-protocol message passing system with automatic fallback. Send messages across multiple decentralized communication protocols simultaneously, with automatic redundancy and failover.

## Overview

Ever been unsure which messaging system to trust because they could go down? Don't choose - **use them all**. This system automatically broadcasts your messages across multiple protocols and falls back gracefully if any fail.

### Supported Protocols

- **XMTP** - 
- **Nostr** -  
- **Waku** - 
- **MQTT** -  
- **IROH** -  

## Key Features

- **Automatic Fallback** - If one protocol fails, others continue working
- **Parallel Broadcasting** - All protocols contacted simultaneously for speed
- **Unified Identity** - Single magnet link works across all protocols
- **No Signup Required** - All protocols are permissionless and anonymous
- **Message Redundancy** - Messages delivered via multiple independent networks

## Installation

```bash
# Using Bun (recommended)
bun install

# Or using npm
npm install
```

**New to this project?** Start with [QUICKSTART.md](./QUICKSTART.md) for a 5-minute intro!

## Quick Start

### Run the Full Demo

```bash
bun run demo
```

This demonstrates the complete system:
1. Generates unified identities for two users
2. Initializes all protocol clients
3. Broadcasts a message across all protocols
4. Shows success/failure and latency for each

### Run Individual Protocol Tests

Test each protocol independently:

```bash
# Test XMTP
bun run test:xmtp

# Test Nostr
bun run test:nostr

# Test Waku
bun run test:waku

# Test MQTT
bun run test:mqtt

# Test IROH (conceptual)
bun run test:iroh
```

## Architecture

### Unified Identity System

The system uses a unified identity that works across all protocols:

- **secp256k1 keypair** - Used by XMTP, Nostr, Waku, and MQTT
- **Ed25519 keypair** - Used by IROH
- **Magnet Link** - Encodes all public keys in a shareable format

Example magnet link:
```
magnet:?xt=urn:identity:v1&secp256k1pub=...&ed25519pub=...&eth=0x...
```

### Protocol Addressing

Each protocol has its own addressing scheme:

| Protocol | Address Format | Identity Type |
|----------|---------------|---------------|
| XMTP | Ethereum address (0x...) | secp256k1 |
| Nostr | Public key (hex) | secp256k1 |
| Waku | Content topic (/app/version/topic/encoding) | Any |
| MQTT | Topic path (dm/{pubkey}) | Any |
| IROH | Node ID (public key) | Ed25519 |

## Usage

### Generate an Identity

```typescript
import { generateIdentity, displayIdentity } from './src/identity.js';

const identity = generateIdentity();
displayIdentity(identity);

// Share your magnet link with others
console.log(identity.magnetLink);
```

### Send a Broadcast Message

```typescript
import { Broadcaster } from './src/broadcaster.js';
import { generateIdentity } from './src/identity.js';

// Your identity
const myIdentity = generateIdentity();

// Initialize broadcaster
const broadcaster = new Broadcaster(myIdentity, {
  xmtpEnabled: true,
  nostrEnabled: true,
  wakuEnabled: true,
  mqttEnabled: true,
});

await broadcaster.initialize();

// Broadcast to a recipient (using their magnet link)
const recipientMagnetLink = 'magnet:?xt=urn:identity:v1&...';
const results = await broadcaster.broadcast(
  recipientMagnetLink,
  'Hello from the broadcast system!'
);

// Check results
results.forEach(result => {
  console.log(`${result.protocol}: ${result.success ? '✅' : '❌'} (${result.latencyMs}ms)`);
});

await broadcaster.shutdown();
```

## Protocol Details

### XMTP
- **Identity**: Ethereum wallet (secp256k1)
- **Encryption**: Built-in end-to-end encryption (MLS protocol)
- **Network**: Uses XMTP's public infrastructure (no node required!)
- **Client Type**: Lightweight client connecting to hosted servers
- **Best For**: Crypto-native applications, wallet-to-wallet messaging

### Nostr
- **Identity**: secp256k1 keypair
- **Encryption**: NIP-04 encrypted direct messages
- **Network**: Multiple public relays
- **Best For**: Censorship-resistant social applications

### Waku
- **Identity**: No built-in (bring your own)
- **Encryption**: Not built-in (add your own)
- **Network**: Decentralized P2P with bootstrap nodes
- **Best For**: Privacy-focused applications, offline message delivery

### MQTT
- **Identity**: No built-in (bring your own)
- **Encryption**: Transport-level TLS (optional)
- **Network**: Centralized brokers (many public options)
- **Best For**: IoT applications, high-throughput messaging

### IROH
- **Identity**: Ed25519 keypair
- **Encryption**: Built-in with QUIC/TLS
- **Network**: Peer-to-peer with NAT traversal
- **Best For**: High-performance data sync, P2P applications
- **Status**: Conceptual (requires Rust integration)

## MQTT Brokers

The system supports various public MQTT brokers:

### With Message Retention
- **Flespi** - `mqtt://mqtt.flespi.io:1883` (Default, has persistence)
- **HiveMQ** - `mqtt://broker.hivemq.com:1883`
- **EMQX** - `mqtt://broker.emqx.io:1883`

### Other Public Brokers
- Mosquitto Test - `mqtt://test.mosquitto.org:1883`
- Bevywise - `mqtt://public-mqtt-broker.bevywise.com:1883`
- Tyckr - `mqtt://mqtt.tyckr.io:1883`

## Project Structure

```
Broadcast-On-All-Channels/
├── src/
│   ├── identity.ts          # Unified identity system
│   └── broadcaster.ts       # Multi-protocol broadcaster
├── examples/
│   ├── full-broadcast-demo.ts  # Complete system demo
│   ├── xmtp-test.ts           # XMTP protocol test
│   ├── nostr-test.ts          # Nostr protocol test
│   ├── waku-test.ts           # Waku protocol test
│   ├── mqtt-test.ts           # MQTT protocol test
│   └── iroh-test.ts           # IROH conceptual demo
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

Customize broadcaster behavior:

```typescript
const broadcaster = new Broadcaster(identity, {
  // Enable/disable protocols
  xmtpEnabled: true,
  nostrEnabled: true,
  wakuEnabled: true,
  mqttEnabled: true,
  irohEnabled: false,

  // XMTP configuration
  xmtpEnv: 'production', // or 'dev', 'local'

  // Nostr configuration
  nostrRelays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band'
  ],

  // MQTT configuration
  mqttBroker: 'mqtt://mqtt.flespi.io:1883',
});
```

## Roadmap

- [ ] Add message receipt confirmation system
- [ ] Implement message queuing for offline recipients
- [ ] Add IROH integration via Rust FFI or CLI
- [ ] Support group messaging across protocols
- [ ] Add end-to-end encryption for protocols without it (Waku, MQTT)
- [ ] Implement message history synchronization
- [ ] Add rate limiting and anti-spam measures
- [ ] Create React Native mobile app
- [ ] Add WebSocket interface for browser usage

## Why Multiple Protocols?

Each protocol has different strengths and weaknesses:

- **Reliability** - If one network has issues, others continue working
- **Censorship Resistance** - Hard to block messages across multiple networks
- **Reach** - Different users prefer different protocols
- **Performance** - Some protocols may be faster in certain conditions
- **Privacy** - Different threat models and privacy guarantees

By broadcasting across all channels, you get the best of all worlds.

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Important Notes

### XMTP v3 Upgrade

This project uses the **new XMTP v3 SDK** (`@xmtp/node-sdk`). The old v2 package (`@xmtp/xmtp-js`) was deprecated.

**You don't need to run a node!** Despite the package name, this is a lightweight client that connects to XMTP's public servers. See [XMTP_UPGRADE.md](./XMTP_UPGRADE.md) for details.

### Security Note

This is an experimental system. While it uses established protocols, the integration layer is new and should be thoroughly tested before production use. Always review the code and understand the security implications before using it with sensitive data.

## Documentation

- **[QUICKSTART.md](./QUICKSTART.md)** - Get started in 5 minutes
- **[SUMMARY.md](./SUMMARY.md)** - Architecture and design overview
- **[XMTP_UPGRADE.md](./XMTP_UPGRADE.md)** - XMTP v2 → v3 migration guide
- **This file** - Complete reference documentation
