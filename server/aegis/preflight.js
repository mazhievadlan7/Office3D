// Thin compatibility shim. The AEGIS legal core now lives in platform/core/
// (the always-on Security Core of Floor 27). This file re-exports it unchanged
// so the Next server (src/lib/aegis/core.ts) and the existing unit tests
// (tests/unit/aegis*.test.ts) keep importing "server/aegis/preflight.js" as before.
// Single source of truth: ../../platform/core/preflight.js — do not add logic here.
module.exports = require("../../platform/core/preflight.js");
