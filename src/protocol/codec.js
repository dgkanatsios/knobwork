// The MessagePack subset REACTOR payloads use (docs/protocol.md, section 3).
// Payloads are flat sequences of values: an "array" header counts structs, and each struct is just its fields in order,
// so parsing is always schema-driven (Reader has one method per type instead of a generic decoder).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Writer {
  constructor() {
    this.buf = new Uint8Array(256);
    this.length = 0;
  }

  ensure(n) {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  byte(b) {
    this.ensure(1);
    this.buf[this.length++] = b & 0xff;
    return this;
  }

  bytes(data) {
    this.ensure(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
    return this;
  }

  u16(n) {
    return this.byte(n >>> 8).byte(n);
  }

  u32(n) {
    return this.byte(n >>> 24).byte(n >>> 16).byte(n >>> 8).byte(n);
  }

  uint(n) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`not an unsigned integer: ${n}`);
    if (n <= 0x7f) return this.byte(n);
    if (n <= 0xff) return this.byte(0xcc).byte(n);
    if (n <= 0xffff) return this.byte(0xcd).u16(n);
    if (n <= 0xffffffff) return this.byte(0xce).u32(n);
    throw new RangeError(`integer too large: ${n}`);
  }

  int(n) {
    if (!Number.isInteger(n)) throw new RangeError(`not an integer: ${n}`);
    if (n >= 0) return this.uint(n);
    if (n >= -32) return this.byte(n);
    if (n >= -128) return this.byte(0xd0).byte(n);
    if (n >= -32768) return this.byte(0xd1).u16(n & 0xffff);
    if (n >= -2147483648) return this.byte(0xd2).u32(n >>> 0);
    throw new RangeError(`integer too small: ${n}`);
  }

  float(f) {
    const tmp = new DataView(new ArrayBuffer(4));
    tmp.setFloat32(0, f);
    return this.byte(0xca).bytes(new Uint8Array(tmp.buffer));
  }

  bool(b) {
    return this.byte(b ? 0xc3 : 0xc2);
  }

  str(s) {
    const data = encoder.encode(s);
    const n = data.length;
    if (n < 32) this.byte(0xa0 | n);
    else if (n <= 0xff) this.byte(0xd9).byte(n);
    else if (n <= 0xffff) this.byte(0xda).u16(n);
    else this.byte(0xdb).u32(n);
    return this.bytes(data);
  }

  // Effect ids and names are sent as their byte length (an int) followed by the string itself.
  pstr(s) {
    this.uint(encoder.encode(s).length);
    return this.str(s);
  }

  array(n) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`not an unsigned integer: ${n}`);
    if (n < 16) return this.byte(0x90 | n);
    if (n <= 0xffff) return this.byte(0xdc).u16(n);
    if (n <= 0xffffffff) return this.byte(0xdd).u32(n);
    throw new RangeError(`array too long: ${n}`);
  }

  bin(data) {
    const n = data.length;
    if (n <= 0xff) this.byte(0xc4).byte(n);
    else if (n <= 0xffff) this.byte(0xc5).u16(n);
    else this.byte(0xc6).u32(n);
    return this.bytes(data);
  }

  finish() {
    return this.buf.slice(0, this.length);
  }
}

export class DecodeError extends Error {}

export class Reader {
  constructor(bytes, offset = 0) {
    this.b = bytes;
    this.i = offset;
  }

  get remaining() {
    return this.b.length - this.i;
  }

  peek() {
    if (this.i >= this.b.length) throw new DecodeError(`unexpected end of data at ${this.i}`);
    return this.b[this.i];
  }

  u8() {
    const v = this.peek();
    this.i++;
    return v;
  }

  u16() {
    return (this.u8() << 8) | this.u8();
  }

  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }

  take(n) {
    if (this.i + n > this.b.length) throw new DecodeError(`need ${n} bytes at ${this.i}, have ${this.remaining}`);
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }

  fail(what) {
    return new DecodeError(`expected ${what} at ${this.i}, found 0x${this.peek().toString(16).padStart(2, '0')}`);
  }

  isInt() {
    const t = this.peek();
    return t <= 0x7f || t >= 0xe0 || (t >= 0xcc && t <= 0xcf) || (t >= 0xd0 && t <= 0xd3);
  }

  int() {
    const t = this.peek();
    if (t <= 0x7f) return this.u8();
    if (t >= 0xe0) return this.u8() - 0x100;
    if (!this.isInt()) throw this.fail('int');
    this.i++;
    switch (t) {
      case 0xcc: return this.u8();
      case 0xcd: return this.u16();
      case 0xce: return this.u32();
      case 0xcf: {
        const hi = this.u32();
        return hi * 2 ** 32 + this.u32();
      }
      case 0xd0: return (this.u8() << 24) >> 24;
      case 0xd1: return (this.u16() << 16) >> 16;
      case 0xd2: return this.u32() | 0;
      default: {
        const hi = this.u32() | 0;
        return hi * 2 ** 32 + this.u32();
      }
    }
  }

  float() {
    const t = this.peek();
    if (t === 0xca) {
      this.i++;
      const d = this.take(4);
      return new DataView(d.buffer, d.byteOffset, 4).getFloat32(0);
    }
    if (t === 0xcb) {
      this.i++;
      const d = this.take(8);
      return new DataView(d.buffer, d.byteOffset, 8).getFloat64(0);
    }
    throw this.fail('float');
  }

  // A number sent either as a float or as an int.
  number() {
    const t = this.peek();
    return t === 0xca || t === 0xcb ? this.float() : this.int();
  }

  bool() {
    const t = this.u8();
    if (t === 0xc3) return true;
    if (t === 0xc2) return false;
    this.i--;
    throw this.fail('bool');
  }

  str() {
    const t = this.u8();
    let n;
    if ((t & 0xe0) === 0xa0) n = t & 0x1f;
    else if (t === 0xd9) n = this.u8();
    else if (t === 0xda) n = this.u16();
    else if (t === 0xdb) n = this.u32();
    else {
      this.i--;
      throw this.fail('string');
    }
    return decoder.decode(this.take(n));
  }

  // The prefix is not checked against the string: the string carries its own length, and the prefix was only ever
  // seen for ASCII strings, so a name with other characters must not make a reply unreadable.
  pstr() {
    this.int();
    return this.str();
  }

  array() {
    const t = this.u8();
    if ((t & 0xf0) === 0x90) return t & 0x0f;
    if (t === 0xdc) return this.u16();
    if (t === 0xdd) return this.u32();
    this.i--;
    throw this.fail('array');
  }

  bin() {
    const t = this.u8();
    let n;
    if (t === 0xc4) n = this.u8();
    else if (t === 0xc5) n = this.u16();
    else if (t === 0xc6) n = this.u32();
    else {
      this.i--;
      throw this.fail('binary');
    }
    return this.take(n).slice();
  }
}
