import { describe, expect, it } from "vitest";

const { parseIpv4, parseIp, parseIpv6, parseCidr, ipInCidr } = await import("../../server/aegis/ip.js");

describe("AEGIS ip", () => {
  it("parses strict IPv4 and rejects ambiguous forms", () => {
    expect(parseIpv4("192.168.1.1")).toBe(0xc0a80101);
    expect(parseIpv4("0.0.0.0")).toBe(0);
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
    // ambiguous / invalid → null (deny)
    expect(parseIpv4("192.168.001.1")).toBeNull(); // leading zero (octal trap)
    expect(parseIpv4("256.1.1.1")).toBeNull();
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("0x7f.0.0.1")).toBeNull();
    expect(parseIpv4(" 1.2.3.4")).toBeNull();
  });

  it("normalizes IPv4-mapped IPv6 to plain IPv4 so it cannot dodge an IPv4 scope", () => {
    const mapped = parseIp("::ffff:1.2.3.4");
    const plain = parseIp("1.2.3.4");
    expect(mapped).toEqual(plain);
    expect(mapped?.version).toBe(4);
  });

  it("rejects IPv6 with a zone id", () => {
    expect(parseIpv6("fe80::1%eth0")).toBeNull();
    expect(parseIp("fe80::1%eth0")).toBeNull();
  });

  it("matches CIDR membership and refuses cross-version and out-of-range", () => {
    const v4net = parseCidr("10.0.0.0/8");
    expect(ipInCidr(parseIp("10.1.2.3")!, v4net!)).toBe(true);
    expect(ipInCidr(parseIp("11.0.0.1")!, v4net!)).toBe(false);
    // an IPv6 target is never "inside" an IPv4 range
    expect(ipInCidr(parseIp("::1")!, v4net!)).toBe(false);

    const v6net = parseCidr("2001:db8::/32");
    expect(ipInCidr(parseIp("2001:db8::1")!, v6net!)).toBe(true);
    expect(ipInCidr(parseIp("2001:dead::1")!, v6net!)).toBe(false);
  });

  it("masks host bits and rejects an over-long prefix", () => {
    expect(parseCidr("10.1.2.3/8")?.base).toBe(parseCidr("10.0.0.0/8")?.base);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(parseCidr("not-a-cidr")).toBeNull();
    expect(parseCidr("10.0.0.0")).toBeNull();
  });
});
