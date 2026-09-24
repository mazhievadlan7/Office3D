import { describe, expect, it } from "vitest";

const { validateAsset, matchTarget, normalizeDomain } = await import("../../server/aegis/scope.js");

const allow = (assets: object[], target: string | object) => matchTarget(assets, target).allowed;

describe("AEGIS scope matcher", () => {
  it("matches an exact domain and refuses look-alikes and subdomains by default", () => {
    const assets = [validateAsset({ kind: "domain", value: "example.com" })];
    expect(allow(assets, "example.com")).toBe(true);
    expect(allow(assets, "a.example.com")).toBe(false); // subdomains off by default
    expect(allow(assets, "evilexample.com")).toBe(false); // no substring trick
    expect(allow(assets, "example.com.evil.com")).toBe(false); // no suffix trick
    expect(allow(assets, "example.org")).toBe(false);
  });

  it("includes subdomains only when asked, and never a look-alike", () => {
    const assets = [validateAsset({ kind: "domain", value: "example.com", includeSubdomains: true })];
    expect(allow(assets, "example.com")).toBe(true);
    expect(allow(assets, "a.example.com")).toBe(true);
    expect(allow(assets, "deep.a.example.com")).toBe(true);
    expect(allow(assets, "evilexample.com")).toBe(false);
    expect(allow(assets, "example.com.evil.com")).toBe(false);
  });

  it("keeps domains and IPs in separate lanes", () => {
    const domainAsset = [validateAsset({ kind: "domain", value: "example.com" })];
    const ipAsset = [validateAsset({ kind: "ip", value: "203.0.113.5" })];
    expect(allow(domainAsset, "203.0.113.5")).toBe(false); // domain asset never matches an IP target
    expect(allow(ipAsset, "example.com")).toBe(false); // ip asset never matches a domain target
    expect(allow(ipAsset, "203.0.113.5")).toBe(true);
    expect(allow(ipAsset, "203.0.113.6")).toBe(false);
  });

  it("matches inside a CIDR range", () => {
    const assets = [validateAsset({ kind: "cidr", value: "10.0.0.0/8" })];
    expect(allow(assets, "10.9.9.9")).toBe(true);
    expect(allow(assets, "11.0.0.1")).toBe(false);
  });

  it("honors per-asset port restrictions", () => {
    const assets = [validateAsset({ kind: "domain", value: "example.com", ports: [443] })];
    expect(allow(assets, { host: "example.com", port: 443 })).toBe(true);
    expect(allow(assets, { host: "example.com", port: 80 })).toBe(false);
    expect(allow(assets, { host: "example.com" })).toBe(false); // unspecified port can't be proven in-scope
  });

  it("matches a URL asset with a path prefix", () => {
    const assets = [validateAsset({ kind: "url", value: "https://app.example.com/api" })];
    expect(allow(assets, "https://app.example.com/api/users")).toBe(true);
    expect(allow(assets, "https://app.example.com/admin")).toBe(false);
    expect(allow(assets, { host: "app.example.com", path: "/api", port: 443 })).toBe(true);
  });

  it("normalizes IDN domains to punycode and matches consistently", () => {
    const ascii = normalizeDomain("bücher.example");
    expect(ascii).toBe("xn--bcher-kva.example");
    const assets = [validateAsset({ kind: "domain", value: "bücher.example" })];
    expect(allow(assets, "bücher.example")).toBe(true);
    expect(allow(assets, "xn--bcher-kva.example")).toBe(true);
  });

  it("denies unparseable or empty targets (default-deny)", () => {
    const assets = [validateAsset({ kind: "domain", value: "example.com", includeSubdomains: true })];
    expect(allow(assets, "")).toBe(false);
    expect(allow(assets, "not a host")).toBe(false);
    expect(allow(assets, {})).toBe(false);
    expect(allow([], "example.com")).toBe(false); // no assets → nothing allowed
  });

  it("rejects invalid assets at validation time", () => {
    expect(() => validateAsset({ kind: "domain", value: "1.2.3.4" })).toThrow();
    expect(() => validateAsset({ kind: "cidr", value: "0.0.0.0/0" })).toThrow(); // too broad
    expect(() => validateAsset({ kind: "ip", value: "999.1.1.1" })).toThrow();
    expect(() => validateAsset({ kind: "nope", value: "x" })).toThrow();
    expect(() => validateAsset({ kind: "domain", value: "example.com", ports: [70000] })).toThrow();
  });
});
