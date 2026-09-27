import { describe, expect, it } from "vitest";

// The AEGIS legal core is CommonJS under server/aegis (it runs in the Node
// server, not the browser). Vitest imports it directly so the security kernel
// is covered by the same suite as everything else.
import { ipInCidr, parseCidr, parseIp, parseIpv4, parseIpv6 } from "../../server/aegis/ip.js";
import { matchTarget, normalizeDomain, parseTarget, validateAsset } from "../../server/aegis/scope.js";

// The kernel is JSDoc-typed JS; these narrow the `object` returns for the test.
type AegisAsset = { kind: string; value: string; pathPrefix?: string; ports?: number[] | null };
const asset = (input: object): AegisAsset => validateAsset(input) as AegisAsset;

describe("AEGIS ip parsing (the boundary is correctness)", () => {
  it("rejects octal-ambiguous, out-of-range and malformed IPv4", () => {
    expect(parseIpv4("192.168.1.1")).not.toBeNull();
    expect(parseIpv4("192.168.01.1")).toBeNull(); // leading zero = octal ambiguity
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("1.2.3.-4")).toBeNull();
  });

  it("expands IPv6, rejects zone ids, and normalizes IPv4-mapped IPv6 to IPv4", () => {
    expect(parseIpv6("2001:db8::1")).not.toBeNull();
    expect(parseIpv6("fe80::1%eth0")).toBeNull(); // host-local zone id is meaningless for scope
    const mapped = parseIp("::ffff:192.168.1.1");
    expect(mapped?.version).toBe(4); // cannot dodge an IPv4 scope by wearing an IPv6 coat
    expect(mapped?.value).toBe(parseIp("192.168.1.1")?.value);
  });

  it("masks CIDR host bits and refuses an over-long prefix", () => {
    expect(parseCidr("10.0.0.5/8")?.base).toBe(parseCidr("10.0.0.0/8")?.base);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0")).toBeNull();
  });

  it("never matches across IP versions", () => {
    const v4 = parseIp("10.1.2.3")!;
    const cidr = parseCidr("10.0.0.0/8")!;
    expect(ipInCidr(v4, cidr)).toBe(true);
    expect(ipInCidr(parseIp("11.0.0.1")!, cidr)).toBe(false);
    expect(ipInCidr(parseIp("::1")!, cidr)).toBe(false); // v6 target is not "inside" a v4 range
  });
});

describe("AEGIS domain normalization", () => {
  it("lowercases, strips the trailing dot, and refuses non-hostnames", () => {
    expect(normalizeDomain("Example.COM.")).toBe("example.com");
    expect(normalizeDomain("1.2.3.4")).toBeNull(); // an IP is not a domain
    expect(normalizeDomain("a..b")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });
});

describe("AEGIS asset validation", () => {
  it("accepts the four kinds and rejects a reckless-wide CIDR", () => {
    expect(asset({ kind: "domain", value: "Example.com" }).value).toBe("example.com");
    expect(asset({ kind: "ip", value: "192.168.1.1" }).kind).toBe("ip");
    expect(asset({ kind: "cidr", value: "10.0.0.0/8" }).kind).toBe("cidr");
    expect(asset({ kind: "url", value: "https://x.com/admin" }).pathPrefix).toBe("/admin");
    expect(() => validateAsset({ kind: "cidr", value: "10.0.0.0/4" })).toThrow(); // half the internet
    expect(() => validateAsset({ kind: "nope", value: "x" })).toThrow();
    expect(() => validateAsset({ kind: "ip", value: "999.1.1.1" })).toThrow();
  });
});

describe("AEGIS target parsing", () => {
  it("reads urls, host:port and [v6]:port, and infers a scheme's default port", () => {
    expect(parseTarget("https://x.com/a")).toMatchObject({ host: "x.com", port: 443, path: "/a" });
    expect(parseTarget("x.com:8080")).toMatchObject({ host: "x.com", port: 8080 });
    expect(parseTarget("[2001:db8::1]:443")?.ip?.version).toBe(6);
    expect(parseTarget("not a host")).toBeNull();
    expect(parseTarget("")).toBeNull();
  });
});

describe("AEGIS scope matching is default-deny (the critical negative tests)", () => {
  const match = (assetInputs: object[], target: string | object) =>
    matchTarget(assetInputs.map((a) => validateAsset(a)), target);

  it("allows an exact domain and denies look-alikes and unrelated hosts", () => {
    const assets = [{ kind: "domain", value: "example.com" }];
    expect(match(assets, "example.com").allowed).toBe(true);
    expect(match(assets, "sub.example.com").allowed).toBe(false); // no subdomains unless asked
    expect(match(assets, "evil.com").allowed).toBe(false);
    expect(match(assets, "notexample.com").allowed).toBe(false);
    expect(match(assets, "example.com.evil.com").allowed).toBe(false); // suffix look-alike
  });

  it("honors includeSubdomains without leaking to a suffix look-alike", () => {
    const assets = [{ kind: "domain", value: "example.com", includeSubdomains: true }];
    expect(match(assets, "a.example.com").allowed).toBe(true);
    expect(match(assets, "deep.a.example.com").allowed).toBe(true);
    expect(match(assets, "example.com.evil.com").allowed).toBe(false);
    expect(match(assets, "notexample.com").allowed).toBe(false);
  });

  it("keeps domains and IPs in separate lanes", () => {
    expect(match([{ kind: "domain", value: "example.com" }], "10.0.0.1").allowed).toBe(false);
    expect(match([{ kind: "ip", value: "10.0.0.1" }], "example.com").allowed).toBe(false);
  });

  it("matches an IP only inside its CIDR and never across versions", () => {
    const assets = [{ kind: "cidr", value: "10.0.0.0/24" }];
    expect(match(assets, "10.0.0.5").allowed).toBe(true);
    expect(match(assets, "10.0.1.5").allowed).toBe(false);
    expect(match(assets, "::1").allowed).toBe(false);
  });

  it("keeps url path authorization at a segment boundary", () => {
    const assets = [{ kind: "url", value: "https://x.com/admin" }];
    expect(match(assets, "https://x.com/admin").allowed).toBe(true);
    expect(match(assets, "https://x.com/admin/users").allowed).toBe(true);
    expect(match(assets, "https://x.com/administrator").allowed).toBe(false); // distinct resource
    expect(match(assets, "https://x.com/admin-secret").allowed).toBe(false);
    expect(match(assets, "https://x.com/").allowed).toBe(false);
  });

  it("enforces a port restriction, including the unspecified-port target", () => {
    const assets = [{ kind: "domain", value: "example.com", ports: [443] }];
    expect(match(assets, "example.com:443").allowed).toBe(true);
    expect(match(assets, "example.com:80").allowed).toBe(false);
    expect(match(assets, "example.com").allowed).toBe(false); // cannot prove the port is in scope
  });

  it("restricts to an explicit non-default url port and infers a scheme default", () => {
    const url8443 = [{ kind: "url", value: "https://x.com:8443/" }];
    expect(match(url8443, "https://x.com:8443").allowed).toBe(true);
    expect(match(url8443, "https://x.com").allowed).toBe(false); // default 443 is not 8443
    expect(match(url8443, "http://x.com").allowed).toBe(false);

    // A port-restricted domain asset denies a target whose port is only implied
    // by its scheme unless that inferred port is the authorized one.
    const port443 = [{ kind: "domain", value: "x.com", ports: [443] }];
    expect(match(port443, "https://x.com").allowed).toBe(true); // 443 inferred
    expect(match(port443, "http://x.com").allowed).toBe(false); // 80 inferred
  });

  it("denies an unparseable target", () => {
    expect(match([{ kind: "domain", value: "example.com" }], "definitely not a target").allowed).toBe(false);
    expect(match([{ kind: "domain", value: "example.com" }], "").allowed).toBe(false);
  });
});
