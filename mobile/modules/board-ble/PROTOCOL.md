# Tuya BLE Direct-Connect protocol — current, verified reference

**Read this before changing anything under `modules/board-ble/`.** This module is a
from-scratch, SDK-free reimplementation of a proprietary, undocumented wire protocol —
every fact below was measured against a real board or cross-checked against a reference
implementation, not assumed. Nothing here is published anywhere by Tuya or by Tynee.
This file is the living document: it gets updated every time a new protocol fact is
confirmed on real hardware. Treat gaps between this file and the code as a bug in this
file, not license to rediscover something the hard way.

If a change here looks like it should be "simpler" — fewer branches, one code path
instead of two, a fixed value instead of something negotiated — assume it was already
tried and broke on real hardware, and look for the comment explaining why before
touching it. Board firmware answers the wrong opcode by silently dropping the frame,
never with an error, so a regression here reads as "nothing happens," not a crash.

## Why this exists

Tynee boards pair through the **Tuya Smart** app and normally require the Tuya SDK
(cloud account, BLE binding, ongoing Tuya dependency) to talk to. `modules/board-ble/`
replaces that with a pure-Kotlin GATT client that speaks the board's native wire
protocol directly — no SDK, no cloud round-trip once the board's `localKey`/`secKey`
have been fetched once via the Tuya mobile API (`TuyaMobileClient.kt`). This file only
covers the **BLE wire protocol** (GATT ↔ board), which is the part that keeps turning up
new facts as more of the board's functionality gets exercised.

## GATT identifiers

```
Service (advertised):    0000fd50-0000-1000-8000-00805f9b34fb
Write characteristic:    00000001-0000-1001-8001-00805f9b07d0
Notify characteristic:   00000002-0000-1001-8001-00805f9b07d0
CCCD (notify enable):    00002902-0000-1000-8000-00805f9b34fb
```

`SERVICE_A201` / its write/notify characteristics also exist in code
(`BoardBleClient.kt`) as an alternate GATT profile some Tuya BLE products use, but the
Tynee board (product `y3rojo1n`) uses FD50 — A201 is defensive, not confirmed against
real Tynee hardware.

Subscribing to notifications **requires an explicit CCCD descriptor write** — enabling
notifications on the characteristic alone silently yields nothing.

## Connection lifecycle

- **`autoConnect=false`, scan-then-direct-connect** is the primary path. A parked
  `autoConnect=true` request exists as a fallback once the board's Bluetooth address is
  already known (learned from a prior scan — Tuya's mobile API never returns it), since
  Android documents `autoConnect=true` connections as behaving differently enough that
  they're not a drop-in replacement for a fresh scan.
- **Exactly one GATT operation in flight at a time**, serialized on a single worker
  thread, each op blocking on a `CountDownLatch` only its own `BluetoothGattCallback`
  releases. This is not a style choice — Android's GATT stack corrupts state under
  concurrent operations on the same connection, and this is the root cause class the
  old Tuya-SDK-based `BleCommandQueue.kt` was itself working around.
- **Every GATT callback is matched against what's actually pending** (`releaseOp`
  checks `pendingOpKind` before completing anything) — a late/unsolicited callback
  (an MTU result arriving after its own timeout, e.g.) used to complete whatever
  operation happened to be waiting next and report its status as that operation's,
  which could silently mark a real subscribe-notify as "succeeded" when notifications
  were never actually enabled.
- **MTU is requested at 247** but every write is chunked to `negotiatedMtu - 3` (falling
  back to the 20-byte GATT floor before negotiation completes) — **not** blindly to
  20 bytes. A board captured from a live session answered a single 36-byte ATT write
  immediately, but silently ignored the identical frame split into 20+17 — it does not
  reassemble a frame split across multiple GATT writes below its negotiated MTU.
  Chunking too aggressively (assuming the universal 20-byte floor) reproduces this as
  "the board never answers."
- **Reconnect backoff**: 5s → 10s → 20s … capped at 300s (not 30s — a board that's
  simply away overnight used to run a 15s scan every 30s all night).
- **Closing a dropped GATT must happen before scheduling the reconnect**, and a
  replaced client (e.g. re-pairing while an old session is still up) must close the old
  `BluetoothGatt` synchronously before starting the new one — two live GATT sessions to
  the same board race for its attention and neither handshake ever completes, since the
  board can't tell the two centrals apart. This is the "reuse without closing" pattern
  that produces `GATT_ERROR 133` on repeated reconnects (OEM stacks, Samsung's among
  them, hit this ceiling earlier than the platform default).

## Frame format (unencrypted)

```
seq_num(4, BE) | response_to(4, BE) | code(2, BE) | length(2, BE) | data | crc16(2, BE)
```

Zero-padded to a 16-byte multiple (padding sits *after* the CRC). `response_to` is how
an answer is matched to the request that provoked it — a response's `response_to`
equals the request's `seq_num`.

**CRC**: CRC-16/MODBUS — init `0xFFFF`, reflected polynomial `0xA001`, computed over
everything before the CRC field itself (including any part of the length that isn't
yet padding). A frame whose declared `length` claims more data than was actually
received is rejected outright, not best-effort parsed.

## Encryption

AES-128-CBC, no padding (the frame is zero-padded to a block multiple *before*
encryption), random 16-byte IV per frame. On the wire:

```
security_flag(1) | iv(16) | ciphertext
```

`security_flag` selects which key the receiver must decrypt with:

| Flag | Meaning |
|---|---|
| 4  | v3 login key (device-info exchange) |
| 14 | v2 login key (device-info exchange) |
| 5  | v3 session key (everything after) |
| 15 | v2 session key (everything after) |
| 1  | the device-info response's own auth key |

## Key derivation — v2 vs v3

Two variants, selected by whether the board's stored credentials include a `secKey`
(both are always attempted in order — see "Handshake" below, since which one a given
board actually requires isn't knowable in advance):

```
v2:  material = ASCII(localKey) + ASCII(secKey)     login_flag = 14   session_flag = 15
v3:  material = ASCII(localKey)[:6]                  login_flag = 4    session_flag = 5

login_key   = MD5(material)
session_key = MD5(material + device_random)   # device_random = bytes[6:12] of the
                                                # device-info response
```

The last-successful derivation is cached per board (`lastGoodDerivation`) so a
reconnect tries the one that already worked first, instead of re-discovering it every
time.

## Fragmentation (GATT write-without-response)

Each encrypted payload (`security_flag | iv | ciphertext`) is split into chunks sized
to the negotiated MTU. Chunk 0's header additionally carries the total encrypted
length and the protocol version, so the receiver's reassembler knows how much to
expect before decrypting anything:

```
fragment 0:   varint(packet_num=0) | varint(total_length) | (protocol_version << 4) | data...
fragment N:   varint(packet_num=N) | data...
```

Varint: 7 bits per byte, high bit set means "more follows" (LEB128-style, unsigned).

## Protocol version — the thing this doc exists to get right

`protocol_version` starts at a conservative **2** for the very first frame sent (the
device-info request) — a board that actually runs a newer version ignores a fragment
announcing a version it doesn't recognize, with **no error, no notification, nothing**;
it just never answers. The board's *real* version is reported in **byte 2 of the
device-info response**, and from that point on every frame this client sends must be
built announcing that real version, not the conservative starting guess.

**This board reports protocol version 4 — and protocol v4 changes more than just the
version byte announced in fragment 0. It changes which SEND_DPS opcode is accepted and
the shape of the SEND_DPS payload itself.** This was not obvious from the outset (the
version number initially looked like a cosmetic negotiation detail) and cost real
debugging time to discover: **a v4 board silently drops the legacy v3 SEND_DPS opcode
(`0x0002`)** — every DP write timed out as `NO_RESPONSE` with no other signal, which
looks identical to "the board dropped the connection" or "this datapoint isn't
writable" from the caller's side. The actual cause was using the wrong *opcode* for
DP writes, not a framing or encryption bug.

### v3 SEND_DPS (`0x0002`)

Payload is the KLV-encoded datapoint list directly, one-byte value lengths:

```
id(1) | type(1) | len(1) | value   [repeated per datapoint]
```

Ack: the board's response payload has the result code as its **first byte**.

### v4 SEND_DPS (`0x0027`) — required for this board

Payload wraps the KLV list in a dp-sequence header, and value lengths widen to two
bytes:

```
0x00 | dp_seq(4, BE) | [ id(1) | type(1) | len(2, BE) | value ]   [repeated per datapoint]
```

`dp_seq` is drawn from the **same counter that numbers the frame's own `seq_num`** —
in practice this means it lands **one behind** the frame's own `seq_num`, because the
client increments the dp-sequence counter to build the payload, then `sendAndAwait`
increments the same counter again to number the frame that carries it. This matches
the reference implementation's behavior; it is not an off-by-one bug to "fix."

Ack: the board's response echoes the dp-sequence header back, then the result code as
its **sixth byte** (index 5) — not the first, unlike v3.

**The same v4-vs-v3 KLV length-width split applies on the receive side too** — a v4
DP push (opcodes `0x8006`/`0x8007`, see below) carries a `0x00 | dp_seq(4, BE) |
send_flags(1)` header before its KLV payload, and that payload uses **two-byte**
lengths, matching the write side. A v4 receive ack (when the board's `send_flags` bit
`0x80` is *not* set, meaning it wants one) echoes that same 7-byte header back with a
trailing zero result byte.

**Rule of thumb going forward**: any time this client is extended to speak a new
opcode, check `protocolVersion` and branch the same way `publishDp` already does for
SEND_DPS — do not assume the v3 shape is a safe default just because it's simpler. If
a new opcode times out with no other explanation, suspect a v3/v4 shape mismatch
before anything else.

## Opcodes

Device → phone codes have the high bit set (`0x80xx`).

| Code | Direction | Purpose |
|---|---|---|
| `0x0000` | → board | Device info request (handshake step 1) |
| `0x0001` | → board | Pair/login (a bound board answers `2` = "already paired," which is success — we never unbind) |
| `0x0002` | → board | Send DPs — **protocol v3 only** |
| `0x0003` | → board | Query device status |
| `0x0027` | → board | Send DPs — **protocol v4** (this board) |
| `0x8001` | board → | Receive DP push |
| `0x8003` | board → | Receive DP push with a leading timestamp |
| `0x8004` | board → | Receive DP push, "signed" variant (2-byte dp-seq + flags header) |
| `0x8005` | board → | Receive DP push, signed + timestamped |
| `0x8006` | board → | Receive DP push — **protocol v4** |
| `0x8007` | board → | Receive DP push — **protocol v4**, timestamped |
| `0x8011` | board → | Time request 1 — must be answered or the board treats the link as unhealthy |
| `0x8012` | board → | Time request 2 — same |

## Datapoints (KLV)

`id(1) | type(1) | len(1 or 2, BE) | value` — length width is **1 byte under protocol
v3, 2 bytes under v4** (see above). Types:

| Type | Value | Wire shape |
|---|---|---|
| raw | 0 | opaque bytes |
| bool | 1 | 1 byte, any nonzero byte in a multi-byte value counts as true |
| value | 2 | signed 32-bit big-endian integer |
| string | 3 | UTF-8 bytes |
| enum | 4 | integer index into the product schema's `range` array (see `mobile/lib/boardDpSchema.ts` / `DATAPOINTS.md`) — the Tuya SDK used to resolve this to a label for us; a from-scratch client must map it itself |
| bitmap | 5 | opaque bytes, same as raw |

An enum's on-wire integer width is chosen by magnitude when *writing* (1/2/4 bytes),
matching the reference implementation; when *reading*, width comes from the `len`
field, exactly like every other type.

## Handshake

1. Connect, discover services, subscribe to the notify characteristic (write the CCCD
   descriptor explicitly), request MTU 247.
2. Send device-info request (opcode `0x0000`), encrypted with the **login key**,
   frame version still the conservative starting value (2). **This board requires a
   2-byte payload on the device-info request** (the negotiated MTU minus 4, big-endian)
   — an empty payload (what the reference implementation sends for boards not on its
   special-case product-ID list) is silently dropped with no reply. This board is not
   on that list, so absence of a special case does not mean "safe to send nothing."
3. Read the response: byte 2 is the board's real `protocol_version` — every frame after
   this point is built announcing that value, not 2. Bytes 6–12 are `device_random`,
   used to derive the session key. Bytes 14–46 are an `authKey` the board expects back
   in some later exchanges.
4. Derive the session key/flag, and send the pair request (opcode `0x0001`), encrypted
   with the **session key**. Payload: `uuid(ASCII) + localKey[:6](ASCII) + devId(ASCII)`,
   zero-padded to 44 bytes. Response byte 0 is the pair result: `0` or `2` (already
   paired) both mean success.
5. Handshake attempts both the v2 and v3 key derivations, in whichever order last
   succeeded (or v3-then-v2 if neither has succeeded yet this process), re-subscribing
   to the GATT connection from scratch between attempts since a failed exchange leaves
   the link state untrustworthy.
6. Once paired, answer `0x8011`/`0x8012` time requests whenever the board sends them —
   unix millis as an ASCII string, followed by a big-endian int16 of
   `-timezone_offset_seconds / 36`. An unanswered time request is one of the ways a
   board decides the link is unhealthy and drops it.

## Where this is implemented

| File | Responsibility |
|---|---|
| `TuyaCrypto.kt` | AES-CBC/GCM, MD5, HMAC-SHA256, RSA-PKCS1v1.5, key derivation |
| `TuyaFrame.kt` | Frame build/parse, CRC-16/MODBUS, varint, fragmentation |
| `TuyaReassembler.kt` | Reassembles fragments back into one encrypted payload |
| `TuyaDatapoint.kt` | KLV encode/decode for both length widths, v4 SEND_DPS payload builder |
| `BoardBleClient.kt` | GATT lifecycle, handshake, opcode dispatch, protocol-version branching |
| `BoardBleModule.kt` | Expo module boundary exposed to JS (`modules/board-ble/src/BoardBle.ts`) |
| `BoardScanner.kt` | BLE scan for pairing/onboarding |
| `BoardSelfHealWorker.kt` | Periodic WorkManager job re-asserting the background connection (the foreground service itself is `RideService`, in the ride-core module) |
| `TuyaMobileClient.kt` | Tuya's cloud mobile API — sign-in and key fetch only, no BLE |

## Testing — run before believing a protocol change works

- `cd mobile && npm run test:native` — the Kotlin JVM unit suite
  (`modules/board-ble/android/src/test/java/`). Covers CRC, varint, frame build/parse,
  and — as of the v4 fix — the v4 SEND_DPS payload shape and its two-byte KLV lengths.
  Needs a prebuilt `android/` (`npx expo prebuild --platform android --no-install`);
  not in CI, run it locally after touching anything in this module.
- **This layer fails silently.** A wrong derivation, wrong opcode, or wrong length
  width produces plausible-looking bytes, not a thrown error — the board just never
  answers, or answers something that gets misread as a different failure. Passing unit
  tests confirm the encode/decode math; they do **not** confirm the board actually
  accepts what gets sent. A real on-device test (pair, read telemetry, write a setting,
  confirm it actually changed the board's behavior) is required after any change here,
  every time — see `mobile/AGENTS.md`'s "Turning on code that has never run" section
  for the same principle applied generally.
- `lib/__tests__/boardDpWire.test.ts` (TypeScript side) covers the JS-side schema
  (`enum`/`bool`/`value` write-type classification, label↔index round-trips) — a
  different layer from this file, but the two must agree: a dpId's wire type (`bool`
  vs `enum` vs `value`) has to match what `dpForWrite`/`TuyaDatapoint` actually encode.
