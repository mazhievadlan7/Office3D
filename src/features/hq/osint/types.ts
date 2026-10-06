/**
 * The HQ «РАЗВЕДКА / OSINT» normalized output model — a clean, typed seam
 * between the open-source-recon tools (see tools.ts) and the surfaces that show
 * their results: the entity graph, the findings feed and the God's-Eye globe.
 *
 * LAWFUL FRAMING (load-bearing, not a disclaimer). Everything in this model is
 * tagged to an AUTHORIZED engagement and its scope. The OSINT layer only ever
 * holds data for:
 *   - the owner's own products and infrastructure (Phase 1),
 *   - a public bug-bounty program within its published scope,
 *   - a client asset under a signed contract with verified ownership.
 * Recon is PASSIVE and open-source; there is NO mass profiling of real private
 * individuals. Demo data uses clearly FICTIONAL sample targets only (example.com,
 * TEST-NET-3, made-up handles). The real feed will come from the scope-enforced
 * Execution Plane through the same osintController; for now a demo seed fills it.
 * See TZ §0, §3.1 (OSINT role), §4.2.
 */

import type { OsintToolId } from "./tools";

/** The kinds of entity the normalized graph can hold. */
export type OsintEntityKind =
  /** A person's online handle / persona (authorized-engagement context only). */
  | "person-handle"
  /** An email address. */
  | "email"
  /** An account username on some platform. */
  | "username"
  /** A registrable domain. */
  | "domain"
  /** A subdomain of an in-scope domain. */
  | "subdomain"
  /** A network host (IP). */
  | "host"
  /** A service exposed on a host (port + protocol/banner). */
  | "service"
  /** An organization. */
  | "org"
  /** A geolocated open-data point (geo-IP, geotag). */
  | "geo";

/** What a tool can be pointed at. */
export type OsintInputKind = "domain" | "email" | "username" | "ip" | "person-handle" | "none";

/** What a tool produces, in model terms. */
export type OsintProduceKind = OsintEntityKind | "relation" | "finding" | "graph" | "reference";

/** 0..1 — how confident we are a finding / entity is correct. */
export type OsintConfidence = number;

/** A finding's weight. Mirrors the HQ's finding severities. */
export type OsintSeverity = "info" | "low" | "medium" | "high";

/** A point on the Earth, degrees. Feeds the globe through osintController. */
export type OsintGeo = {
  lat: number;
  lon: number;
  /** A human place label (city / data-centre), shown in the graph and on the pin. */
  place?: string;
};

/**
 * How an entity maps onto the globe's target kinds, so the one geoController
 * colours it correctly: an in-scope owned asset, or an open-source OSINT point.
 */
export type OsintScopeClass = "asset" | "osint";

/** A node in the normalized OSINT graph. */
export type OsintEntity = {
  /** Stable id, used by relations, findings and the globe projection. */
  id: string;
  kind: OsintEntityKind;
  /** Display value: a handle, a domain, `203.0.113.10:443`, etc. */
  label: string;
  /** Raw value when the label is decorated. */
  value?: string;
  /** Short RU note (how it was found, what it is). */
  note?: string;
  /** Which tool surfaced it. */
  sourceToolId?: OsintToolId;
  /** 0..1 confidence this entity is real / correct. */
  confidence?: OsintConfidence;
  /** Optional geolocation; present for geo points and geo-IP'd hosts. */
  geo?: OsintGeo;
  /** How the globe should colour it (own asset vs open OSINT point). */
  scopeClass?: OsintScopeClass;
};

/** The relation (edge) kinds between entities. */
export type OsintRelationKind =
  /** domain → host / ip. */
  | "resolves"
  /** domain → subdomain. */
  | "subdomain"
  /** host → service. */
  | "runs"
  /** org / person → domain / account. */
  | "owns"
  /** person / username → account / email. */
  | "account"
  /** host / entity → geo point. */
  | "located"
  /** a generic association. */
  | "linked";

/** An edge in the normalized OSINT graph. */
export type OsintRelation = {
  id: string;
  /** Source entity id. */
  from: string;
  /** Target entity id. */
  to: string;
  kind: OsintRelationKind;
  label?: string;
};

/** A finding: something a tool reported about a target, with provenance. */
export type OsintFinding = {
  id: string;
  /** The tool that reported it (provenance). */
  sourceToolId: OsintToolId;
  /** Short RU title. */
  title: string;
  /** The entity this is about, when it maps to one. */
  entityId?: string;
  /** Free target text when there is no single entity (e.g. an HTTP header). */
  target?: string;
  severity: OsintSeverity;
  /** 0..1 confidence. */
  confidence: OsintConfidence;
  note?: string;
};

/**
 * The engagement / scope every piece of OSINT data is tagged to. Kept light
 * here; the authoritative, enforced engagement lives in the AEGIS core
 * (src/lib/aegis) and the future Execution Plane links to it via aegisEngagementId.
 */
export type OsintEngagement = {
  id: string;
  name: string;
  /** Loosely mirrors AegisStatus; the scope-enforced backend owns the real one. */
  status: "draft" | "authorized" | "active" | "stopped" | "completed";
  /** Human scope summary (the authorized assets). */
  scope: string;
  /** Seam: the AEGIS engagement this maps to once wired to the real core. */
  aegisEngagementId?: string;
};

/** A full OSINT dataset for one engagement — what osintController serves. */
export type OsintDataset = {
  engagement: OsintEngagement;
  entities: OsintEntity[];
  relations: OsintRelation[];
  findings: OsintFinding[];
};

/**
 * The OSINT data API: the demo seed populates it now, the scope-enforced
 * Execution Plane will drive it later. One instance is the single source of
 * truth for the РАЗВЕДКА view, and it projects geo entities onto the shared
 * geoController so the globe and the view never disagree.
 */
export type OsintController = {
  /** Replace the current dataset and notify subscribers (and feed the globe). */
  setData(data: OsintDataset): void;
  /** The current dataset, or null before any is set. */
  getData(): OsintDataset | null;
  /** Subscribe to dataset changes; returns an unsubscribe. */
  subscribe(listener: (data: OsintDataset | null) => void): () => void;
  /** Fly the globe to an entity's geolocation; false when it has none. */
  flyToEntity(entityId: string): boolean;
};
