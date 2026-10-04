#!/usr/bin/env node
// emit-system-prompt — print the agent system prompt from governance.js.
//
// This is the JS counterpart of the TZ's archive_ingestion/emit_system_prompt.py
// concept (§22): the governance block (RULE_0…RULE_5 + the authorized scope of
// one engagement) is emitted from a SINGLE source — governance.js — and used
// verbatim by the HQ panel, the control plane (GET /v1/governance/system-prompt)
// and every agent runtime. There is no second copy of the rules anywhere.
//
// Usage:
//   node platform/core/emit-system-prompt.js [--agent <callsign>]
//   node platform/core/emit-system-prompt.js --data-dir <dir> --engagement <id> [--agent <callsign>]
//   node platform/core/emit-system-prompt.js --rules-json
//
// With no engagement, it prints the "no active engagement — all active actions
// forbidden" variant. With --data-dir + --engagement it pins the prompt to that
// stored engagement's authorized scope. --rules-json dumps the structured rules.

const path = require("node:path");

const { RULES, composeSystemPrompt } = require("./governance");

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--rules-json") args.rulesJson = true;
    else if (token === "--agent") args.agent = argv[++i];
    else if (token === "--engagement") args.engagement = argv[++i];
    else if (token === "--data-dir") args.dataDir = argv[++i];
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
};

const USAGE = `emit-system-prompt — print the AEGIS governance system prompt (single source: governance.js)

  --agent <callsign>        include the agent callsign line
  --data-dir <dir>          AEGIS data dir (to resolve a stored engagement)
  --engagement <id>         pin the prompt to this engagement's authorized scope
  --rules-json              print the structured RULES as JSON instead
  -h, --help                show this help
`;

const loadEngagement = (dataDir, engagementId, logError) => {
  // Lazy-require the store so the common (no-engagement) path stays dependency-free.
  const { createAegisStore } = require("./store");
  const store = createAegisStore({ filePath: path.join(dataDir, "aegis-state.json"), logError });
  return store.getEngagement(engagementId);
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.rulesJson) {
    process.stdout.write(`${JSON.stringify(RULES, null, 2)}\n`);
    return 0;
  }

  let engagement = null;
  if (args.engagement) {
    if (!args.dataDir) {
      process.stderr.write("--engagement requires --data-dir\n");
      return 2;
    }
    engagement = loadEngagement(args.dataDir, args.engagement, (m, e) => process.stderr.write(`${m} ${e ?? ""}\n`));
    if (!engagement) {
      process.stderr.write(`engagement не найден: ${args.engagement}\n`);
      return 1;
    }
  }

  process.stdout.write(`${composeSystemPrompt({ engagement, agentName: args.agent ?? "" })}\n`);
  return 0;
};

if (require.main === module) {
  process.exit(main());
}

module.exports = { parseArgs, main };
