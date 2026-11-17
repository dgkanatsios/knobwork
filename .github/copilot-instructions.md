# Copilot instructions

The main instructions for this repository are in [AGENTS.md](../AGENTS.md); read them before working here. The rules
that matter most:

- **Safety.** This code drives a real amplifier.
  - Send only the requests `Requests` builds; `ReactorClient` refuses anything else. Add a request only after it
    was verified on the amp, and never one that can wipe or reset the amp, update its firmware, or change its name,
    identity or network settings.
  - Never write the built-in amp banks `00`–`05`.
  - Never weaken the guards in `src/protocol/client.js` and `src/protocol/messages.js`.
- **The spec is the source of truth.** [docs/protocol.md](../docs/protocol.md) records only observed behaviour, with
  its evidence and status words. Do not invent protocol behaviour.
- **No dependencies and no build step.** The project is plain HTML and ES modules. `npm test` must pass.
- **Privacy and trademarks.**
  - Never commit an amp's serial number or Wi-Fi names.
  - Never use "REACTOR" or "Positive Grid" as branding.
  - Show only the official app's model nicknames.
  - Never add Positive Grid assets, or code copied from other projects.
