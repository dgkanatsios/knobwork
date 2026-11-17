// IEEE-754 half precision, as used for preset and amp parameters (docs/protocol.md, section 3).
// Ties are rounded away from zero, which gives the same half values the amp stores; round-half-even does not.

export function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

// Rounds a non-negative number to the nearest integer, ties away from zero. Math.floor(x + 0.5) is not exact: the
// addition itself can round a value just below a midpoint up to it.
function roundHalfUp(x) {
  const n = Math.floor(x);
  return x - n >= 0.5 ? n + 1 : n;
}

export function floatToHalf(value) {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const a = Math.abs(value);
  if (a === 0) return sign;
  if (a >= 65520) return sign | 0x7c00;
  let e = Math.floor(Math.log2(a));
  if (a / 2 ** e >= 2) e++;
  if (a / 2 ** e < 1) e--;
  if (e < -14) return sign | roundHalfUp(a / 2 ** -24);
  let m = roundHalfUp(a / 2 ** (e - 10));
  if (m === 2048) {
    m = 1024;
    e++;
  }
  if (e > 15) return sign | 0x7c00;
  return sign | ((e + 15) << 10) | (m - 1024);
}
