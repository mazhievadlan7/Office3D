// Gate-0 — the canary tripwire (TZ §16.2-5 «Gate-0: приманка рядом, но ВНЕ scope; тронул = провал»).
//
// A Gate-0 canary is a bait asset that is deliberately OUTSIDE every authorized
// scope. No legitimate agent ever has a reason to touch it, so any preflight
// request whose target matches a canary is treated as a hard failure signal: it
// is denied, it trips the GLOBAL kill-switch, and it is written to the audit
// ledger as `gate0_tripped`. This is a pure deny-side mechanism — it can only
// ever make the gate MORE closed, never open anything.
//
// Matching reuses the proven default-deny scope matcher (scope.js): the canary
// targets are validated into the same canonical asset form, and a hit is simply
// "the target matched a canary asset". Off by default; the platform config (or
// the control-plane env) turns it on, and the test net runs it on.

const { validateAsset, matchTarget } = require("./scope");
const { isIp, parseCidr } = require("./ip");

/** Turn a bare string canary into an asset spec, guessing its kind. */
const specFromString = (raw) => {
  const value = raw.trim();
  if (value.includes("://")) return { kind: "url", value };
  if (value.includes("/") && parseCidr(value)) return { kind: "cidr", value };
  if (isIp(value)) return { kind: "ip", value };
  return { kind: "domain", value, includeSubdomains: true };
};

/**
 * @param {object} deps
 * @param {boolean} [deps.enabled]            off by default (prod); on in tests
 * @param {Array<object|string>} [deps.targets]  canary assets ({kind,value,...}) or URL/host strings
 * @param {(info: {engagementId: string|null, actor: string, action: string}) => void} [deps.onTrip]
 * @param {(message: string, err?: unknown) => void} [deps.logError]
 */
const createGate0 = ({ enabled = false, targets = [], onTrip = () => {}, logError = () => {} } = {}) => {
  const canaries = [];
  if (enabled) {
    for (const raw of Array.isArray(targets) ? targets : []) {
      try {
        // Accept a bare host/IP/CIDR/URL string as a convenience, or a full asset spec.
        const spec = typeof raw === "string" ? specFromString(raw) : raw;
        canaries.push(validateAsset(spec));
      } catch (err) {
        logError(`Gate-0 канарейка отклонена и пропущена: ${JSON.stringify(raw)}`, err);
      }
    }
  }
  const active = enabled && canaries.length > 0;

  return {
    enabled: active,
    canaries,
    /** Whether a preflight target matches a configured canary. */
    isCanary(target) {
      if (!active) return false;
      try {
        return matchTarget(canaries, target).allowed === true;
      } catch {
        // A tripwire must fail safe: if matching throws, do not claim a hit
        // (preflight still denies by default for an unparsable target).
        return false;
      }
    },
    onTrip,
  };
};

module.exports = { createGate0 };
