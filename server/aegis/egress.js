// Egress allowlist compiler.
//
// Scope matching (scope.js) decides whether a STATED target is authorized. The
// egress firewall is the second, lower layer: on the worker node it drops every
// outbound packet that is not headed to an authorized address (default-deny,
// Zero Trust — §4.2). This module turns an active engagement's assets into the
// allowlist that firewall consumes. It does not enforce anything itself —
// enforcement is nftables/eBPF on the host, applied at deploy time from this
// output.
//
// Domains are emitted separately: the firewall/resolver side resolves them to
// addresses under its own control, so a DNS answer cannot widen the perimeter
// beyond what resolution yields at that moment.

const { parseIp, parseCidr } = require("./ip");

const cidrForIp = (value) => {
  const ip = parseIp(value);
  if (!ip) return null;
  return ip.version === 4 ? `${value}/32` : `${value}/128`;
};

/**
 * Compile an active engagement's assets into an egress allowlist.
 * @param {object} engagement  a snapshot with .status === "active" and .assets
 * @returns {{engagementId: string, ipv4: string[], ipv6: string[], domains: string[], note: string}}
 */
const compileAllowlist = (engagement) => {
  if (!engagement || engagement.status !== "active") {
    // Deny-by-default: a non-active engagement authorizes nothing outbound.
    return { engagementId: engagement?.id ?? null, ipv4: [], ipv6: [], domains: [], note: "engagement не активен — исходящий трафик запрещён полностью" };
  }
  const ipv4 = new Set();
  const ipv6 = new Set();
  const domains = new Set();

  for (const asset of engagement.assets ?? []) {
    if (asset.kind === "domain") {
      domains.add(asset.value);
    } else if (asset.kind === "ip") {
      const ip = parseIp(asset.value);
      const cidr = cidrForIp(asset.value);
      if (ip && cidr) (ip.version === 4 ? ipv4 : ipv6).add(cidr);
    } else if (asset.kind === "cidr") {
      const cidr = parseCidr(asset.value);
      if (cidr) (cidr.version === 4 ? ipv4 : ipv6).add(asset.value);
    } else if (asset.kind === "url") {
      if (asset.isIpHost) {
        const ip = parseIp(asset.host);
        const cidr = cidrForIp(asset.host);
        if (ip && cidr) (ip.version === 4 ? ipv4 : ipv6).add(cidr);
      } else {
        domains.add(asset.host);
      }
    }
  }

  return {
    engagementId: engagement.id,
    ipv4: [...ipv4].sort(),
    ipv6: [...ipv6].sort(),
    domains: [...domains].sort(),
    note: "default-deny: всё, чего нет в списке, блокируется",
  };
};

/**
 * Render an nftables ruleset from an allowlist — a generated deploy artifact,
 * applied on the worker node. Domains are listed as comments; the resolver/
 * firewall integration resolves them into the address sets at apply time.
 * @param {ReturnType<compileAllowlist>} allowlist
 * @returns {string}
 */
const renderNftables = (allowlist) => {
  const v4 = allowlist.ipv4.length ? allowlist.ipv4.join(", ") : "";
  const v6 = allowlist.ipv6.length ? allowlist.ipv6.join(", ") : "";
  const domainLines = allowlist.domains.map((d) => `    # domain (resolve into set at apply time): ${d}`).join("\n");
  return [
    `# AEGIS egress allowlist — engagement ${allowlist.engagementId}`,
    "# GENERATED. Apply on the worker node. Default policy is DROP.",
    "table inet aegis_egress {",
    "  set scope_v4 { type ipv4_addr; flags interval;" + (v4 ? ` elements = { ${v4} }` : "") + " }",
    "  set scope_v6 { type ipv6_addr; flags interval;" + (v6 ? ` elements = { ${v6} }` : "") + " }",
    "  chain output {",
    "    type filter hook output priority 0; policy drop;",
    "    ct state established,related accept",
    "    ip daddr @scope_v4 accept",
    "    ip6 daddr @scope_v6 accept",
    domainLines,
    "    # everything else: dropped",
    "  }",
    "}",
    "",
  ].join("\n");
};

module.exports = { compileAllowlist, renderNftables };
