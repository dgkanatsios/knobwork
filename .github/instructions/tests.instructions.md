---
applyTo: "test/**"
---

# Tests (`test/`)

- **Runner.** Tests use Node's built-in runner: `node:test` with `node:assert/strict`. Run them with `npm test`. Do not
  add test frameworks.
- **What to test.** Write focused tests for behaviour that a change introduces or fixes. A new test should fail without
  the change. Do not test constants, re-exports or language behaviour.
- **The mock amp.** `test/mock-amp.js` simulates the amp from docs/protocol.md. When the spec changes, change the mock;
  never bend it to make a test pass.
- **Fixtures.** `test/fixtures/` holds made-up presets and amp data written by `test/fixtures/make-fixtures.js`, and
  traffic captured between the official app and the amp with the preset and amp data left out.
  - The made-up files are frozen: tests compare the library with their bytes. Regenerate them only when the format
    changes, and say why in the commit.
  - Never add data read from an amp (presets, amp data, or captures that contain them), serial numbers or Wi-Fi names.
    Build test data with the library instead (`serializePreset`, `serializeAmp`).
- **Timing.** Keep tests fast (the suite runs in under a second) and independent of real time; the client accepts short
  timeouts and zero settle delays for tests.
