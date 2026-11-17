# REACTOR Bluetooth LE protocol (unofficial)

Independent documentation, worked out by observing the amp and its Bluetooth traffic. Not affiliated with or endorsed
by Positive Grid. Positive Grid and REACTOR are trademarks of Positive Grid LLC.

How the Positive Grid REACTOR amp talks to its app over Bluetooth LE ("Tone Control"). The Bluetooth audio link is a
separate classic-Bluetooth device and is not covered here.

Scope and evidence:

- Hardware: REACTOR 50, firmware `0.2.5.108`. Nothing here was checked on a REACTOR 100.
- The status column in each table says how an entry was checked:
  - **verified**: sent to or received from the amp and decoded;
  - **app**: seen in the official app's traffic with the amp;
  - **no reply**: the amp did not answer.
- All byte values are hex. "Client" means the app (or your program); "amp" means the REACTOR.

## 1. Transport

- **Advertising.** The amp advertises as `Reactor 50 BT Control` with service `FFD0` in the advertisement.
  - It is assumed to accept one connection at a time; this, and whether it advertises while connected, were not tested.
  - On macOS a second app on the same Mac can reuse an existing connection (`retrieveConnectedPeripherals([FFD0])`).
- **GATT table:**

| Service | Characteristic | Handle (value / CCCD) | Properties | Use |
|---|---|---|---|---|
| `1801` | `2A05` Service Changed | CCCD `0004` | indicate | the app enables indications (`0200`) |
| `1800` | GAP | `0014`–`001C` | | |
| `FFD0` | `FFC1` | `002A` | write without response | client → amp |
| `FFD0` | `FFC2` | `002C` / `002D` | read, notify | amp → client (enable with `0100`) |

- **MTU.** The app requests an MTU of 527 and the amp answers 512, so one write carries at most 509 bytes.
- **Writes and notifications.**
  - Every client write is exactly one chunk (section 2.2) preceded by the 16-byte block header (2.1).
  - Every notification is exactly one chunk with no block header.

## 2. Framing

### 2.1 Block header (client → amp)

```
01 FE 00 00 53 FE <len lo> <len hi> 00 00 00 00 00 00 00 00
```

`len` is the little-endian length of the whole write: 16 + chunk length. The amp does not check it (0, 16, and values
4 or 100 bytes off were answered normally). It also accepts chunks written without this header; the app always sends
it.

Each write must hold exactly one chunk: the amp handles only the first chunk of a write. Further chunks in the same
write are neither answered nor executed, with or without the header (9 writes of 2 to 8 chunks). A chunk split across
two writes was not tested.

### 2.2 Chunk

```
F0 01 <seq> <chk> <cmd> <sub> <payload, 7-bit packed> F7
```

| Field | Meaning |
|---|---|
| `F0 01` | start; the second byte is always `01` (the amp does not check it in requests: `00`, `02` and `7F` were answered) |
| `seq` | sequence number, `00`–`7F` (2.4) |
| `chk` | XOR of all packed payload bytes, masked to 7 bits; `00` for an empty payload. Both sides compute it; the amp did not reject wrong values in tests. |
| `cmd` | message type (2.5) |
| `sub` | command number |
| `F7` | end |

All 839 captured ATT values (326 client writes and 513 notifications, two of them recorded twice) follow this layout.
Each is one chunk, not necessarily a whole message (2.6). One write breaks the `chk` and `seq` rules: `02 2F 00` with
`seq` `77` and `chk` `15` (expected `00`). It is the first record of the capture, written 382 s before the app's first
connect; whether the app or a test tool sent it is unknown. The amp answered it normally, echoing `seq` `77`.

### 2.3 7-bit packing

The payload is cut into groups of up to 7 bytes. Each group is sent as one flag byte followed by the group's bytes
with their top bit cleared:

- bit *i* of the flag byte is the top bit of byte *i* of the group;
- a short final group keeps its real length.

Example: `CA 42 F0 00 00` → `05 4A 42 70 00 00` (`05` = top bits of bytes 0 and 2).

### 2.4 Sequence numbers

- **Client requests.** The app numbers its requests `01`–`3F`, counting up and wrapping from `3F` to `01` (`00` was
  never used).
- **Replies.** An answer (`03 <sub>` or ack `04 <sub>`) carries the request's sequence number.
- **Amp-initiated messages.** Unsolicited messages (section 5) use the amp's own counter, `40`–`7F`, wrapping
  `7F` → `40`.
- **Telling them apart.** Treat any message whose sequence number is above `3F` as an event, and keep your own
  numbers in `01`–`3F`. The amp also answers requests numbered `00` and `40`–`7F`, echoing the number (65 of 65).
  Its event counter is not affected, so such a reply can carry the same number as a nearby event.
- **Pipelining.** The amp answers requests strictly in the order received, also when many are sent without waiting
  (up to 24 tried), and never interleaves the parts of a multi-part reply with other messages.

### 2.5 Message types (`cmd`)

| cmd | Direction | Meaning |
|---|---|---|
| `01` | client → amp | set / do something |
| `02` | client → amp | read something |
| `03` | amp → client | answer to a read, or an unsolicited event (section 5) |
| `04` | amp → client | acknowledgement of a `01` (may carry a small result) |

### 2.6 Multi-part payloads

A payload too large for one chunk is split into parts:

- every part's payload starts with `<count> <index> <len hi> <len lo>`, where `len` is the byte count of that
  part's data;
- each part is a separate chunk with the same `cmd`, `sub` and `seq`;
- single-part messages have no part header. Exception: a `01 A7` payload that fits one part can be sent as one
  part with the part header `01 00 <len hi> <len lo>`; the amp accepted it.

Which messages are multi-part is fixed by `cmd` and `sub`: `01 01`, `01 A7`, `03 01` and `03 A7` (all captured ones
carried part headers). Do not detect a part header by inspecting other payloads; for example, the `03 72` payload
`C2 3C 00 00` would look like one.

| Sender | Data per part | Acknowledgement |
|---|---|---|
| amp | up to 350 bytes | none |
| app, `01 01` | 396 bytes | the amp acks every part with `04 01` |
| app, `01 A7` | 396 bytes | the amp acks every part with `04 A7` |

A part must fit one write: 16 (block header) + 7 (chunk overhead) + the packed size of the part payload (4-byte part
header + data) ≤ 509. A 396-byte part gives 16 + 7 + 458 = 481 bytes. 396 bytes is what the app sends, not a limit:
the amp also accepted `01 A7` parts of 100, 250, 350 and 421 bytes (421 is the largest that fits).

- **Order.** The amp sent the parts of every multi-part reply in order, `00` first (117 captured replies), so a client
  can start a new message whenever part 0 arrives.
- **Acks.** The ack for a part is empty. It does not say which part it acknowledges, so the app sends the next
  part only after the previous one's ack. Every captured upload had exactly one ack per part (8 uploads, 25 parts).

## 3. Value encoding

Payloads are sequences of [MessagePack](https://msgpack.org) values with no wrapper array or map. A struct is simply
its fields in order.

| Type | Encoding |
|---|---|
| int | positive fixint `00`–`7F`, `CC` u8, `CD` u16 BE, `CE` u32 BE, `D0`/`D1`/`D2` signed 8/16/32, negative fixint `E0`–`FF` |
| float | `CA` + float32 BE |
| bool | `C2` false, `C3` true |
| string | fixstr `A0`–`BF`, or `D9 <len>`; the string is UTF-8 and the length counts its encoded bytes |
| prefixed string | the string's UTF-8 byte length as an int, then the string. Used for every effect id and name, e.g. `0A AA 4D 6F 6E 6F 52 65 76 65 72 62` = "MonoReverb". The two lengths matched in all 381 captured and direct samples, all of them ASCII; strings with other characters were never seen. |
| array | fixarray `90`–`9F`, or `DC <u16>` |
| binary | `C4 <len> <bytes>` |
| null | no bytes at all (empty payload) |

Preset and amp parameters (sections 6–7) are IEEE-754 half-precision bit patterns, sent as the smallest msgpack
unsigned int that holds them (`00`–`7F`, `CC xx`, `CD xxxx`). Values are rounded to half precision with ties away from
zero: the amp did so from 2^-14 up (168 values over 14 binades), and round-half-even would give different bytes than
the amp stores. The amp stores values below 2^-14 (6.1e-5) as 0 in presets, though `02 04` still returns the exact
value.

When round-tripping presets and amp data, keep the raw half bit patterns; converting them through numbers loses NaN
payloads.

## 4. Commands

Payload types are listed in field order, using the types from section 3. "chain" is always 0 on REACTOR (inferred: the
index of the signal chain). Unless noted otherwise, an `01` command is answered with `04 <sub>` and an empty payload.

Coverage was checked by scanning every read (`02 00`–`02 FF`) with three payloads (empty, `00`, 32 zero bytes):

- exactly the 24 reads marked *verified* below answer;
- a read that is missing fields still answers, but the missing fields take unpredictable values: `02 01 [00]`
  returned slot 7 (the current slot) while an empty `02 01` returned slot 0, and `02 A7 [00]` once returned bank 00
  variant 10 and later variant 0. In a later run, `02 01` with the slot missing read slot 0 in 19 of 19 tries. Always
  send every field.

### 4.1 Device

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `02 11` | `03 11` prefixed string | Bluetooth name, e.g. "Reactor 50 BT Control" | verified, app |
| `02 23` | `03 23` prefixed string | serial number | verified, app |
| `02 2F` | `03 2F` u32 | firmware version: the four bytes of the u32 are a.b.c.d (`0002056C` = 0.2.5.108) | verified, app |

### 4.2 Presets

There are 8 preset slots, numbered 0–7. The app calls them 1–8. The panel's Select and Bank buttons work in
2 banks of 4.

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `02 01` type, slot | `03 01` preset (section 6) | `00 n` reads slot n; `01 00` reads the current (possibly edited) preset. `00 7F`, `00 08` and `02 00` get no reply. The app pads this request to 32 bytes with zeros; the amp answers the two bytes alone, or with an extra byte, the same way. | verified, app |
| `01 01` preset | `04 01` per part | header `00 n` stores into slot n; header `00 7F` loads into the temporary slot, which is not stored | verified, app |
| `01 38` type, slot | `04 38` | select a preset: `00 n` (slot n) or `00 7F` (the temporary preset just uploaded). Selecting slot n also copies amp bank `1n` into the working bank `7F` (section 7). `02 1A` can still report the previous preset's edited flag in a read sent immediately after the ack (2 of 31 selections), never in one sent 40 ms or more later; 45 timed polls at 0–800 ms were all clear. No `03 1A` or `03 38` marks the change. `02 10` reports the new slot in the first poll (11 of 11). | verified, app |
| `02 10` | `03 10` type, slot | current preset. After `01 38 [0, 7F]` it still reports the previously selected slot, and `02 1A` reports that slot as edited: the temporary preset becomes the current slot's unsaved state. | verified |
| `02 1A` int array | `03 1A` array of (int chain, int slot, bool edited) | state of the current preset. The app sends `[0]`; REACTOR always answers with 4 identical entries. | verified, app |
| `02 2B` int type (0) | `03 2B` array of 8 ints | stored preset checksums (section 9), one unsigned int per slot. The array header is `98`; the ints use the normal compact encodings, so zero is `00`. Type 1 gives zeros: `98 00 00 00 00 00 00 00 00`. | verified, app |

### 4.3 Amp data

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `02 A7` bank, variant | `03 A7` amp data (section 7) | read one variant of a bank. Other banks (e.g. `06`, `0F`, `18`, `7E`) and variants above 14 (15 for `7D`) get no reply. The app pads this request to 32 bytes with zeros; the two bytes alone get the same reply. | verified, app |
| `01 A7` amp data with header `<bank> 00` | `04 A7` per part | write a bank's base, variant 0, in full | verified, app |
| `01 A7` `03 <bank> <n> 00 …` | `04 A7` per part | write variants 1–14 as differences from the base (section 8) | verified, app |
| `02 AB` int type (0) | `03 AB` array of 14 ints | stored amp checksums (section 9), one unsigned int per bank; array header `9E`, ints encoded as in `03 2B`. Type 1 gives the same values. | verified, app |
| `01 B1` bank, variant | `04 B1` | make this bank/variant the live amp (details below the table). The app sends `<front-panel amp 00–05> 07` when an amp is picked, and `7F 07` after uploading a library amp. | verified, app |

**`01 B1` details.** No event is sent (no `03 B1` in 22 calls). The preset is marked edited without a `03 1A`, its amp
section becomes the new amp, and its `ReactorAmp` parameter 0 becomes the variant number.

- **Banks `00`–`05`:** `7D`/0 becomes that library variant in every block except the five knob values (90 of 90). The
  knob values are kept if that amp was already live, including the slot's own library amp (8 of 8); otherwise they
  become the variant's own (80 of 80).
- **Bank `17`** is slot 7's stored bank whatever slot is current: on slots 0–6, `[17, 7]` made slot 7's amp live and
  the preset's amp (7 of 7). The knob values are always kept (34 of 34).
- **Bank `7F`:** `[7F, k]` loads variant k of whatever `7F` holds, with that variant's own knob values (38 of 38). After
  `01 A7` writes `7F`, it loads the uploaded amp from every state tried (31 of 31).
- **After a library amp other than the slot's own is picked,** `02 A7 [7F, v]` gets no reply (30 of 30, and 13 of 13
  in another run) and `[7F, k]` is ignored (20 of 20), until `01 B1` picks the preset's own amp again (its library
  bank, or `17` on slot 7), a preset is selected, or `7F` is written.
- `7D`/1–14 are not refreshed by `01 B1` or by a write to `7F` (9 of 9 reads); they keep the previous amp's variants.
  Later `01 04 ReactorAmp 0` writes use the variants of the amp that the last `01 B1` loaded (15 of 15), even after
  another upload to `7F` (3 of 3). Inferred: the amp keeps a copy of the variants taken when `01 B1` was sent.

### 4.4 Effects

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `01 04` prefixed string dsp, int index, float value, int chain | none | set one parameter (the app streams these while a knob moves) | verified, app |
| `02 04` prefixed string dsp, int index, int chain | `03 04` float | read one parameter: the value as last set, as float32 (2,018 of 2,018 values; Studio Reverb Mode is the exception, 11.2). The preset stores it rounded to half precision; 0.0 if the block is not in the chain | verified |
| `01 15` prefixed string dsp, bool on, int chain | `04 15` | turn an effect on or off. Switching on a Gate, Comp, Drive, Mod, Delay or Reverb model (categories 0–2, 4–6) also sends `03 B3 [category, true]`, even when it is already on or not in the chain (then nothing else changes). EQ, Wah and FX Loop do not, nor does switching off. On the FX Loop, on = true switches an already-on block off and sends `03 15 [EffectLoop, false, 0]` (3 calls: on, off, on), so read `02 15` first; the other blocks are idempotent. Otherwise no `03 15` is sent. | verified, app |
| `02 15` prefixed string dsp, int chain | `03 15` bool | effect on/off; false if the block is not in the chain | verified |
| `01 06` prefixed string old, prefixed string new, int chain | `04 06` | replace an effect model. The new block keeps the old block's on/off state (133 of 133), and a delay also keeps the old block's BPM switch (52 of 52); all other parameters start at the model's defaults. Replacing a model with itself does nothing. The amp does not echo it as an event (0 of 105). | verified, app |
| `01 A6` int array `[a, b]` | `04 A6` | swap the blocks at chain positions a and b (0-based). E.g. `92 07 08` swaps positions 7 and 8; `92 05 07` swaps 5 and 7 and leaves 6 alone. | verified |
| `01 B3` int category, bool | `04 B3` | select an effect category, as the panel's FX buttons do. The amp does not echo it with `03 B3` (71 `01 B3` in the app trace and 11 sent directly, no echo). | verified, app |

### 4.5 Tempo and tuner

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `01 62` float BPM | `04 62` | set the current preset's tempo, 40–300 BPM (higher not tried). Below 40, or sent as a msgpack int, the tempo is acknowledged but ignored. A valid tempo also sets the BPM-sync parameter of every tempo-capable effect to 1 (section 12). | verified |
| `01 65` bool | `04 65` | tuner on/off; while on, the amp streams `03 64` (section 5) | verified, app |
| `02 65` | `03 65` bool | tuner state | verified, app |

### 4.6 Settings

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `01 74` array of (int input, int mode) | `04 74` | input impedance: `91 00 01` = `[[0, 1]]` Hi-Z on, `[[0, 0]]` off | verified, app |
| `02 74` int array of inputs | `03 74` array of (int input, int mode) | only input 0 exists: asking for input 1 returns garbage | verified, app |
| `02 73` int array of inputs | `03 73` array of (int input, int, bool plugged) | input jack state, the same data as event `03 73`; the second int was always 0. REACTOR answers with 4 entries; only the first is meaningful (section 12) | verified |
| `01 A2` bool | `04 A2` int 0 | Line Out mutes the speaker | verified, app |
| `02 A2` | `03 A2` bool | | verified, app |
| `01 B2` int | `04 B2` | expression pedal mode: 0 auto, 1 wah only, 2 volume only | verified, app |
| `02 B2` | `03 B2` int | | verified, app |

### 4.7 Wi-Fi

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `02 44` | `03 44` bool connected, prefixed string `<ssid>` | Wi-Fi state and remembered network | verified |

### 4.8 Other reads

These reads answer, but what their values mean was not determined.

| Request | Reply | Meaning | Status |
|---|---|---|---|
| `02 33` int | `03 33` float | meaning unknown; 0.0 for 0–4 | verified |
| `02 71` | `03 71` int ×7 | meaning unknown | verified |
| `02 72` | `03 72` bool, int ×3 | meaning unknown; observed `false, 60, 0, 0` | verified |
| `02 76` | `03 76` int ×3, bool ×3, int | meaning unknown; observed `120, 4, 1, false, false, false, 2000` | verified |
| `02 78` | `03 78` int ×4, bool ×2 | meaning unknown; observed `120, 4, 1, 0, false, false` | verified |
| `02 96` | `03 96` bool | meaning unknown; false here | verified, app |
| `02 9C` | `03 9C` bool | meaning unknown; true here | verified |

### 4.9 Undocumented requests

This project's library sends only reads (`02`) and the `01` requests documented here, and refuses any other request:
an unknown request may change the amp's settings or stored data. Firmware updates are not covered.

## 5. Events (amp → client)

Unsolicited messages use `cmd 03` and the amp's own sequence numbers (`40`–`7F`).

Events received from the amp. Other `03` subs may arrive; treat them as unknown.

| Event | Payload | Meaning | Seen when |
|---|---|---|---|
| `03 15` | prefixed string dsp, bool on, int chain | effect turned on or off | holding an FX button; `01 15` on the FX Loop (4.4) |
| `03 1A` | array of (int chain, int slot, bool edited); events carry one entry, `02 1A` replies four | current preset became edited, or was saved. `01 04`, `01 06`, `01 15` and `01 62` mark the preset edited and send one `03 1A`, when it first becomes edited (14 of 14 first edits after a selection). `01 04 ReactorAmp 0` and `01 B1` mark it edited without a `03 1A`; `01 B3` does not edit it. For panel knobs see 11.3. | front-panel knobs and FX LEVEL; app parameter changes; saving |
| `03 27` | int type, int slot | preset saved on the amp | holding Select |
| `03 37` | prefixed string dsp, int index, float value, int chain | a parameter changed on the amp | every front-panel knob, FX LEVEL, TAP (BPM-sync params) |
| `03 38` | int type, int slot | current preset changed on the amp | Select and Bank buttons |
| `03 63` | float BPM | tempo tapped | TAP button |
| `03 64` | int note, float deviation | tuner reading, several per second (see below) | tuner on |
| `03 65` | bool | tuner turned on or off | holding Bank |
| `03 73` | array of (int input, int, bool plugged) | input jack plugged or unplugged; observed `[[0, 0, false]]` / `[[0, 0, true]]`; the second int was always 0 | guitar cable |
| `03 B1` | int bank, int variant | live amp changed; the bank observed was always the Amp-selector number `00`–`05` | Amp selector, Push/Smooth, Heat |
| `03 B3` | int category, bool | effect category selected | FX buttons; an FX-button hold that turns an effect on; `01 15` switching on a Gate, Comp, Drive, Mod, Delay or Reverb block (4.4). Never after `01 B3`. |

**Tuner readings (`03 64`):**

- **note** is 0–11 = C, C#, D, D#, E, F, F#, G, G#, A, A#, B.
- **deviation** is −1.0 when no pitch is detected. Otherwise it was between 0 and 1 in every reading; inferred: 0.5
  means in tune.
- **Observed:** an open E string read note 4 with values of about 0.45; an A string read note 9. Readings arrive
  about every 120 ms (about 7.8 per second, 90–180 ms apart), whether or not a string is played. The first comes about
  1.5 s after the ack that switches the tuner on (5 of 5 starts, 1499–1519 ms; also about 1.5 s after holding Bank).
  They stop with the ack of `01 65 [false]` (at most one reading already in flight). With nothing played, every
  reading had deviation −1 and note 5 (252 of 252; an earlier session saw note 0), so ignore the note when the
  deviation is −1.

Turning these controls produced no event (from the hardware sessions; the session logs do not record when each control
was used): speaker volume, headphone jack, rear power switch.

## 6. Preset

Preset bytes, as returned by `03 01` and sent with `01 01` (sizes: 1250–1306 bytes for the 8 presets stored on the test
amp; 1288 for the ToneCloud preset the app uploaded):

```
<type> <slot>                  2 bytes: 00 n = slot n, 00 7F = temporary, 01 00 = current (reads only)
C4 10 <16 bytes>               preset id (UUID)
<string>                       name
<string>                       version, e.g. "1.0"
<string>                       description
<string>                       icon image name
<int>                          gain stage: 1–4 on the test amp, higher for higher-gain presets and amps (inferred)
<array of strings>             tags
CA <float32>                   tempo in BPM
amp section:                   the preset's amp, laid out like the amp data in section 7 without the 2-byte header
                               and without the checksum (meta: id, name, version, description, icon, gain stage, tags; then the block list)
effect block list              the 10 effect blocks in signal-chain order
<4 bytes>                      CRC-32/MPEG-2 of everything after the first two bytes, big-endian (section 9)
```

**Block list.** An array header counting the blocks, then three values per block:

| Field | Encoding |
|---|---|
| block code | `C4 02 <code hi> <code lo>` (section 10) |
| on/off | `C3` on, `C2` off |
| parameters | an array of half-float bit patterns (section 3) |

**Effect chain.** The block list is the signal chain, in order, with one block per category. The chain order differs
between presets. Find a block by its code, not by its position. `01 A6` reorders the chain.

**`ReactorAmp` (`040D`)** stands for the amp in the chain:

- **Parameter 0** selects the amp variant (section 7).
  - Presets store the variant number itself, e.g. `CD 47 00` = 7.0.
  - The app writes it with `01 04 ReactorAmp 0` as variant ÷ 14; `02 04` reads back the variant number.
- **Extra parameters.** Factory presets have just this one parameter. ToneCloud presets add five more: the
  front-panel knob values GAIN, BASS, MIDDLE, TREBLE, MASTER.

**Edits are not stored.** Knob, switch and model changes only alter the current preset. To keep them, write the preset
to a slot with `01 01` and header `00 n`, and write its amp (section 7). Selecting another preset discards unsaved
changes.

## 7. Amp data, banks and variants

Amp data, as returned by `03 A7` and sent with `01 A7` (974–1021 bytes in the backups):

```
<bank> <variant>               2 bytes
C4 10 <16 bytes>, <string> name, <string> version, <string> description, <string> icon, <int> gain stage, <array> tags
block list (section 6), normally 6 blocks:
    0502 Amp.Preamp (145 params)   0503 Amp.Tonestack (4)   0505 Amp.Poweramp (110)
    0506 Amp.Transformer (11)      0434 CabCompensator (30) 0435 ReactorCabSim (30)
<4 bytes>                      CRC-32/MPEG-2 of everything after the first two bytes, big-endian
```

Block order can differ: a ToneCloud amp was seen with Tonestack first.

The front-panel knobs are amp parameters:

| Knob | Block | Parameter |
|---|---|---|
| GAIN | `Amp.Preamp` | 0 |
| BASS | `Amp.Tonestack` | 1 |
| MIDDLE | `Amp.Tonestack` | 2 |
| TREBLE | `Amp.Tonestack` | 3 |
| MASTER | `Amp.Poweramp` | 0 |

**Banks:**

| Bank | Contents |
|---|---|
| `00`–`05` | The six Amp-selector amps, in panel order: `00` Clean = "Classic Deluxe" (shown and uploaded by the app as "60's Clean"), `01` Warm = "Vintage 45'", `02` Grit = "M1 Clean", `03` Crunch = "80s Crunch", `04` Hi-Gain = "Briton", `05` Extreme = "Harmonic Halo". |
| `10`–`17` | The amp of preset slot 0–7. |
| `7D` | The live amp. Variant 0 (and 15) is what is playing now, including unsaved knob changes. Variants 1–14 are the amp's own copy of the other variants; they do not always equal `7F` (section 12, item 8). |
| `7F` | The working bank: a copy of the current preset's bank. Selecting stored slot n copies bank `1n` here; the app uploads library and ToneCloud amps here. |

**Variants.** Each bank holds 15 variants, `0`–`14`. Variant k = 5 × row + column, where row is the Push/Smooth
(Character) switch and column is the Heat switch. On the panel, SMOOTH is row 0 (k 0–4) and PUSH is row 2 (k 10–14),
as with the official app's buttons (verified: one run, 4 events):

|  | Heat −2 | −1 | 0 | +1 | +2 |
|---|---|---|---|---|---|
| Smooth | 0 | 1 | 2 | 3 | 4 |
| centre | 5 | 6 | **7** | 8 | 9 |
| Push | 10 | 11 | 12 | 13 | 14 |

- Variant 7 means both switches are centred. A preset can select another variant.
- Variant 0 is the bank's base; it is the one written in full.
- In the library banks, the other variants differ from the base only in `Amp.Preamp` parameters (by Heat column)
  and `Amp.Poweramp` parameters (by Push/Smooth row).
- When the panel switches move, the amp sends `03 B1 [amp, k]`. Here amp was the Amp-selector number (`00`–`05`) of the
  current amp, even when the preset's amp lives in a slot bank. With a preset at variant 7 current, moving the
  Character switch to PUSH, then SMOOTH, then back to the centre sent `03 B1` with variants 12, 7, 2 and 7, and
  `02 04 ReactorAmp 0` read back the same variants (4 of 4).
- The app's equivalent controls send `01 04 ReactorAmp 0 k/14`. They move k by ±5 (row) or ±1 (column),
  clamped, starting from 7, then resend the five knob values.
- The amp rounds the value × 14 to the nearest variant. After `01 04 ReactorAmp 0 k/14` alone, the live amp became
  variant k with the current knob values kept (15 of 15 on slot 7, and 120 of 120 across all 8 slots), so a resend is
  not needed.
- Resent knob values can be overwritten by the variant's own values for about 100 ms. Trials in which all five knobs
  held, out of 25 per delay after the variant write: 13 at 0 ms, 0 at 20 ms, 6 at 40 ms, 4 at 60 ms, 23 at 70 ms, 24 at
  80 ms, 24 at 90 ms, and 25 at 100 ms and later (100 of 100). The latest overwritten write came 92 ms after the
  variant write. This project's client waits 250 ms before it resends.

## 8. Writing a bank: base + differences

The app writes a bank with two `01 A7` messages:

1. **The base.** Variant 0 in full: `<bank> 00 <body> <CRC-32/MPEG-2>`, exactly as `03 A7` returns it.
2. **The other 14 variants**, as differences from the base:

```
03 <bank> <n = 0E> 00
n × record:
    <variant u8> <length u16 LE> <difference> <crc u32 BE>
    difference = 02 00 <groups u8> <crc u32 LE> groups × ( <block position u8> <count u8> count × ( <param index u8> <half u16 LE> ) )
<CRC-32/MPEG-2 of all preceding bytes, BE>
```

`length` counts only the `difference` field, from `02 00` through the last group. It excludes the variant byte, the
length bytes and the trailing big-endian crc. For example, a record with one group of 11 parameters has length `2A`
(42 = 7 + 2 + 11 × 3).

A variant identical to the base needs no groups: the amp accepted a record whose difference is `02 00 00 <crc LE>`
(length 7).

**Rules:**

- Inferred: `02` means "difference" and `00` means "relative to variant 0".
- The app lists only parameters whose value differs from the base, by block position (not code) and then by parameter
  index, both ascending. The amp also accepted records in descending variant order, a message with 3 records instead
  of 14, and a record with no groups.
- On/off flags and meta data are not sent; they are taken from the base.
- **Record checksum.** The 4-byte crc appears twice per record (little-endian inside, big-endian after). Its value is
  a CRC-32 of that variant's full body, i.e. the variant's amp data without its header and trailer.
  - It is the zlib/ISO-HDLC CRC-32 except for one table entry: entry `F5` is `CDD706B3` (standard `CDD70693`).
  - Records built with the standard table do not match the checksums in the app's traffic, and the amp skips records
    whose checksum does not match (next item).
- **What the amp checks.** It rebuilds each variant and compares its CRC with the little-endian copy. A record that
  fails is acknowledged like the others but skipped, so that variant keeps its previous contents. The big-endian copy
  is not checked: a wrong value there was accepted (both re-verified by flipping one bit in each copy). The message
  trailer is not checked either (not re-tested; log not kept).
- **Observed:** in the app's upload of one ToneCloud preset, none of the 14 record checksums matched the variant built
  from the record (0 of 14). When that upload was replayed, the amp skipped all 14 records (replay not in the saved
  logs), so `7F`/1–14 kept their previous contents.
- A base upload changes only variant 0. A differences message can be sent on its own, without a new base.

**Verified:**

- Building this message from the 15 variants read back from a bank reproduces the app's message byte for byte.
- The amp's read-back after such an upload equals the source variants byte for byte.

## 9. Checksums

| Item | Algorithm / meaning |
|---|---|
| Trailer of every preset and amp data | CRC-32/MPEG-2: polynomial `04C11DB7`, init `FFFFFFFF`, no reflection, no final XOR, over all bytes after the 2-byte header, stored big-endian. Matched every preset and amp blob in the saved evidence (292 distinct blobs, both amp- and app-generated). |
| Trailer of the base + differences message | Same CRC-32/MPEG-2, over the whole message before it. |
| `03 2B` (per preset slot) | The checksum stored with that slot. After the app or the panel saves a slot it equals the preset's trailer. Values not written by such a save could not be reproduced from the presets as stored; one slot held `FFFFFFFF`. |
| `03 AB` (14 values: banks `00`–`05`, then `10`–`17`) | The checksum stored with each bank: the trailer of the base last written by the app, or of the library bank after a panel save (section 12). It is not recomputed when the bank's contents change. |

On connect, the app read both lists, then all 8 slots, but of the 14 banks in `03 AB` only bank `10` (at capture time;
section 13). Why it read only that bank was not determined.

## 10. Block codes

The amp names a block by a 2-byte code in presets, and by an id string in commands (the `dsp` field in sections 4
and 5).

All 35 codes used by REACTOR presets were read back from the amp:

| Code | Id string | Params | Category | Panel / app name |
|---|---|---|---|---|
| `0309` | `bias.noisegate` | 3 | Gate | Noise Gate |
| `040a` | `SustainComp` | 4 | Comp | Sustain Comp |
| `040b` | `RCBooster` | 4 | Drive | Clean Boost |
| `040c` | `JimiWah` | 6 | Wah | Wah |
| `040d` | `ReactorAmp` | 1 or 6 | Amp | the amp in the chain |
| `040f` | `ChorusAnalog` | 4 | Mod | Analog Chorus |
| `0410` | `DelayEchoFilt` | 5 | Delay | Filter Echo |
| `0411` | `MonoReverb` | 8 | Reverb | Studio Reverb |
| `0412` | `EffectLoop` | 4 | FX Loop | Effect Loop |
| `0416` | `BBEOpticalComp` | 3 | Comp | Opto Comp |
| `0418` | `Tremolo` | 3 | Mod | Tremolo |
| `0419` | `ChorusCloner` | 2 | Mod | Cloner Chorus |
| `041a` | `Flanger` | 3 | Mod | Jet Flanger |
| `041b` | `Phaser` | 4 | Mod | Classic Phaser |
| `041f` | `DistortionOCD` | 4 | Drive | OB Drive |
| `0420` | `KlonCentaur` | 3 | Drive | Gold Drive |
| `0421` | `ProCoRat` | 3 | Drive | Black Dist |
| `0422` | `DistortionTS9` | 3 | Drive | Green Drive |
| `0425` | `DelayRE201` | 5 | Delay | Tape Echo |
| `0426` | `DelayDM2` | 4 | Delay | Analog Delay |
| `042a` | `RedComp` | 2 | Comp | Red Comp |
| `042b` | `4kComp` | 4 | Comp | Studio Comp |
| `042c` | `GuitarEQ7` | 8 | EQ | EQ7 |
| `042d` | `Tremulator` | 3 | Mod | Tremolator |
| `042e` | `TremoloSquare` | 3 | Mod | Square Tremolo |
| `042f` | `FuzzFace` | 2 | Drive | Classic Fuzz |
| `0430` | `BigMuff` | 3 | Drive | Wall Fuzz |
| `0431` | `JH.SupaFuzz` | 2 | Drive | Super Fuzz |
| `0432` | `Delay` | 5 | Delay | Digital Delay |
| `0434` | `CabCompensator` | 30 | amp data | cabinet compensation |
| `0435` | `ReactorCabSim` | 30 | amp data | cabinet |
| `0502` | `Amp.Preamp` | 145 | amp data | preamp (GAIN = p0) |
| `0503` | `Amp.Tonestack` | 4 | amp data | tone stack (BASS/MIDDLE/TREBLE = p1–p3) |
| `0505` | `Amp.Poweramp` | 110 | amp data | power amp (MASTER = p0) |
| `0506` | `Amp.Transformer` | 11 | amp data | transformer |

The model names are those shown in the app's model menu when the traffic was captured.

## 11. Effect models and parameters

### 11.1 Categories

Categories are used by `01 B3` and `03 B3`:

| Number | Category | Number | Category |
|---|---|---|---|
| 0 | Gate | 5 | Delay |
| 1 | Comp | 6 | Reverb |
| 2 | Drive | 7 | EQ |
| 3 | Amp | 8 | Wah |
| 4 | Mod | 9 | FX Loop |

### 11.2 Parameters

**Values:**

- Every parameter listed below is a float from 0 to 1.
- **Switches:** 1 means the first label, 0 the second.
- **On/off flags.** Noise Gate parameter 2 and Studio Reverb parameter 7 are the block's on/off flag itself: any value
  other than 0 turns the block on, and 0 turns it off. `01 15` stores 1.0 / 0.0 there. A value below 2^-14 turns the
  block on but reads back as 0 in the preset (section 3).
- **Step lists:** each step's value is the one listed.
- **Delay times** follow two scales, chosen by the effect's BPM switch. In the four delay models, BPM-on step k
  (k = 0…13) is k/13.
- **Off-grid values.** The amp stores step and switch values as written, without snapping them to the listed values
  (243 of 243; only Studio Reverb Mode is rounded, to 0.001). The presets stored on the test amp hold some off-grid
  step and switch values. What the DSP does with them cannot be observed over Bluetooth.

Index = the parameter number in `01 04` / `02 04` / presets. The app shows the knobs in index
order; the two Classic Phaser knobs were checked in the app (SPEED → 0, INTENSITY → 1). The defaults of the
single-model categories (Gate, Wah, EQ, Reverb, FX Loop) cannot be reached: `01 06` to the same model does nothing
(4.4).

#### Noise Gate — `bias.noisegate`, code `0309`, 3 params (Gate)

| # | Label | Value mapping |
|---|---|---|
| 0 | THRESHOLD | 0–1 shown as 0–10 |
| 1 | DECAY | 0–1 shown as 0–10 |
| 2 | (no label) | switch: 1 = ON, 0 = OFF; the block's on/off flag (see Values) |

#### Sustain Comp — `SustainComp`, code `040a`, 4 params (Comp)

| # | Label | Value mapping |
|---|---|---|
| 0 | LEVEL | 0–1 shown as 0–10 |
| 1 | TONE | 0–1 shown as 0–10 |
| 2 | ATTACK | 0–1 shown as 0–10 |
| 3 | SUSTAIN | 0–1 shown as 0–10 |

#### Red Comp — `RedComp`, code `042a`, 2 params (Comp)

| # | Label | Value mapping |
|---|---|---|
| 0 | GAIN | 0–1 shown as 0–10 |
| 1 | Threshold | 0–1 shown as 0–10 |

#### Opto Comp — `BBEOpticalComp`, code `0416`, 3 params (Comp)

| # | Label | Value mapping |
|---|---|---|
| 0 | Volume | 0–1 shown as -6–6 dB |
| 1 | Comp | 0–1 shown as 0–10 |
| 2 | Pad | switch: 1 = -15dB, 0 = 0dB |

#### Studio Comp — `4kComp`, code `042b`, 4 params (Comp)

| # | Label | Value mapping |
|---|---|---|
| 0 | Sustain | 0–1 shown as 0–10 |
| 1 | Level | 0–1 shown as 0–10 |
| 2 | Attack | 0–1 shown as 0–10 |
| 3 | Clipping | 0–1 shown as 0–10 |

#### OB Drive — `DistortionOCD`, code `041f`, 4 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | Volume | 0–1 shown as 0–10 |
| 1 | Tone | 0–1 shown as 0–10 |
| 2 | Drive | 0–1 shown as 0–10 |
| 3 | LP / HP | switch: 1 = HP, 0 = LP |

#### Gold Drive — `KlonCentaur`, code `0420`, 3 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | OUTPUT | 0–1 shown as 0–10 |
| 1 | TREBLE | 0–1 shown as 0–10 |
| 2 | GAIN | 0–1 shown as 0–10 |

#### Black Dist — `ProCoRat`, code `0421`, 3 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | VOLUME | 0–1 shown as 0–10 |
| 1 | DISTORTION | 0–1 shown as 0–10 |
| 2 | FILTER | 0–1 shown as 0–10 |

#### Green Drive — `DistortionTS9`, code `0422`, 3 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | LEVEL | 0–1 shown as 0–10 |
| 1 | OVERDRIVE | 0–1 shown as 0–10 |
| 2 | TONE | 0–1 shown as 0–10 |

#### Clean Boost — `RCBooster`, code `040b`, 4 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | Volume | 0–1 shown as 0–10 |
| 1 | Gain | 0–1 shown as 0–10 |
| 2 | Bass | 0–1 shown as 0–10 |
| 3 | Treble | 0–1 shown as 0–10 |

#### Classic Fuzz — `FuzzFace`, code `042f`, 2 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | Volume | 0–1 shown as 0–10 |
| 1 | Gain | 0–1 shown as 0–10 |

#### Wall Fuzz — `BigMuff`, code `0430`, 3 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | VOLUME | 0–1 shown as 0–10 |
| 1 | Tone | 0–1 shown as 0–10 |
| 2 | Sustain | 0–1 shown as 0–10 |

#### Super Fuzz — `JH.SupaFuzz`, code `0431`, 2 params (Drive)

| # | Label | Value mapping |
|---|---|---|
| 0 | VOLUME | 0–1 shown as 0–10 |
| 1 | Filter | 0–1 shown as 0–10 |

#### Analog Chorus — `ChorusAnalog`, code `040f`, 4 params (Mod)

| # | Label | Value mapping |
|---|---|---|
| 0 | E.LEVEL | 0–1 shown as 0–10 |
| 1 | RATE | 0–1 shown as 0–10 |
| 2 | DEPTH | 0–1 shown as 0–10 |
| 3 | TONE | 0–1 shown as 0–10 |

#### Cloner Chorus — `ChorusCloner`, code `0419`, 2 params (Mod)

| # | Label | Value mapping |
|---|---|---|
| 0 | RATE | 0–1 shown as 0–10 |
| 1 | DEPTH | switch: 1 = HIGH, 0 = LOW |

#### Jet Flanger — `Flanger`, code `041a`, 3 params (Mod)

| # | Label | Value mapping |
|---|---|---|
| 0 | MIX | 0–1 shown as 0–10 |
| 1 | RATE | 0–1 shown as 0–10 |
| 2 | DEPTH | 0–1 shown as 0–10 |

#### Classic Phaser — `Phaser`, code `041b`, 4 params (Mod)

The amp stores 4 parameters; the app shows indexes 0–1 only.

| # | Label | Value mapping |
|---|---|---|
| 0 | SPEED | 0–1 shown as 0–10 |
| 1 | INTENSITY | 0–1 shown as 0–10 |

#### Tremolo — `Tremolo`, code `0418`, 3 params (Mod)

| # | Label | Value mapping |
|---|---|---|
| 0 | LEVEL | 0–1 shown as 0–10 |
| 1 | SPEED | 0–1 shown as 0–10 |
| 2 | DEPTH | 0–1 shown as 0–10 |

#### Tremolator — `Tremulator`, code `042d`, 3 params (Mod)

| # | Label | Value mapping |
|---|---|---|
| 0 | Depth | 0–1 shown as 0–10 |
| 1 | Speed | BPM off: 0–1 shown as 0–10; BPM on: 0 = 1/2, 0.23 = 1/4, 0.461 = 1/8, 0.692 = 1/16 |
| 2 | BPM | switch: 1 = on, 0 = off |

#### Square Tremolo — `TremoloSquare`, code `042e`, 3 params (Mod)

| # | Label | Value mapping |
|---|---|---|
| 0 | Rate | 0–1 shown as 0–10 |
| 1 | Depth | 0–1 shown as 0–10 |
| 2 | Mix | 0–1 shown as 0–10 |

#### Wah — `JimiWah`, code `040c`, 6 params (Wah)

| # | Label | Value mapping |
|---|---|---|
| 0 | Program | steps: 0 = Prog1, 0.2 = Prog2, 0.4 = Prog3, 0.6 = Prog4, 0.8 = Prog5, 0.9 = Manual, 1 = Auto Detect |
| 1 | BPM Sync | switch: 1 = on, 0 = off |
| 2 | ms | 0–1 shown as 125–1000 ms |
| 3 | Bar | steps: 0 = 1/8, 0.25 = 1/4, 0.5 = 1/2, 0.75 = 1 |
| 4 | Sensitivity | 0–1 shown as 0–10 |
| 5 | (no label) | 0–1 shown as 0–10 |

#### EQ7 — `GuitarEQ7`, code `042c`, 8 params (EQ)

| # | Label | Value mapping |
|---|---|---|
| 0 | LEVEL | 0–1 shown as -10–10 |
| 1 | 100 | 0–1 shown as -10–10 |
| 2 | 200 | 0–1 shown as -10–10 |
| 3 | 400 | 0–1 shown as -10–10 |
| 4 | 800 | 0–1 shown as -10–10 |
| 5 | 1.6K | 0–1 shown as -10–10 |
| 6 | 3.2K | 0–1 shown as -10–10 |
| 7 | 6.4K | 0–1 shown as -10–10 |

#### Filter Echo — `DelayEchoFilt`, code `0410`, 5 params (Delay)

| # | Label | Value mapping |
|---|---|---|
| 0 | LEVEL | 0–1 shown as 0–10 |
| 1 | DELAY | BPM off: 0–1 shown as 100–1000 ms; BPM on: k/13 for k = 0…13 = 1/32, 1/16, 1/16t, 1/16d, 1/8, 1/8t, 1/8d, 1/4, 1/4t, 1/4d, 1/2, 1/2t, 1/2d, 1 |
| 2 | FEEDBACK | 0–1 shown as 0–10 |
| 3 | TONE | 0–1 shown as 0–10 |
| 4 | BPM | switch: 1 = on, 0 = off |

#### Digital Delay — `Delay`, code `0432`, 5 params (Delay)

| # | Label | Value mapping |
|---|---|---|
| 0 | Mix | 0–1 shown as 0–10 |
| 1 | Feedback | 0–1 shown as 0–10 |
| 2 | DelayTime | BPM off: 0–1 shown as 1–1000 ms (range set by Mode: 1–50 ms; 50–200 ms; 200–500 ms; 500–1000 ms); BPM on: k/13 for k = 0…13 = 1/32, 1/16, 1/16t, 1/16d, 1/8, 1/8t, 1/8d, 1/4, 1/4t, 1/4d, 1/2, 1/2t, 1/2d, 1 |
| 3 | Mode | steps: 0.3 = 50ms, 0.4 = 200ms, 0.6 = 500ms, 0.72 = 1s |
| 4 | BPM | switch: 1 = on, 0 = off |

#### Analog Delay — `DelayDM2`, code `0426`, 4 params (Delay)

| # | Label | Value mapping |
|---|---|---|
| 0 | ECHO | 0–1 shown as 0–10 |
| 1 | REPEAT RATE | BPM off: 0–1 shown as 0–10; BPM on: k/13 for k = 0…13 = 1/32, 1/16, 1/16t, 1/16d, 1/8, 1/8t, 1/8d, 1/4, 1/4t, 1/4d, 1/2, 1/2t, 1/2d, 1 |
| 2 | INTENSITY | 0–1 shown as 0–10 |
| 3 | BPM | switch: 1 = on, 0 = off |

#### Tape Echo — `DelayRE201`, code `0425`, 5 params (Delay)

| # | Label | Value mapping |
|---|---|---|
| 0 | SUSTAIN | 0–1 shown as 0–10 |
| 1 | VOLUME | 0–1 shown as 0–10 |
| 2 | TONE | 0–1 shown as 0–10 |
| 3 | SHORT ~ LONG | BPM off: 0–1 shown as 70–600 ms; BPM on: k/13 for k = 0…13 = 1/32, 1/16, 1/16t, 1/16d, 1/8, 1/8t, 1/8d, 1/4, 1/4t, 1/4d, 1/2, 1/2t, 1/2d, 1 |
| 4 | BPM | switch: 1 = on, 0 = off |

#### Studio Reverb — `MonoReverb`, code `0411`, 8 params (Reverb)

| # | Label | Value mapping |
|---|---|---|
| 0 | Level | 0–1 shown as 0–10 |
| 1 | Damping | 0–1 shown as 0–10 |
| 2 | Dwell | 0–1 shown as 0–10 |
| 3 | Time | 0–1 shown as 0–10 |
| 4 | Low Cut | 0–1 shown as 20–400 Hz |
| 5 | High Cut | 0–1 shown as 8000–1000 Hz |
| 6 | Mode | steps: 0 = Room Studio A, 0.1 = Room Studio B, 0.2 = Chamber, 0.3 = Hall Natural, 0.4 = Hall Medium, 0.5 = Hall Ambient, 0.6 = Plate Short, 0.7 = Plate Rich, 0.8 = Plate Long; stored rounded to 0.001 (0.28378353 → 0.284) |
| 7 | On/Off | switch: 1 = ON, 0 = OFF; the block's on/off flag (see Values) |

#### Effect Loop — `EffectLoop`, code `0412`, 4 params (FX Loop)

| # | Label | Value mapping |
|---|---|---|
| 0 | SendVol | 0–1 shown as -24–6 dB |
| 1 | ReturnVol | 0–1 shown as -24–6 dB |
| 2 | SendActive | switch: 1 = on, 0 = off |
| 3 | ReturnActive | switch: 1 = on, 0 = off |


### 11.3 Front panel → messages

| Control | Messages from the amp |
|---|---|
| GAIN, BASS, MIDDLE, TREBLE, MASTER | `03 37` with the parameter from section 7. Values move in steps of 1/4080. `03 1A` (edited) came with most GAIN and MASTER steps (14 of 15) but with only 2 of 29 BASS, MIDDLE and TREBLE steps, so do not rely on it. |
| Amp selector | `03 B1 [amp 00–05, current variant]` |
| Push/Smooth, Heat | `03 B1 [amp, variant]` (section 7). PUSH selects row 2 (variants 10–14) and SMOOTH row 0 (0–4); verified in one run (4 events). |
| FX button, tap | `03 B3 [category, true]` |
| FX button, hold | `03 15 [dsp, on/off, 0]`; when it turns the effect on, also `03 B3 [category, true]` |
| FX LEVEL | `03 37` for parameter 0 of the selected effect (Analog Delay: ECHO) |
| TAP | `03 63 [bpm]`, then `03 37` setting each BPM-sync parameter to 1 |
| Select, tap | `03 38 [0, next slot in the bank]` (wraps within the bank of 4; observed once, as two identical `03 38`) |
| Select, hold | `03 1A`, `03 27 [0, slot]` (save; see section 12) |
| Bank, tap | `03 38 [0, slot in the other bank]`. The one observation (4 → 0 → 4) fits both the same position and the slot last selected in that bank. |
| Bank, hold | `03 65 [true]`, then `03 64` readings |
| Guitar input jack | `03 73 [[0, 0, plugged]]` |
| Volume knob, headphone jack, rear power switch | nothing |

## 12. Behaviour notes

These were observed on firmware 0.2.5.108:

1. **Tempo changes switch BPM sync on.** Setting the tempo, with `01 62` or the TAP button, also sets every
   tempo-capable effect's BPM-sync parameter to 1. Seen for the Wah ("BPM Sync", parameter 1), Tremolator ("BPM", 2)
   and the delays ("BPM": Filter Echo 4, Digital Delay 4, Analog Delay 3, Tape Echo 4).
2. **Saves rewrite the slot's amp bank from the library amp.**
   - **Presets never saved** (6 of the 8 slots on the test amp) store the preset's knob values in all 15 variants of
     their amp bank. One other slot's bank has them only in variant 0 and the variant its preset selects; slot 7 had
     been saved from the app.
   - **Saving from the app** (`01 01` + `01 A7`, slot 7):
     - variant 7 = the live amp, with the knob values;
     - the other 14 variants = exact copies of the library bank of the same amp (`00`–`05`).
   - **Saving into the current slot** n (the slot `02 10` reports, including while a temporary preset is current)
     clears the edited flag:
     - the amp sends `03 1A [[0, n, false]]` during or just after the save, and `02 1A` reads false from then on;
     - `02 10` is unchanged;
     - afterwards `7F` and `7D`/1–14 equal the saved bank `1n`;
     - a client does not need to reselect the slot.
   - **Holding Select on the panel**, on an unedited preset (slot 4):
     - all 15 variants, including 7, became exact copies of the library bank;
     - `03 AB` changed to that library bank's checksum;
     - the preset data was unchanged.
3. **Repeated entries.** `02 1A` and `02 73` answer with 4 entries; use the first.
   - `02 1A`: the 4 entries were identical in 300 of 300 reads.
   - `02 73`: usually `[0, 0, plugged]` followed by three `[0, 0, false]`. In 2 of 300 reads the last three held
     leftover memory instead: values of any type, making the reply 25 or 33 bytes instead of 13. An earlier run, whose
     log was not kept, had 6 of 300 (29–33 bytes, for example `94 00 00 C3 CE FF FF FF FF 01 D2 …`). Decode the first
     entry and skip the rest.
   - `02 74` for input 1 returns garbage.
4. **Variant number scaling.** `ReactorAmp` parameter 0 is written as variant ÷ 14 but read back as the variant
   number. The amp rounds value × 14 to the nearest whole variant and stores that number in the preset.
5. **Tolerant parsing.** Reads with missing fields still answer, but the missing fields are not reliably defaulted
   (section 4). Send every field.
6. **Model changes.** A model inserted with `01 06` keeps the old block's on/off state, and a delay keeps the old BPM
   switch; its other parameters start at the model's defaults (4.4).
7. **Temporary presets.** A preset loaded with `01 01 [00 7F]` and `01 38 [0, 7F]` replaces the current slot's
   unsaved state: `02 10` keeps reporting the previously selected slot, `02 1A` reports it as edited, and `02 01 [1, 0]`
   returns the loaded preset.
8. **Working bank.** Bank `7F` is the amp's working copy of the current preset's bank. Selecting a stored slot copies
   that slot's bank into `7F` (all 15 variants, checked for all 8 slots). A temporary load writes `7F` directly.
   Writing `7F` while a stored slot was current did not change the live amp (14 of 14 uploads) until `01 B1 [7F, k]`
   selected a variant. `7D`/1–14 follow `7F` only sometimes, so they cannot tell which bank the live amp came from:
   - after a temporary load (`01 38 [0, 7F]`, then `01 A7` to `7F`), they equalled `7F`/1–14 byte for byte;
   - writing `7F` while a stored slot was current, even followed by `01 B1 [7F, k]`, left them unchanged;
   - after selecting a stored slot, for 5 of the 8 slots they held the variants of the Amp-selector bank of the
     preset's amp, while `7F` held the slot's bank, which differs from it only in the knob values (item 2). For the
     other 3 slots they equalled `7F`. Inferred rule: when the slot bank's stored `03 AB` value is the checksum of a
     library bank, `7D`/1–14 get that library bank. Two of those 3 slots carry their own checksum. Slot 7 does not
     fit: its value is a library bank's checksum, but `7D`/1–14 equalled `7F`, which differs from that library bank in
     the BASS and TREBLE of variant 7 (item 2);
   - after the current slot was saved, `7F` and `7D`/1–14 both equalled the saved bank `1n` (item 2).

## 13. What the official app sends

| Action | Messages |
|---|---|
| Connect | `02 23`, `02 2F`, `02 2B [0]`, `02 AB [0]`, `02 1A [0]`, `02 01 [1, 0]` (current), `02 A7 [7D, 0…14]`, `02 65`, then `02 01 [0, n]` for all 8 slots and `02 A7 [10, 0…14]`; at capture time it read no other bank (section 9) |
| Open the device card (Settings) | `02 B2`, `02 2F`, `02 11`, `02 74 [0]`, `02 A2`, `02 2F`, `02 B2` |
| Open EXP pedal calibration | `02 96` |
| Turn a knob | a stream of `01 04` (no replies) |
| Effect on/off | `01 15`; for Studio Reverb the app also sets its On/Off parameter with `01 04 MonoReverb 7 1.0` (on) or `0.0` (off) |
| Pick a category | `01 B3 [category, true]` |
| Change a model | `01 06 [old, new, 0]`, then `01 15 [new, true, 0]` if the old model was on, then `01 B3 [cat, true]`. When the card was selected first, the app sends `01 B3 [cat, true]` before `01 06` as well; after a change to Tremolator it also sent `01 04 Tremulator 1 0.461`. |
| Pick a front-panel amp | `01 B1 [amp, 7]` |
| Load a library amp | `01 A7` base to bank `7F`, `01 A7` differences to `7F`, `01 B1 [7F, 7]`; this worked from every state tried (31 of 31, section 4.3) |
| Load a ToneCloud preset (a library preset load was not captured) | `01 01` with header `00 7F` (4 parts), `01 38 [0, 7F]`, `01 A7` base to `7F`, `01 A7` differences to `7F` |
| Save to slot n | `01 01` with header `00 n`, `01 A7` base to bank `1n`, `01 A7` differences to `1n` |
| Select slot n | `01 38 [0, n]` |
| AI Push/Smooth/Heat | `01 04 ReactorAmp 0 k/14`, then `01 04` for the five knobs |
| Tuner | `01 65 [true]` … `01 65 [false]` |
| Hi-Z, Line Out mute, EXP mode | `01 74`, `01 A2`, `01 B2` |
