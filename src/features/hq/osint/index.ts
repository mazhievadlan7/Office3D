// The HQ «РАЗВЕДКА / OSINT» view: the hackers' open-source-recon toolkit, a
// normalized output model (entities / relations / findings tagged to an
// authorized engagement), and a summonable panel that shows the toolkit, an
// entity graph and a findings feed — and feeds the shared God's-Eye globe.
//
// One typed seam (osintController) carries demo data now and the scope-enforced
// Execution Plane later. Everything is for AUTHORIZED targets only; demo data is
// clearly fictional (example.com, TEST-NET-3, made-up handles). See TZ §0, §3.1.

export { osintController } from "./osintController";
export { DEMO_OSINT } from "./demoData";
export { OSINT_TOOLS, OSINT_TOOL_BY_ID, type OsintTool, type OsintToolId } from "./tools";
export type {
  OsintController,
  OsintDataset,
  OsintEngagement,
  OsintEntity,
  OsintFinding,
  OsintRelation,
  OsintSeverity,
} from "./types";
export type { HqOsintViewProps } from "./HqOsintView";
