---
applyTo: "app/**,index.html,selftest.html"
---

# App code (`app/`, `index.html`, `selftest.html`)

- **Content-Security-Policy.** The CSP allows only same-origin scripts and styles. Do not use inline `<script>` or
  `style` attributes, inline event handlers, `innerHTML` or `eval`. Build the DOM with the `h()` helper, which inserts
  text as text.
- **Structure.** All state lives in the `state` object, and the UI is redrawn by the `render*()` functions. Actions that
  talk to the amp run inside `run(label, action)`. They return early while `state.busy` is set.
- **Protocol access.** Never build protocol bytes in the app: use `Requests` and `ReactorClient` from `src/protocol/`.
- **Edited state.** "Edited" is derived with `updateEdited()`, which compares the current preset with the stored slot
  (`state.stored`). Do not go back to trusting the amp's flag: `02 1A` lags behind preset changes, and panel knobs do not
  always send `03 1A`.
- **Unsaved changes.** Before discarding them (switching presets, importing a file), ask with `confirm()`.
- **Slot numbers.** Slots are `0`–`7` in code and are shown as 1–8.
- **Branding.** Keep the "not affiliated with Positive Grid" notice on the welcome screen. Never use Positive Grid
  logos, fonts or images.
- **Pictures (`app/art.js`).** Draw them as SVG with `createElementNS` and presentation attributes (`fill`, `stroke`,
  `transform`), never `style` attributes, and mark them `aria-hidden`. A part that shows a parameter carries
  `data-art-param` and a `setValue` method; `updateArt()` calls it when the value changes. Keep them generic (see
  AGENTS.md).
- **Accessibility.** Give custom controls labels and `aria-*` attributes (`aria-pressed`, `aria-current`,
  `aria-live`), and make them reachable by keyboard.
- **The self-test (`app/selftest.js`)** may only write data identical to what is stored, or changes it puts back
  itself. It must restore everything and compare against its first snapshot.
