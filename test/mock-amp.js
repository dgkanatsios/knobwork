// A simulated REACTOR for client tests: answers reads, acks writes, stores uploads, and records every write.
// It follows docs/protocol.md; the other tests check the byte formats it relies on.

import { Reader, Writer } from '../src/protocol/codec.js';
import { ChunkSplitter, Reassembler, chunk, parseChunk, splitParts } from '../src/protocol/framing.js';
import { applyAmpRecord, parseAmpBatch, withHeader } from '../src/protocol/preset.js';
import { bank17, presetFixture } from './helpers.js';

const AMP_PART = 350;

export class MockAmp {
  constructor() {
    this.presets = Array.from({ length: 8 }, (_, s) => presetFixture(s));
    const b17 = bank17();
    this.banks = new Map([
      [0x05, b17.map((v, i) => withHeader(v, 0x05, i))],
      [0x17, b17],
      [0x7f, b17.map((v, i) => withHeader(v, 0x7f, i))],
      [0x7d, [...b17.map((v, i) => withHeader(i === 0 ? b17[7] : v, 0x7d, i)), withHeader(b17[7], 0x7d, 15)]],
    ]);
    this.temp = null;
    this.editBuffer = null; // the current preset when it differs from the stored one
    this.current = { type: 0, slot: 7 };
    this.eventSeq = 0x40;
    this.writes = [];
    this.params = [];
    this.silent = new Set();
    this.splitter = new ChunkSplitter((b) => {
      throw new Error(`stray byte ${b}`);
    });
    this.uploads = new Reassembler();
    this.transport = { onData: () => {}, write: async (bytes) => this.receive(bytes) };
  }

  notify(bytes) {
    setImmediate(() => this.transport.onData(bytes));
  }

  reply(seq, cmd, sub, payload = new Uint8Array(0), sliced = false) {
    if (!sliced) return this.notify(chunk(seq, cmd, sub, payload));
    for (const part of splitParts(payload, AMP_PART)) this.notify(chunk(seq, cmd, sub, part));
  }

  event(sub, payload) {
    const seq = this.eventSeq;
    this.eventSeq = seq === 0x7f ? 0x40 : seq + 1;
    this.reply(seq, 3, sub, payload);
  }

  receive(bytes) {
    this.writes.push(bytes.slice());
    for (const raw of this.splitter.push(bytes)) this.handle(parseChunk(raw));
  }

  handle(c) {
    const key = `${c.cmd.toString(16).padStart(2, '0')} ${c.sub.toString(16).padStart(2, '0')}`;
    if (this.silent.has(key)) return;
    const p = c.payload;
    const r = new Reader(p);
    switch (key) {
      case '02 2f':
        return this.reply(c.seq, 3, c.sub, new Writer().uint(0x0002056c).finish());
      case '02 11':
        return this.reply(c.seq, 3, c.sub, new Writer().pstr('Reactor 50 BT Control').finish());
      case '02 10':
        return this.reply(c.seq, 3, c.sub, new Writer().int(this.current.type).int(this.current.slot).finish());
      case '02 01': {
        const [type, slot] = p;
        let blob;
        if (type === 1) blob = withHeader(this.currentBlob(), 0x01, 0x00);
        else if (slot < 8) blob = this.presets[slot];
        if (blob) this.reply(c.seq, 3, c.sub, blob, true);
        return;
      }
      case '02 a7': {
        const blob = this.banks.get(p[0])?.[p[1]];
        if (blob) this.reply(c.seq, 3, c.sub, blob, true);
        return;
      }
      case '01 01':
      case '01 a7': {
        this.reply(c.seq, 4, c.sub);
        const done = this.uploads.push({ ...c, cmd: 3 });
        if (done) this.store(c.sub, done.payload);
        return;
      }
      case '01 38':
        r.int();
        this.current = { type: 0, slot: r.int() };
        this.editBuffer = null;
        this.reply(c.seq, 4, c.sub);
        return;
      case '01 04':
        this.params.push([r.pstr(), r.int(), r.float()]);
        return;
      default:
        if (c.cmd === 1) this.reply(c.seq, 4, c.sub);
    }
  }

  currentBlob() {
    return this.editBuffer ?? (this.current.slot === 0x7f ? this.temp : this.presets[this.current.slot]);
  }

  store(sub, payload) {
    if (sub === 0x01) {
      if (payload[1] === 0x7f) this.temp = payload;
      else this.presets[payload[1]] = payload;
      return;
    }
    if (payload[0] === 0x03) {
      const batch = parseAmpBatch(payload);
      const bank = this.banks.get(batch.bank);
      for (const rec of batch.records) bank[rec.variant] = applyAmpRecord(bank[0], rec);
      return;
    }
    const bank = this.banks.get(payload[0]) ?? [];
    bank[0] = payload;
    this.banks.set(payload[0], bank);
  }
}
