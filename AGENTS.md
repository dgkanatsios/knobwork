# AGENTS.md

Instructions for AI coding agents working on Knobwork. Read this file first. Before you change protocol code, read the
relevant sections of [docs/protocol.md](docs/protocol.md).

## The project

- **Knobwork** is an unofficial web editor for the Positive Grid REACTOR guitar amp, over Web Bluetooth. It also
  contains a JavaScript library for the amp's Bluetooth LE protocol.
- **Plain HTML and ES modules.** There is no build step, there are no runtime or dev dependencies, and it uses no
  framework. The app is served as static files (e.g. GitHub Pages).
- **[docs/protocol.md](docs/protocol.md) is the protocol specification** and the source of truth: the library
  implements it. It describes a REACTOR 50 (firmware 0.2.5.108).

## Layout

| Path | What it is |
|---|---|
| `index.html`, `app/app.js`, `app/styles.css` | The editor UI: one `state` object, `render*()` functions and the `h()` DOM helper. |
| `app/art.js` | The pictures of the amp and the effect pedals, drawn as SVG in code. |
| `selftest.html`, `app/selftest.js` | Live self-test against a real amp. It snapshots the amp, runs the checks, restores everything and verifies. |
| `src/protocol/codec.js` | MessagePack subset (`Reader`, `Writer`). |
| `src/protocol/framing.js` | Chunks, 7-bit packing, block headers, multi-part messages (`Reassembler`, `ChunkSplitter`). |
| `src/protocol/crc.js`, `half.js` | CRC-32/MPEG-2 and the altered CRC-32 of the difference records; half-precision floats. |
| `src/protocol/preset.js` | Preset and amp data, and the base + difference messages that write an amp bank (`buildAmpBatch`). |
| `src/protocol/messages.js` | Request builders (`Requests`) and event parsing (`parseEvent`). |
| `src/protocol/models.js`, `display.js` | Effect models, block codes, the Amp-selector amps; how values are shown. |
| `src/protocol/client.js` | `ReactorClient`: sequence numbers, request/reply matching, uploads, saves, the safety guards. |
| `src/transport/web-bluetooth.js` | The browser transport. Any object with `write(bytes)` and `onData` works. |
| `src/preset-file.js` | The `.knobwork.json` preset file format (export and import). |
| `test/` | Unit tests (`node:test`). `test/mock-amp.js` simulates the amp; `test/fixtures/` holds made-up presets and amp data, and captured traffic without them. |
| `scripts/serve.js` | Local development server. |
| `.github/workflows/pages.yml` | Publishes the site to https://dgkanatsios.github.io/knobwork/ on every push to `main`, after the tests pass. It publishes only `index.html`, `app/` and `src/`; the self-test page stays off the public site. |

## Commands

- `npm test` runs every unit test (Node 20 or later, under a second). It must pass before every commit.
- `npm start` serves the app at http://localhost:8080. Web Bluetooth only works on `localhost` or `https`.
- There is no linter or formatter; follow the existing style.
- Do not add dependencies: no npm packages, CDNs, frameworks or bundlers. Ask the maintainer first if you think one is
  needed.

## Safety rules for the amp (never break these)

The code talks to a real amplifier that people rely on. A wrong write can overwrite someone's presets or brick the amp.

- **Send only what the library builds.** `ReactorClient` checks every request before sending it (`checked()` in
  `client.js`): it sends reads (`02`) and the changes listed in `SET_SUBS` (`messages.js`), and refuses anything else.
  Do not remove or weaken that check, the upload check (`checkUpload()`), or the range checks in `Requests` and
  `ReactorClient`.
- **Add a request only after it was verified on the amp,** and never one that can wipe or reset the amp, update its
  firmware, or change its name, identity or network settings.
- **Never write the built-in amp banks `00`–`05`.** The only banks written are a slot's bank (`10`–`17`) and the working
  bank (`7F`), as the official app does.
- **Only well-formed data is uploaded.** Every preset and amp blob must pass its checksum. A difference record can only
  change parameter values: `buildAmpBatch` rebuilds every variant to check this. Keep that check.
- **One chunk per write,** and wait for each part's ack before sending the next part.
- **Saves are backed up and read back.** `saveCurrent()` verifies the slot after writing it, and the app keeps a backup
  for Undo. Keep both.
- Parameter values on the wire are always 0–1. `ReactorAmp` parameter 0 is written as variant ÷ 14 and read back as
  the variant.

## Protocol facts that are easy to get wrong

Each of these is documented in docs/protocol.md.

- Slots are `0`–`7` in code and are shown as 1–8. The temporary slot and the working bank are both `7F` (`TEMP_SLOT`,
  `TEMP_BANK`).
- Banks: `00`–`05` are the Amp-selector amps, `10`–`17` the slots' amps, `7D` the live amp and `7F` the working copy.
- `7D`/1–14 are not a mirror of `7F`: do not infer the working bank from them (§12, item 8). Find a custom amp's
  variants by model instead (`customAmpBank`).
- After `01 B1` (picking an amp), reads of bank `7F` get no reply until a preset is selected again.
- The amp's edited flag (`02 1A`) lags behind preset changes, and panel knobs do not always send `03 1A`. The app
  therefore decides "edited" by comparing the current preset with the stored slot.
- Sequence numbers: client requests use `01`–`3F`; anything above `3F` is an event from the amp.
- `selectPreset()` waits 500 ms for the amp to switch. `setAmpVariant()` waits 250 ms before resending the knob values,
  because sooner they can be overwritten.

## Changing the protocol spec

- Only write what was observed on the amp or in its traffic with the official app, with counts where they matter
  (e.g. "2 of 300 reads").
  Label inferences as inferences. Never state a guess as a fact.
- Keep the status words used in the tables: **verified**, **app**, **no reply**.
- Only document requests that were seen in the official app's traffic or checked on the amp, and never one that can
  wipe or reset the amp, update its firmware, or change its name, identity or network settings (§4.9).
- If the code or the mock amp disagree with the spec, the spec wins, unless you have new evidence. In that case update
  the spec with the evidence.
- Do not make up protocol behaviour to make a test pass.

## Tests

- Add focused unit tests for every behaviour you fix or add (`test/*.test.js`, `node:test` with `node:assert/strict`).
  A new test should fail without your change.
- Client tests run against `test/mock-amp.js`, which follows the spec. When the spec changes, update the mock.
- There is no amp in CI. If your change affects what is sent to the amp, say so in the pull request. The maintainer then
  runs `selftest.html` against a real amp. Never add hardware tests that write anything other than data identical to
  what is stored, or changes that the test itself puts back.

## App code

- `index.html` sets a strict Content-Security-Policy. Do not use inline scripts or styles, `innerHTML` or `eval`.
  Build the DOM with `h()`, which treats all text as text.
- Library code (`src/`) must not touch the DOM. The app must not build protocol bytes itself: use `Requests` and
  `ReactorClient`.
- User actions are ignored while `state.busy` is set; follow that pattern for new actions that talk to the amp.
- Keep the UI accessible: labels, `aria-*` on custom controls, and keyboard access.

## Privacy, trademarks and copyright

- **Never commit personal data from the amp:** its serial number (`02 23` reply), Wi-Fi network names (`02 44` reply),
  or anything identifying its owner.
- **Knobwork is unofficial.** Do not use "REACTOR" or "Positive Grid" in product names, branding, repository or package
  names. Use them only to say which amp this works with. Keep the disclaimer in README.md and on the welcome screen.
- **In the UI, show the official app's model names** (e.g. "Black Dist"), never the names of the real pedals and amps
  they imitate. Those appear only as protocol identifiers.
- **Do not add material owned by Positive Grid:** logos, fonts, images, screenshots, text from the official app or its
  manuals, or third-party guides about it. Do not add data read from an amp either: presets, amp data, or captures
  that contain them. Tests use made-up data (`test/fixtures/make-fixtures.js`).
- **Pictures of gear are drawn in code** (`app/art.js`): generic pedals coloured by category and a generic amp coloured
  by Amp-selector position, with no text or logos. Never make one look like a real product (its colours, shape,
  graphics or lettering), and do not add photos, image files or AI-generated images of gear. The one image file,
  `app/preview.png` (link previews and the README), is a screenshot of Knobwork showing made-up presets.
- **Do not copy code or text from other projects** (for example other REACTOR or Spark tools) unless their license allows
  it and the maintainer agrees.

## Style

- **Code:**
  - ES modules, 2-space indentation, single quotes, semicolons, lines up to about 120 characters;
  - comments only where the code needs explaining, usually *why* (an amp quirk), citing the spec section.
- **Documentation:**
  - plain, short sentences, with tables for structured facts and hex values in backticks;
  - when behaviour changes, update README.md and docs/protocol.md in the same change.
- **Commits:** small and focused, with a message that says what changed and why.
