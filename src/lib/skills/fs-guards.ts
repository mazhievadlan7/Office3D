import fs from "node:fs";
import path from "node:path";

/**
 * Containment checks shared by skill installation and removal.
 *
 * Both write to or delete from a skills directory using a name that ultimately
 * comes from a registry or a gateway response, so both need the same guarantee:
 * the resolved path is inside the root it is supposed to be inside. Keeping one
 * implementation means the two cannot drift apart.
 */

/**
 * Resolves a path for comparison, following symlinks when the path exists. A
 * symlink inside the skills directory pointing outside it would otherwise pass
 * a prefix check while writing somewhere else entirely.
 */
export const resolveComparablePath = (input: string): string => {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    return resolved;
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

/** True when `candidate` is `root` itself or sits beneath it. */
export const isPathInside = (root: string, candidate: string): boolean => {
  const resolvedRoot = resolveComparablePath(root);
  const resolvedCandidate = resolveComparablePath(candidate);
  if (resolvedCandidate === resolvedRoot) {
    return true;
  }
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  return resolvedCandidate.startsWith(rootPrefix);
};
