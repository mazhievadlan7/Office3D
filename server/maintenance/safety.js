// Safety checks for the maintenance service. Every operation it performs
// (truncate, unlink, rmdir) passes these first, and again right before the
// operation itself:
//
// 1. The real path of the item's parent is the target root (resolved once per
//    run with realpath), so nothing outside the root is ever touched.
// 2. lstat: no symbolic links or junctions, and the type is the expected one.
// 3. The basename matches the target's own regex (and is a plain name).
// 4. Age and size are re-checked immediately before the operation.
// 5. The path is not on the deny list — even when a pattern matches.
// 6. POSIX only: the item belongs to this process's user, and no folder on
//    the way is writable by anyone else (see ownershipProblem).
//
// When in doubt the answer is "no": a failed check skips the item.

const os = require("node:os");
const path = require("node:path");

const isWin = process.platform === "win32";

/** Paths compared the way the file system compares them. */
const normalizeForCompare = (value) => {
  const resolved = path.resolve(String(value ?? ""));
  return isWin ? resolved.toLowerCase() : resolved;
};

const samePath = (a, b) => normalizeForCompare(a) === normalizeForCompare(b);

// Never removed, truncated or walked into, whatever a target's regex says.
// Compared case-insensitively against every segment below the target's anchor.
const DENY_NAMES = new Set([
  "settings.json",
  "tasks.json",
  "state.json",
  "runs.jsonl",
  "node_modules",
  "cache",
  "public",
  "blender",
  "uploads",
  "trash",
  "aegis",
  "hermes",
  "maintenance",
  ".git",
]);

/** Whether one path segment (a file or directory name) is deny-listed. */
const isDeniedName = (name) => {
  const lower = String(name ?? "").toLowerCase();
  if (!lower) return true;
  if (DENY_NAMES.has(lower)) return true;
  if (lower.startsWith(".env")) return true;
  if (lower.includes(".corrupt")) return true;
  return false;
};

/**
 * Whether `segments` (the item's path below its anchor: the project root, the
 * state dir or the temp dir) contains a deny-listed name.
 */
const isDeniedPath = (segments) => segments.some((segment) => isDeniedName(segment));

/** A plain file name: no separators, not "." or "..", no control characters. */
const isPlainName = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 255 &&
  name !== "." &&
  name !== ".." &&
  !/[\\/:\u0000-\u001f\u007f]/.test(name);

/** Whether `dir` is `other` or one of its ancestors. */
const isSameOrAncestor = (dir, other) => {
  const rel = path.relative(normalizeForCompare(dir), normalizeForCompare(other));
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
};

/** Roots the service refuses to work in at all: a file-system root, the home dir or anything above it. */
const isDangerousRoot = (realRoot, homeDir) => {
  const resolved = path.resolve(realRoot);
  if (path.parse(resolved).root === resolved) return true;
  if (homeDir && isSameOrAncestor(resolved, homeDir)) return true;
  return false;
};

// POSIX: only what this process's own user owns is ever touched, and no
// folder another user can write to is ever walked into. In a shared /tmp
// another local user could otherwise plant an office3d-voice-XXXXXX folder
// and swap a subfolder for a symlink between the check and the unlink.
// Windows reports uid 0 for everything and keeps %TEMP% per user: no check.
const currentUid = () => (isWin || typeof process.getuid !== "function" ? null : process.getuid());

/**
 * null when `stat` belongs to `uid` (and, for a folder, is not group- or
 * world-writable), else the reason. `uid` null skips the check.
 */
const ownershipProblem = (stat, uid) => {
  if (uid === null || uid === undefined) return null;
  if (stat.uid !== uid) return "not-owner";
  if (stat.isDirectory() && (Number(stat.mode) & 0o022) !== 0) return "shared-dir";
  return null;
};

/**
 * The real path of a target root, or null when it is missing, not a
 * directory, or one of the refused roots (a file-system root, the home dir).
 */
const resolveRoot = async (fsp, root, { homeDir = os.homedir() } = {}) => {
  let real;
  try {
    real = await fsp.realpath(root);
  } catch {
    return null;
  }
  let realHome = homeDir;
  try {
    if (homeDir) realHome = await fsp.realpath(homeDir);
  } catch {
    // Keep the configured value.
  }
  if (isDangerousRoot(real, realHome)) return null;
  try {
    const stat = await fsp.lstat(real);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return real;
};

const typeOf = (stat) => {
  if (stat.isSymbolicLink()) return "link";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "dir";
  return "other";
};

/** Same file as an earlier lstat (inode and device), where the OS reports them. */
const sameIdentity = (a, b) => {
  if (!a || !b) return true;
  if (!a.ino || !b.ino) return true;
  return String(a.ino) === String(b.ino) && String(a.dev) === String(b.dev);
};

/**
 * The checks that need no file system: a plain name matching the target's
 * regex, and nothing deny-listed on the way from the anchor.
 * @param {{name: string, regex: RegExp, anchorSegments?: string[]}} args
 * @returns {string|null} null when it passes, else the reason
 */
const checkName = ({ name, regex, anchorSegments = [] }) => {
  if (!isPlainName(name)) return "bad-name";
  if (!(regex instanceof RegExp) || !regex.test(name)) return "no-match";
  if (isDeniedPath([...anchorSegments, name])) return "denied";
  return null;
};

/**
 * All five checks for one item directly inside `realRoot`.
 *
 * @param {object} fsp  fs.promises (or a test double)
 * @param {object} args
 * @param {string} args.realRoot        resolveRoot() result
 * @param {string} args.name            the item's basename
 * @param {RegExp} args.regex           the target's basename pattern
 * @param {"file"|"dir"} args.expect    required type
 * @param {string[]} [args.anchorSegments] the root's path below its anchor
 * @param {(stat) => boolean} [args.accept] the age/size rule, re-checked here
 * @param {object} [args.previous]      an earlier lstat of the same item
 * @param {number|null} [args.ownerUid] required owner (POSIX); null skips the check
 * @returns {Promise<{ok: true, path: string, stat: object} | {ok: false, reason: string}>}
 */
const checkItem = async (fsp, { realRoot, name, regex, expect, anchorSegments = [], accept, previous, ownerUid = currentUid() }) => {
  const nameProblem = checkName({ name, regex, anchorSegments });
  if (nameProblem) return { ok: false, reason: nameProblem };
  const full = path.join(realRoot, name);
  let parentReal;
  try {
    parentReal = await fsp.realpath(path.dirname(full));
  } catch {
    return { ok: false, reason: "parent-missing" };
  }
  if (!samePath(parentReal, realRoot)) return { ok: false, reason: "outside-root" };
  let stat;
  try {
    stat = await fsp.lstat(full);
  } catch (err) {
    return { ok: false, reason: err?.code === "ENOENT" ? "gone" : "lstat-failed" };
  }
  const kind = typeOf(stat);
  if (kind === "link") return { ok: false, reason: "link" };
  if (kind !== expect) return { ok: false, reason: "wrong-type" };
  const ownership = ownershipProblem(stat, ownerUid);
  if (ownership) return { ok: false, reason: ownership };
  if (!sameIdentity(previous, stat)) return { ok: false, reason: "replaced" };
  if (accept && !accept(stat)) return { ok: false, reason: "rule" };
  return { ok: true, path: full, stat };
};

module.exports = {
  DENY_NAMES,
  checkItem,
  checkName,
  currentUid,
  isDangerousRoot,
  isDeniedName,
  isDeniedPath,
  isPlainName,
  isSameOrAncestor,
  normalizeForCompare,
  ownershipProblem,
  resolveRoot,
  sameIdentity,
  samePath,
  typeOf,
};
