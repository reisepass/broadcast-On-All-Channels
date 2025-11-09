# Continuous Test Examples

The continuous test is designed for testing real-world multi-protocol performance between two computers.

## Basic Usage

```bash
npm run test:continuous -- --recipient <magnet-link>
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--recipient` | `-r` | Recipient's magnet link (required) | - |
| `--identity` | `-i` | Local identity index to use | 0 (oldest) |
| `--interval` | - | Seconds between messages | 10 |
| `--help` | `-h` | Show help message | - |

## Example Commands

### 1. Basic continuous test with default settings (10 second intervals)

```bash
npm run test:continuous -- --recipient "magnet:?xt=urn%3Aidentity%3Av1&secp256k1pub=04fd0505a70bf3b5b16b9d63ce7629525fd30af31a0b8f124826c22001ae31ac5c4c767e7bd74f6d21d81f038096155b258b27cd4f1d0143e70e8ea11dd09479e6&ed25519pub=bc75d7de564965c168d0fe965050bfdde40db5c1c2e34220311f8a529572397d&eth=0x33F32f9321919C8D4638b17112135df64ec02166"
```

### 2. Short form with alias

```bash
npm run test:continuous -- -r "magnet:?xt=urn%3Aidentity%3Av1&secp256k1pub=..."
```

### 3. Use a specific identity (identity index 1)

```bash
npm run test:continuous -- -r "magnet:?xt=..." -i 1
```

### 4. Custom interval (send every 5 seconds)

```bash
npm run test:continuous -- -r "magnet:?xt=..." --interval 5
```

### 5. Fast testing (1 second intervals)

```bash
npm run test:continuous -- -r "magnet:?xt=..." --interval 1
```

### 6. Slow testing (send every minute)

```bash
npm run test:continuous -- -r "magnet:?xt=..." --interval 60
```

### 7. Combine all options

```bash
npm run test:continuous -- -r "magnet:?xt=..." -i 2 --interval 15
```

## Two-Computer Setup

### Computer A (Sender)

1. Get your magnet link:
   ```bash
   npm run chat
   ```
   Copy your magnet link from the output.

2. Share it with Computer B

3. Start listening and sending:
   ```bash
   npm run test:continuous -- -r "COMPUTER_B_MAGNET_LINK"
   ```

### Computer B (Receiver)

1. Get your magnet link:
   ```bash
   npm run chat
   ```
   Copy your magnet link from the output.

2. Share it with Computer A

3. Start listening and sending:
   ```bash
   npm run test:continuous -- -r "COMPUTER_A_MAGNET_LINK"
   ```

## What You'll See

The test displays a live dashboard with:

```
═══════════════════════════════════════════════════════════════════════
  CONTINUOUS MULTI-PROTOCOL TEST
═══════════════════════════════════════════════════════════════════════

My Magnet:        magnet:?xt=urn%3Aidentity%3Av1&secp256k1pub=...
Recipient Magnet: magnet:?xt=urn%3Aidentity%3Av1&secp256k1pub=...

Uptime: 0h 5m 23s
Total Sent: 32 | Total Received: 28
Last received: 3s ago

┌─────────────────────────────────────────────────────────────────────┐
│                      PROTOCOL STATISTICS                            │
├──────────────┬──────┬──────┬──────────┬──────────┬──────────────────┤
│ Protocol     │ Sent │ Recv │ Avg (ms) │ Min (ms) │ Max (ms)         │
├──────────────┼──────┼──────┼──────────┼──────────┼──────────────────┤
│ MQTT         │   32 │   28 │      245 │      189 │      412         │
│ XMTP         │   32 │   27 │      823 │      654 │     1234         │
│ Nostr        │   32 │   25 │     1156 │      876 │     2341         │
│ Waku         │   32 │   22 │     2890 │     2134 │     5678         │
│ IROH         │   15 │    8 │     3421 │     1245 │     7890         │
└──────────────┴──────┴──────┴──────────┴──────────┴──────────────────┘

Press Ctrl+C to stop
```

## Managing Identities

### List available identities

```bash
npm run identity list
```

### Create a new identity

```bash
npm run identity create --label "My Test Identity"
```

### Show specific identity

```bash
npm run identity show 0
```

## Tips

1. **For performance testing**: Use shorter intervals (1-5 seconds)
2. **For reliability testing**: Use longer intervals (30-60 seconds) and run for hours/days
3. **Network issues**: Start with a longer interval to avoid overwhelming unreliable connections
4. **Multiple identities**: Use different identity indices (`-i 0`, `-i 1`, etc.) to test different key pairs

## Stopping the Test

Press `Ctrl+C` to stop. You'll see a summary:

```
Shutting down...

═══════════════════════════════════════════════════════════════════════
  Test Summary
═══════════════════════════════════════════════════════════════════════

Total runtime: 323s
Messages sent: 32
Messages received: 28
```

## Troubleshooting

**No messages received?**
- Verify both computers are running
- Check that magnet links are correct
- Ensure at least one protocol is working (check initialization logs)

**Some protocols failing?**
- IROH: May require both peers to be online simultaneously
- Waku: May need time to discover peers
- XMTP: Requires Node.js/Deno runtime (not Bun)
- Nostr: Check relay connectivity

**High latency?**
- Normal for P2P protocols (Waku, IROH)
- MQTT and Nostr should be fast (< 1 second)
- XMTP varies depending on network conditions
