---
applyTo: "src/**"
---

# Library code (`src/`)

- **Platform.** Plain ES modules with no dependencies. The code must run unchanged in browsers and in Node 20+, and
  must not touch the DOM.
- **Bytes.** Binary data is `Uint8Array`. Keep preset and amp parameters as raw half-float bit patterns; do not round-trip
  them through numbers.
- **Implement the spec.** Follow [docs/protocol.md](../../docs/protocol.md) and cite its section in a comment where the
  code depends on amp behaviour.
- **Keep the safety guards.** Do not remove or weaken:
  - `checked()` in `client.js`, which sends only reads (`02`) and the changes in `SET_SUBS` (`messages.js`);
  - `checkUpload()` and the slot and bank checks in `ReactorClient` (writes only to slots `0`–`7` / `7F` and banks
    `10`–`17` / `7F`);
  - the 0–1 range check in `Requests.setParam` and the 40–300 tempo range;
  - the checksum checks before uploads, and `buildAmpBatch`'s rebuild-and-compare check;
  - the read-back in `saveCurrent()` / `writeSlot()`.
- **Requests and timing.**
  - New requests go into `Requests` (`messages.js`) with the reply they expect, and a new change into `SET_SUBS`.
    Add one only after it was verified on the amp, and never one that can wipe or reset the amp, update its firmware,
    or change its name, identity or network settings.
  - `ReactorClient` serializes requests, so do not bypass its queue.
  - Keep the settle delays (`presetSettle`, `variantSettle`) unless new hardware evidence says otherwise.
- **Tests.** Every fix or new behaviour gets a focused test in `test/` that fails without the change.
