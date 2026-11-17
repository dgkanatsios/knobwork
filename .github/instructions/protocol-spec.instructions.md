---
applyTo: "docs/protocol.md"
---

# Writing the protocol spec

- **Evidence only.** Record what was observed on the amp or in its traffic with the official app.
  - Give counts where they matter ("2 of 300 reads", "0 of 22").
  - Say how it was seen: a capture, a direct request, or the amp's controls.
  - Label inferences as inferences and open questions as open.
- **Status words:** keep the table status column to **verified**, **app** and **no reply** (defined at the top of the
  file).
- **What not to publish:** requests that were neither seen in the official app's traffic nor checked on the amp, and
  requests that can wipe or reset the amp, update its firmware, or change its name, identity or network settings
  (section 4.9).
- **Superseded facts:** when new evidence contradicts the text, replace the text. Mention the old result only if it is
  still useful, e.g. "an earlier run whose log was not kept saw …".
- **Hex and names.** Write hex in backticks, e.g. `01 38 [0, 7F]`. Slots are `0`–`7` here; banks are hex.
- **Privacy.** Never include an amp's serial number, Wi-Fi network names or other personal data. Write `<serial>` /
  `<ssid>` instead.
- **Trademarks.** Name models by the official app's nicknames and their protocol identifiers only. Never name the real
  gear they imitate.
- **Keep the code in step.** When behaviour described here changes, update the library, `test/mock-amp.js` and their
  tests in the same change.
- **Style.** Use short, plain sentences, keep tables as tables, and wrap lines at about 120 characters.
