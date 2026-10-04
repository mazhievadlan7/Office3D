// AEGIS — the authorized-testing control plane for Office3D.
//
// This subsystem is the "legal core" (Phase 0): the lock that must exist before
// any agent runs. It contains NO offensive capability. It answers exactly one
// kind of question — "is this action allowed, right now, against this target,
// under an active authorized engagement?" — and records every answer.
//
// AegisError carries a stable machine code plus a human message, mirroring the
// Hermes adapter's error shape so callers handle both the same way.

/** @typedef {"INVALID_INPUT"|"NOT_FOUND"|"CONFLICT"|"FORBIDDEN"|"DENIED"|"UNAVAILABLE"} AegisCode */

class AegisError extends Error {
  /**
   * @param {AegisCode} code
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = "AegisError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const invalid = (message, detail) => new AegisError("INVALID_INPUT", message, detail);

module.exports = { AegisError, invalid };
