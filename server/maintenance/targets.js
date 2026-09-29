// What the maintenance service may clean: an allowlist of six targets, and
// nothing else. Each target names its roots, an exact basename pattern and a
// rule (size, age, keep-newest). Everything else on disk is only measured as
// "weight" (see measureWeight) and never touched.
//
// | id          | scope | rule                                               |
// |-------------|-------|----------------------------------------------------|
// | dev-trace   | dev   | .next/dev/trace: truncate above 16 MiB             |
// | dev-log     | dev   | .next/dev/logs/*.log: truncate above 4 MiB         |
// | hmr-updates | dev   | *.hot-update.{js,json}: older than 60 min, keep 50 |
// | voice-temp  | all   | <tmp>/office3d-voice-XXXXXX: older than 1 h        |
// | test-temp   | dev   | <tmp>/office3d-<test prefix>-XXXXXX: older than 24 h |
// | orphan-tmp  | all   | atomic-write .settings-/.tasks-<uuid>.tmp: > 10 min |

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  checkItem,
  checkName,
  currentUid,
  isDeniedName,
  isPlainName,
  isSameOrAncestor,
  ownershipProblem,
  resolveRoot,
  sameIdentity,
  samePath,
  typeOf,
} = require("./safety");

// Truncation opens read-write and, where the OS has it, never through a
// symlink swapped in after the check (O_NOFOLLOW is POSIX-only).
const TRUNCATE_FLAGS = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0);

// At most this many folders are expanded under one root (hot-update subfolders).
const MAX_SUBDIRS = 64;

const KiB = 1024;
const MiB = 1024 * KiB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const TARGET_IDS = ["dev-trace", "dev-log", "hmr-updates", "voice-temp", "test-temp", "orphan-tmp"];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// mkdtemp appends six characters from [A-Za-z0-9].
const MKDTEMP = "[A-Za-z0-9]{6}";

// Temp directories made by this repo's own unit and e2e tests (grep mkdtemp in
// tests/). Only office3d-* names: generic prefixes such as "studio-state-" or
// "workspace-" could belong to anything else on the machine, and aegis-*
// (aegis-pf-...) is left alone on purpose.
const TEST_TEMP_PREFIXES = [
  "office3d-test",
  "office3d-e2e",
  "office3d-gateway-defaults",
  "office3d-backups",
  "office3d-autonomy",
  "office3d-hermes-test",
  "office3d-hermes-itest",
  "office3d-updates",
  "office3d-updater",
  "office3d-updater-itest",
  "office3d-skills",
  "office3d-skill-remove",
  "office3d-routes",
];

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERNS = {
  devTrace: /^trace$/,
  devLog: /^[A-Za-z0-9_-]{1,120}\.log$/,
  hmrUpdate: /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}\.hot-update\.(?:js|json)$/,
  voiceTemp: new RegExp(`^office3d-voice-${MKDTEMP}$`),
  testTemp: new RegExp(`^(?:${TEST_TEMP_PREFIXES.map(escapeRe).join("|")})-${MKDTEMP}$`),
  settingsTmp: new RegExp(`^\\.settings-${UUID}\\.tmp$`),
  tasksTmp: new RegExp(`^\\.tasks-${UUID}\\.tmp$`),
};

const RULES = {
  devTraceMinBytes: 16 * MiB,
  devLogMinBytes: 4 * MiB,
  hmrMinAgeMs: 60 * MINUTE,
  hmrKeepNewest: 50,
  voiceMinAgeMs: HOUR,
  testMinAgeMs: 24 * HOUR,
  orphanMinAgeMs: 10 * MINUTE,
};

// Tree targets: how big a directory may be and still be removed.
const TREE_LIMITS = {
  "voice-temp": { maxEntries: 16, maxDepth: 1 },
  "test-temp": { maxEntries: 1500, maxDepth: 8 },
};

const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

/** The path of `dir` below `anchor` as segments ([] when it is the anchor, null when outside it). */
const segmentsBelow = (anchor, dir) => {
  const rel = path.relative(anchor, dir);
  if (!rel) return [];
  if (path.isAbsolute(rel)) return null;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  return segments.includes("..") ? null : segments;
};

/**
 * The target definitions that apply here. Dev-only targets are absent in
 * production; test-temp can be switched off (OFFICE3D_MAINTENANCE_TEST_TEMP=off).
 */
const buildTargets = ({ dev, projectRoot, stateDir, tmpDir, testTemp = true }) => {
  const nextDev = path.join(projectRoot, ".next", "dev");
  const officeState = path.join(stateDir, "office3d");
  const all = [
    {
      id: "dev-trace",
      scope: "dev",
      op: "truncate",
      roots: [{ dir: nextDev, anchor: projectRoot, regex: PATTERNS.devTrace }],
      minBytes: RULES.devTraceMinBytes,
    },
    {
      id: "dev-log",
      scope: "dev",
      op: "truncate",
      roots: [{ dir: path.join(nextDev, "logs"), anchor: projectRoot, regex: PATTERNS.devLog }],
      minBytes: RULES.devLogMinBytes,
    },
    {
      id: "hmr-updates",
      scope: "dev",
      op: "remove",
      kind: "file",
      // Webpack writes hot updates here and into per-route subfolders
      // (app/, app/office/ …); each folder keeps its own newest 50.
      roots: [
        { dir: path.join(nextDev, "static", "webpack"), anchor: projectRoot, regex: PATTERNS.hmrUpdate, subdirDepth: 3 },
      ],
      minAgeMs: RULES.hmrMinAgeMs,
      keepNewest: RULES.hmrKeepNewest,
    },
    {
      id: "voice-temp",
      scope: "all",
      op: "remove",
      kind: "tree",
      roots: [{ dir: tmpDir, anchor: tmpDir, regex: PATTERNS.voiceTemp }],
      minAgeMs: RULES.voiceMinAgeMs,
      ...TREE_LIMITS["voice-temp"],
    },
    {
      id: "test-temp",
      scope: "dev",
      op: "remove",
      kind: "tree",
      roots: [{ dir: tmpDir, anchor: tmpDir, regex: PATTERNS.testTemp }],
      minAgeMs: RULES.testMinAgeMs,
      ...TREE_LIMITS["test-temp"],
    },
    {
      id: "orphan-tmp",
      scope: "all",
      op: "remove",
      kind: "file",
      roots: [
        { dir: officeState, anchor: stateDir, regex: PATTERNS.settingsTmp },
        { dir: path.join(officeState, "task-manager"), anchor: stateDir, regex: PATTERNS.tasksTmp },
      ],
      minAgeMs: RULES.orphanMinAgeMs,
    },
  ];
  // A temp tree that holds this server's own state or project (an e2e run
  // points OPENCLAW_STATE_DIR at an office3d-e2e-XXXXXX folder) is never removed.
  for (const target of all) if (target.kind === "tree") target.protect = [stateDir, projectRoot];
  return all.filter((target) => {
    if (target.scope === "dev" && !dev) return false;
    if (target.id === "test-temp" && !testTemp) return false;
    return true;
  });
};

/** Real paths of a target's protected folders (as configured when one is missing). */
const resolveProtected = async (fsp, target) => {
  const out = [];
  for (const dir of target.protect ?? []) {
    try {
      out.push(await fsp.realpath(dir));
    } catch {
      out.push(path.resolve(dir));
    }
  }
  return out;
};

const holdsProtected = (full, protectedDirs) => protectedDirs.some((dir) => isSameOrAncestor(full, dir));

const errorCode = (err) => {
  const code = err?.code;
  return typeof code === "string" && /^E[A-Z0-9_]{1,24}$/.test(code) ? code : "EUNKNOWN";
};

/**
 * Walks a directory tree without following anything: lstat on every entry,
 * any link, junction or special file refuses the whole tree, and so does (on
 * POSIX) anything another user owns or a folder others can write to. Entries
 * come back children-first (the order they can be removed in), the root last.
 */
const walkTree = async (fsp, rootDir, { maxEntries, maxDepth, ownerUid = currentUid() }) => {
  const entries = [];
  let bytes = 0;
  let newestMs = 0;
  let seen = 0;
  const visit = async (dir, depth) => {
    let st;
    try {
      st = await fsp.lstat(dir);
    } catch (err) {
      return errorCode(err) === "ENOENT" ? "gone" : "lstat-failed";
    }
    const kind = typeOf(st);
    if (kind !== "dir") return kind === "link" ? "link" : "wrong-type";
    const dirOwnership = ownershipProblem(st, ownerUid);
    if (dirOwnership) return dirOwnership;
    newestMs = Math.max(newestMs, st.mtimeMs);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      return errorCode(err) === "ENOENT" ? "gone" : "readdir-failed";
    }
    for (const name of names) {
      if (!isPlainName(name)) return "bad-name";
      seen += 1;
      if (seen > maxEntries) return "too-large";
      if (seen % 200 === 0) await yieldNow();
      const full = path.join(dir, name);
      let child;
      try {
        child = await fsp.lstat(full);
      } catch (err) {
        return errorCode(err) === "ENOENT" ? "changed" : "lstat-failed";
      }
      const childKind = typeOf(child);
      if (childKind === "link") return "link";
      if (childKind === "other") return "wrong-type";
      const childOwnership = ownershipProblem(child, ownerUid);
      if (childOwnership) return childOwnership;
      newestMs = Math.max(newestMs, child.mtimeMs);
      if (childKind === "dir") {
        if (depth + 1 > maxDepth) return "too-deep";
        const problem = await visit(full, depth + 1);
        if (problem) return problem;
      } else {
        bytes += child.size;
        entries.push({ path: full, type: "file", ino: child.ino, dev: child.dev });
      }
    }
    entries.push({ path: dir, type: "dir", ino: st.ino, dev: st.dev });
    return null;
  };
  const problem = await visit(rootDir, 0);
  // `seen`: how many entries the walk looked at before it stopped.
  if (problem) return { ok: false, reason: problem, seen };
  return { ok: true, bytes, entries, newestMs };
};

/** Real subfolders of a root, down to `depth`, never through a link or a denied name. */
const expandSubdirs = async (fsp, realRoot, depth) => {
  const out = [realRoot];
  if (!depth) return out;
  const walk = async (dir, level) => {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      // The cap holds across every level, not just the current one.
      if (out.length >= MAX_SUBDIRS) return;
      if (!isPlainName(name) || isDeniedName(name)) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (typeOf(st) !== "dir") continue;
      out.push(full);
      if (level < depth) await walk(full, level + 1);
    }
  };
  await walk(realRoot, 1);
  return out;
};

/**
 * Resolves one declared root (and its subfolders) to real, checked roots.
 * @returns {Promise<Array<{realRoot: string, anchorSegments: string[], regex: RegExp}>>}
 */
const resolveTargetRoots = async (fsp, root, { homeDir = os.homedir() }) => {
  const realRoot = await resolveRoot(fsp, root.dir, { homeDir });
  if (!realRoot) return [];
  let realAnchor = root.anchor;
  try {
    realAnchor = await fsp.realpath(root.anchor);
  } catch {
    // Anchor gone: fall back to the configured path.
  }
  const dirs = await expandSubdirs(fsp, realRoot, root.subdirDepth ?? 0);
  const out = [];
  for (const dir of dirs) {
    let realDir = dir;
    try {
      realDir = await fsp.realpath(dir);
    } catch {
      continue;
    }
    // A subfolder must resolve to itself (no link on the way).
    if (!samePath(realDir, dir)) continue;
    const anchorSegments = segmentsBelow(realAnchor, realDir);
    // A root outside its anchor is not trusted.
    if (!anchorSegments) continue;
    if (anchorSegments.some((segment) => isDeniedName(segment))) continue;
    out.push({ realRoot: realDir, anchorSegments, regex: root.regex });
  }
  return out;
};

/** The rule a candidate must pass, as a predicate over an lstat result. */
const ruleFor = (target, now) => {
  if (target.op === "truncate") return (stat) => stat.size > target.minBytes && (stat.nlink ?? 1) <= 1;
  return (stat) => now() - stat.mtimeMs > target.minAgeMs;
};

/**
 * What the next run would do for one target, from a fresh look at the disk.
 * Reads only (readdir / lstat / realpath).
 *
 * @returns {Promise<{id, bytes, items, candidates: object[], scanned: number, partial: boolean}>}
 */
const scanTarget = async (fsp, target, { now, homeDir = os.homedir(), budget = { entries: 20_000 }, ownerUid = currentUid() }) => {
  const result = { id: target.id, bytes: 0, items: 0, candidates: [], scanned: 0, partial: false };
  const accept = ruleFor(target, now);
  const protectedDirs = await resolveProtected(fsp, target);
  for (const declared of target.roots) {
    const roots = await resolveTargetRoots(fsp, declared, { homeDir });
    for (const root of roots) {
      let names;
      try {
        names = await fsp.readdir(root.realRoot);
      } catch {
        continue;
      }
      const matching = [];
      for (const name of names) {
        if (checkName({ name, regex: root.regex, anchorSegments: root.anchorSegments })) continue;
        matching.push(name);
      }
      const found = [];
      for (const name of matching) {
        if (budget.entries <= 0) {
          result.partial = true;
          break;
        }
        budget.entries -= 1;
        result.scanned += 1;
        if (result.scanned % 200 === 0) await yieldNow();
        const expect = target.kind === "tree" ? "dir" : "file";
        const check = await checkItem(fsp, {
          realRoot: root.realRoot,
          name,
          regex: root.regex,
          expect,
          anchorSegments: root.anchorSegments,
          ownerUid,
        });
        if (!check.ok) continue;
        found.push({ name, stat: check.stat, root });
      }
      let eligible = found;
      if (target.keepNewest) {
        eligible = found
          .slice()
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
          .slice(target.keepNewest);
      }
      for (const item of eligible) {
        if (target.kind === "tree") {
          // The shared scan budget bounds the walks too: a tree is walked only
          // as far as the budget left allows, and not at all once it is spent.
          if (budget.entries <= 0) {
            result.partial = true;
            break;
          }
          const full = path.join(item.root.realRoot, item.name);
          if (holdsProtected(full, protectedDirs)) continue;
          const maxEntries = Math.min(target.maxEntries, budget.entries);
          const tree = await walkTree(fsp, full, { maxEntries, maxDepth: target.maxDepth, ownerUid });
          if (!tree.ok) {
            if (tree.reason === "too-large" && maxEntries < target.maxEntries) result.partial = true;
            budget.entries -= Math.max(1, tree.seen ?? 0);
            continue;
          }
          budget.entries -= tree.entries.length;
          if (now() - tree.newestMs <= target.minAgeMs) continue;
          result.candidates.push({ ...item, bytes: tree.bytes, entries: tree.entries.length });
          result.bytes += tree.bytes;
          result.items += 1;
          continue;
        }
        if (!accept(item.stat)) continue;
        result.candidates.push({ ...item, bytes: item.stat.size, entries: 1 });
        result.bytes += item.stat.size;
        result.items += 1;
      }
    }
  }
  return result;
};

/**
 * Applies one candidate, re-checking everything right before each operation.
 * `ctx.spend()` must be called once per file-system operation; it returns
 * false when the run's cap is reached (the candidate is then left alone).
 *
 * @returns {Promise<{done: boolean, bytes: number, ops: number, skipped?: string, error?: string, stop?: boolean}>}
 */
const applyCandidate = async (fsp, target, candidate, ctx) => {
  const { root, name } = candidate;
  const accept = ruleFor(target, ctx.now);
  const expect = target.kind === "tree" ? "dir" : "file";
  const ownerUid = ctx.ownerUid === undefined ? currentUid() : ctx.ownerUid;
  const check = await checkItem(fsp, {
    realRoot: root.realRoot,
    name,
    regex: root.regex,
    expect,
    anchorSegments: root.anchorSegments,
    accept: target.kind === "tree" ? undefined : accept,
    previous: candidate.stat,
    ownerUid,
  });
  if (!check.ok) return { done: false, bytes: 0, ops: 0, skipped: check.reason };

  if (target.op === "truncate") {
    if (ctx.dryRun) return { done: true, bytes: check.stat.size, ops: 0 };
    if (!ctx.canSpend(1)) return { done: false, bytes: 0, ops: 0, stop: true };
    let handle;
    let spent = 0;
    try {
      handle = await fsp.open(check.path, TRUNCATE_FLAGS);
      const st = await handle.stat();
      // The open followed nothing unexpected: same file, still over the limit.
      if (!sameIdentity(check.stat, st) || !st.isFile() || !accept(st) || ownershipProblem(st, ownerUid)) {
        return { done: false, bytes: 0, ops: 0, skipped: "rule" };
      }
      ctx.spend(1);
      spent = 1;
      await handle.truncate(0);
      return { done: true, bytes: st.size, ops: 1 };
    } catch (err) {
      return { done: false, bytes: 0, ops: spent, error: errorCode(err) };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  if (target.kind === "file") {
    if (ctx.dryRun) return { done: true, bytes: check.stat.size, ops: 0 };
    if (!ctx.canSpend(1)) return { done: false, bytes: 0, ops: 0, stop: true };
    ctx.spend(1);
    try {
      await fsp.unlink(check.path);
      return { done: true, bytes: check.stat.size, ops: 1 };
    } catch (err) {
      return { done: false, bytes: 0, ops: 1, error: errorCode(err) };
    }
  }

  // A directory tree: walk it again now, and remove it only if every entry is
  // a plain file or folder, it is small enough, and nothing in it is recent.
  if (holdsProtected(check.path, await resolveProtected(fsp, target))) {
    return { done: false, bytes: 0, ops: 0, skipped: "protected" };
  }
  const tree = await walkTree(fsp, check.path, { maxEntries: target.maxEntries, maxDepth: target.maxDepth, ownerUid });
  if (!tree.ok) return { done: false, bytes: 0, ops: 0, skipped: tree.reason };
  if (ctx.now() - tree.newestMs <= target.minAgeMs) return { done: false, bytes: 0, ops: 0, skipped: "rule" };
  if (ctx.dryRun) return { done: true, bytes: tree.bytes, ops: 0 };
  // All or nothing: never start a tree the remaining budget cannot finish.
  if (!ctx.canSpend(tree.entries.length)) return { done: false, bytes: 0, ops: 0, stop: true };
  let ops = 0;
  let freed = 0;
  for (const entry of tree.entries) {
    // Each entry's folder must still be exactly where the walk saw it (no
    // folder swapped for a link since), and the entry itself unchanged.
    const parent = path.dirname(entry.path);
    try {
      const realParent = await fsp.realpath(parent);
      if (!samePath(realParent, parent)) return { done: false, bytes: freed, ops, error: "ECHANGED" };
      const st = await fsp.lstat(entry.path);
      const kind = typeOf(st);
      if (kind !== entry.type || !sameIdentity(entry, st) || ownershipProblem(st, ownerUid)) {
        return { done: false, bytes: freed, ops, error: "ECHANGED" };
      }
      ctx.spend(1);
      ops += 1;
      if (kind === "file") {
        await fsp.unlink(entry.path);
        freed += st.size;
      } else {
        await fsp.rmdir(entry.path);
      }
    } catch (err) {
      return { done: false, bytes: freed, ops, error: errorCode(err) };
    }
    if (ops % ctx.batchSize === 0) await ctx.yield();
  }
  return { done: true, bytes: tree.bytes, ops };
};

/** Directories and files that are only reported ("weight"), never cleaned. */
const weightItems = ({ dev, projectRoot, stateDir }) => {
  const officeState = path.join(stateDir, "office3d");
  const items = [
    { id: "settings", file: path.join(officeState, "settings.json") },
    { id: "tasks", file: path.join(officeState, "task-manager", "tasks.json") },
    { id: "corrupt-copies", corruptIn: [officeState, path.join(officeState, "task-manager")] },
    { id: "next-cache", dir: path.join(projectRoot, ".next", "cache") },
  ];
  if (dev) items.push({ id: "next-dev-cache", dir: path.join(projectRoot, ".next", "dev", "cache") });
  return items;
};

const WEIGHT_WALK_CAP = 3000;

/** Sums a folder without following links; stops at `cap` entries (bytes is then a lower bound). */
const sumDir = async (fsp, dir, cap) => {
  let bytes = 0;
  let items = 0;
  let capped = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = await fsp.readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (items >= cap) {
        capped = true;
        return { bytes, items, capped };
      }
      const full = path.join(current, name);
      let st;
      try {
        st = await fsp.lstat(full);
      } catch {
        continue;
      }
      items += 1;
      if (items % 200 === 0) await yieldNow();
      const kind = typeOf(st);
      if (kind === "dir") stack.push(full);
      else if (kind === "file") bytes += st.size;
    }
  }
  return { bytes, items, capped };
};

/**
 * The weight list: how big the things the service never cleans are, by id.
 * No paths leave this function.
 */
const measureWeight = async (fsp, ctx) => {
  const out = [];
  for (const item of weightItems(ctx)) {
    if (item.file) {
      try {
        const st = await fsp.lstat(item.file);
        out.push({ id: item.id, bytes: st.isFile() ? st.size : 0, prunable: false });
      } catch {
        out.push({ id: item.id, bytes: 0, prunable: false });
      }
      continue;
    }
    if (item.corruptIn) {
      let bytes = 0;
      let items = 0;
      for (const dir of item.corruptIn) {
        let names;
        try {
          names = await fsp.readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.toLowerCase().includes(".corrupt")) continue;
          try {
            const st = await fsp.lstat(path.join(dir, name));
            if (!st.isFile()) continue;
            bytes += st.size;
            items += 1;
          } catch {
            // Gone meanwhile.
          }
        }
      }
      out.push({ id: item.id, bytes, items, prunable: false });
      continue;
    }
    try {
      const st = await fsp.lstat(item.dir);
      if (!st.isDirectory()) {
        out.push({ id: item.id, bytes: 0, items: 0, prunable: false });
        continue;
      }
    } catch {
      out.push({ id: item.id, bytes: 0, items: 0, prunable: false });
      continue;
    }
    const sum = await sumDir(fsp, item.dir, WEIGHT_WALK_CAP);
    out.push({ id: item.id, bytes: sum.bytes, items: sum.items, ...(sum.capped ? { cap: true } : null), prunable: false });
  }
  return out;
};

module.exports = {
  PATTERNS,
  RULES,
  TARGET_IDS,
  TEST_TEMP_PREFIXES,
  applyCandidate,
  buildTargets,
  MAX_SUBDIRS,
  errorCode,
  expandSubdirs,
  measureWeight,
  scanTarget,
  walkTree,
  yieldNow,
};
