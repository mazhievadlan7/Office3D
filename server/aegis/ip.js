// Strict IP address and CIDR handling for scope matching.
//
// Correctness here IS the security boundary: a lax parser that accepts an
// ambiguous form (octal octets, a stray zone id, a mixed-version compare) is a
// scope bypass. Every function is deny-by-default: anything it cannot parse
// unambiguously returns null, and the caller treats null as "not in scope".
//
// IPv4 is held as an unsigned 32-bit number; IPv6 as a BigInt (128 bits).

const net = require("node:net");

/**
 * Parse a strict dotted-quad IPv4 into a 32-bit unsigned number, or null.
 * Rejects leading zeros (which some resolvers read as octal), out-of-range
 * octets, and anything that is not exactly four decimal octets.
 * @param {string} value
 * @returns {number|null}
 */
const parseIpv4 = (value) => {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null; // no octal ambiguity
    const octet = Number(part);
    if (octet > 255) return null;
    num = num * 256 + octet;
  }
  return num >>> 0;
};

/**
 * Parse an IPv6 literal into a 128-bit BigInt, or null. Validity is confirmed
 * by net.isIP first (defense in depth), then expanded here to a number.
 * Zone ids (%eth0) are refused — they are host-local and meaningless for scope.
 * @param {string} value
 * @returns {bigint|null}
 */
const parseIpv6 = (value) => {
  if (typeof value !== "string") return null;
  if (value.includes("%")) return null;
  if (net.isIP(value) !== 6) return null;

  const groupsFrom = (segment) => {
    if (segment === "") return [];
    const out = [];
    for (const piece of segment.split(":")) {
      if (piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  };

  const halves = value.split("::");
  if (halves.length > 2) return null;

  let groups;
  if (halves.length === 2) {
    const head = groupsFrom(halves[0]);
    const tail = groupsFrom(halves[1]);
    if (head === null || tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null; // "::" must stand for at least one zero group
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = groupsFrom(value);
    if (groups === null) return null;
  }
  if (groups.length !== 8) return null;

  let num = 0n;
  for (const group of groups) num = (num << 16n) + BigInt(group);
  return num;
};

// The top 96 bits of an IPv4-mapped IPv6 address (::ffff:a.b.c.d).
const V4_MAPPED_TAG = 0xffffn;

/**
 * Parse any IP literal to a canonical { version, value } pair, or null.
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalized to plain IPv4 so that a
 * target cannot dodge an IPv4 scope by wearing an IPv6 coat.
 * @param {string} value
 * @returns {{version: 4|6, value: bigint}|null}
 */
const parseIp = (value) => {
  const v4 = parseIpv4(value);
  if (v4 !== null) return { version: 4, value: BigInt(v4) };
  const v6 = parseIpv6(value);
  if (v6 === null) return null;
  if (v6 >> 32n === V4_MAPPED_TAG) return { version: 4, value: v6 & 0xffffffffn };
  return { version: 6, value: v6 };
};

const isIp = (value) => parseIp(value) !== null;

const maskValue = (value, totalBits, prefix) => {
  const shift = BigInt(totalBits - prefix);
  return shift === 0n ? value : (value >> shift) << shift;
};

/**
 * Parse "addr/prefix" into a canonical CIDR, or null. The base is masked to the
 * prefix so host bits in the input cannot smuggle in a wider or narrower range
 * than declared.
 * @param {string} value
 * @returns {{version: 4|6, base: bigint, prefix: number, bits: number}|null}
 */
const parseCidr = (value) => {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash === -1) return null;
  const prefixPart = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const ip = parseIp(value.slice(0, slash));
  if (!ip) return null;
  const bits = ip.version === 4 ? 32 : 128;
  const prefix = Number(prefixPart);
  if (prefix > bits) return null;
  return { version: ip.version, base: maskValue(ip.value, bits, prefix), prefix, bits };
};

/**
 * Whether a parsed IP falls inside a parsed CIDR. A version mismatch is never a
 * match (an IPv6 target is not "inside" an IPv4 range).
 * @param {{version: 4|6, value: bigint}} ip
 * @param {{version: 4|6, base: bigint, prefix: number, bits: number}} cidr
 * @returns {boolean}
 */
const ipInCidr = (ip, cidr) => {
  if (!ip || !cidr || ip.version !== cidr.version) return false;
  return maskValue(ip.value, cidr.bits, cidr.prefix) === cidr.base;
};

module.exports = { parseIpv4, parseIpv6, parseIp, isIp, parseCidr, ipInCidr, maskValue };
