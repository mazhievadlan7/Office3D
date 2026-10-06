import type { OsintDataset } from "./types";

/**
 * Demo seed for the «РАЗВЕДКА / OSINT» view: a FICTIONAL authorized recon of our
 * OWN lab so the graph, the findings feed and the globe have something to show
 * before the scope-enforced Execution Plane is wired in.
 *
 * Everything here is reserved-for-documentation sample data — never a real
 * person or asset:
 *   - example.com / *.example.com  (RFC 2606 reserved documentation domain),
 *   - 203.0.113.0/24               (RFC 5737 TEST-NET-3, reserved for docs),
 *   - «labuser» / «j.doe»          (made-up personas of our own lab stand).
 * The geolocations are illustrative data-centre cities for the globe, not a real
 * trace of anyone. To drive the view for real later, replace this seed with a
 * feed from the scope-enforced backend through the same osintController.setData().
 */

export const DEMO_OSINT: OsintDataset = {
  engagement: {
    id: "ENG-OSINT-DEMO",
    name: "OSINT-разведка · собственный стенд (демо)",
    status: "active",
    scope: "example.com, *.example.com, 203.0.113.0/24 (TEST-NET-3) — собственная лаборатория",
    // Seam: the AEGIS engagement id goes here once the real core drives this.
  },
  entities: [
    { id: "org-example", kind: "org", label: "Example Lab (наш стенд)", confidence: 1, scopeClass: "asset", sourceToolId: "maltego" },
    { id: "dom-example", kind: "domain", label: "example.com", confidence: 1, scopeClass: "asset", sourceToolId: "recon-ng", note: "Корневой домен в scope" },

    // theHarvester — subdomains.
    { id: "sub-api", kind: "subdomain", label: "api.example.com", confidence: 0.95, scopeClass: "asset", sourceToolId: "theharvester" },
    { id: "sub-mail", kind: "subdomain", label: "mail.example.com", confidence: 0.95, scopeClass: "asset", sourceToolId: "theharvester" },
    { id: "sub-vpn", kind: "subdomain", label: "vpn.example.com", confidence: 0.9, scopeClass: "asset", sourceToolId: "theharvester" },
    { id: "sub-dev", kind: "subdomain", label: "dev.example.com", confidence: 0.85, scopeClass: "asset", sourceToolId: "theharvester" },

    // Shodan — hosts (geo-IP'd for the globe) and services.
    { id: "host-10", kind: "host", label: "203.0.113.10", value: "203.0.113.10", confidence: 0.97, scopeClass: "asset", sourceToolId: "shodan", note: "edge-web · geo-IP", geo: { lat: 50.1109, lon: 8.6821, place: "Франкфурт" } },
    { id: "host-21", kind: "host", label: "203.0.113.21", value: "203.0.113.21", confidence: 0.95, scopeClass: "asset", sourceToolId: "shodan", note: "api-gw · geo-IP", geo: { lat: 52.3676, lon: 4.9041, place: "Амстердам" } },
    { id: "host-34", kind: "host", label: "203.0.113.34", value: "203.0.113.34", confidence: 0.9, scopeClass: "asset", sourceToolId: "shodan", note: "files-lab · geo-IP", geo: { lat: 52.2297, lon: 21.0122, place: "Варшава" } },
    { id: "svc-443", kind: "service", label: "443/tcp · nginx", confidence: 0.97, scopeClass: "asset", sourceToolId: "shodan" },
    { id: "svc-22", kind: "service", label: "22/tcp · OpenSSH", confidence: 0.9, scopeClass: "asset", sourceToolId: "shodan", note: "Баннер версии устарел" },

    // theHarvester / holehe — emails.
    { id: "email-admin", kind: "email", label: "admin@example.com", confidence: 0.9, scopeClass: "asset", sourceToolId: "theharvester" },
    { id: "email-dev", kind: "email", label: "dev@example.com", confidence: 0.85, scopeClass: "asset", sourceToolId: "holehe" },

    // Maltego / sherlock — persona and accounts (fictional lab persona).
    { id: "ph-jdoe", kind: "person-handle", label: "labuser (персона стенда)", confidence: 0.6, scopeClass: "osint", sourceToolId: "maltego" },
    { id: "user-gh", kind: "username", label: "labuser · GitHub", confidence: 0.7, scopeClass: "osint", sourceToolId: "sherlock" },
    { id: "user-gl", kind: "username", label: "labuser · GitLab", confidence: 0.65, scopeClass: "osint", sourceToolId: "sherlock" },
    { id: "user-mast", kind: "username", label: "labuser · Mastodon", confidence: 0.5, scopeClass: "osint", sourceToolId: "tookie-osint" },

    // geocreepy — an open geotag of the lab persona.
    { id: "geo-tag", kind: "geo", label: "Открытая геометка", confidence: 0.5, scopeClass: "osint", sourceToolId: "geocreepy", note: "Публичный пост · открытые данные", geo: { lat: 41.3874, lon: 2.1686, place: "Барселона" } },
  ],
  relations: [
    { id: "r-own-dom", from: "org-example", to: "dom-example", kind: "owns" },
    { id: "r-sub-api", from: "dom-example", to: "sub-api", kind: "subdomain" },
    { id: "r-sub-mail", from: "dom-example", to: "sub-mail", kind: "subdomain" },
    { id: "r-sub-vpn", from: "dom-example", to: "sub-vpn", kind: "subdomain" },
    { id: "r-sub-dev", from: "dom-example", to: "sub-dev", kind: "subdomain" },
    { id: "r-res-10", from: "dom-example", to: "host-10", kind: "resolves" },
    { id: "r-res-21", from: "sub-api", to: "host-21", kind: "resolves" },
    { id: "r-res-34", from: "sub-dev", to: "host-34", kind: "resolves" },
    { id: "r-run-443", from: "host-10", to: "svc-443", kind: "runs" },
    { id: "r-run-22", from: "host-21", to: "svc-22", kind: "runs" },
    { id: "r-own-admin", from: "dom-example", to: "email-admin", kind: "owns" },
    { id: "r-link-persona", from: "org-example", to: "ph-jdoe", kind: "linked", label: "персона стенда" },
    { id: "r-acct-dev", from: "ph-jdoe", to: "email-dev", kind: "account" },
    { id: "r-acct-gh", from: "ph-jdoe", to: "user-gh", kind: "account" },
    { id: "r-acct-gl", from: "ph-jdoe", to: "user-gl", kind: "account" },
    { id: "r-acct-mast", from: "ph-jdoe", to: "user-mast", kind: "account" },
    { id: "r-geo-jdoe", from: "ph-jdoe", to: "geo-tag", kind: "located" },
  ],
  findings: [
    { id: "F-0501", sourceToolId: "theharvester", title: "Найдено 4 поддомена example.com", entityId: "dom-example", severity: "info", confidence: 0.95 },
    { id: "F-0502", sourceToolId: "theharvester", title: "Собраны 2 почты домена (admin@, dev@)", entityId: "dom-example", severity: "low", confidence: 0.9 },
    { id: "F-0503", sourceToolId: "shodan", title: "203.0.113.10: открыт 443/tcp (nginx)", entityId: "host-10", severity: "low", confidence: 0.97 },
    { id: "F-0504", sourceToolId: "shodan", title: "203.0.113.21: устаревший баннер OpenSSH", entityId: "host-21", severity: "medium", confidence: 0.8, note: "Версию из баннера стоит обновить" },
    { id: "F-0505", sourceToolId: "shodan", title: "Геолокация 3 хостов по geo-IP", target: "203.0.113.0/24", severity: "info", confidence: 0.6 },
    { id: "F-0506", sourceToolId: "sherlock", title: "labuser найден на GitHub, GitLab, Mastodon", entityId: "ph-jdoe", severity: "info", confidence: 0.7 },
    { id: "F-0507", sourceToolId: "holehe", title: "dev@example.com зарегистрирован на 2 сервисах", entityId: "email-dev", severity: "low", confidence: 0.75 },
    { id: "F-0508", sourceToolId: "recon-ng", title: "Рабочий граф наполнен по example.com", entityId: "dom-example", severity: "info", confidence: 0.8 },
    { id: "F-0509", sourceToolId: "spiderfoot", title: "Граф: org → домен → 4 поддомена → 3 хоста", entityId: "org-example", severity: "info", confidence: 0.85 },
    { id: "F-0510", sourceToolId: "geocreepy", title: "Открытая геометка персоны labuser", entityId: "geo-tag", severity: "info", confidence: 0.5 },
    { id: "F-0511", sourceToolId: "maltego", title: "Связь организация ↔ домен ↔ персона", entityId: "org-example", severity: "info", confidence: 0.7 },
  ],
};
