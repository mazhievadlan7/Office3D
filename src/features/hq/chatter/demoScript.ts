import type { ChatterInput } from "./types";

/**
 * The DEMO operations-chatter script for the боевой пульт: a short loop of
 * human-language lines between operatives and the orchestrator, authorized-recon
 * flavour against the same FICTIONAL demo scope as the OSINT seed (example.com,
 * 203.0.113.0/24 / TEST-NET-3). Readable, "как люди", callsigns, delegation.
 *
 * This is illustrative sample data — never a real person, org or target, and
 * nothing here is ever transmitted. Replace with the scope-enforced runtime's
 * real traffic through chatterController.post() later.
 */

/** Default operative callsigns (APT-style ops handles). */
export const DEMO_CALLSIGNS = ["WRAITH-07", "VECTOR-12", "GHOST-03", "CIPHER-05", "RAVEN-09"] as const;

/** The orchestrator's channel handle (scope / delegation / guardrails). */
const ORCHESTRATOR = "ОРК";

// Illustrative data-centre coordinates, matching the OSINT demo hosts.
const FRANKFURT = { lat: 50.1109, lon: 8.6821 };
const AMSTERDAM = { lat: 52.3676, lon: 4.9041 };
const WARSAW = { lat: 52.2297, lon: 21.0122 };

/**
 * Builds the ordered loop. Callsign slots are interpolated, so the narrative
 * (who found what, who takes it, who verifies) stays consistent even if the
 * runtime later supplies real agent callsigns.
 */
export function buildDemoScript(callsigns: readonly string[]): ChatterInput[] {
  const cs = (index: number): string => callsigns[index % callsigns.length] ?? DEMO_CALLSIGNS[index % DEMO_CALLSIGNS.length];
  const [a, b, c, d, e] = [cs(0), cs(1), cs(2), cs(3), cs(4)];

  return [
    { callsign: ORCHESTRATOR, kind: "status", text: "Scope подтверждён: работаем только по example.com и 203.0.113.0/24 (TEST-NET-3). Поехали." },
    { callsign: a, kind: "recon", text: "theHarvester по example.com — четыре поддомена, включая dev.example.com. Передаю на веб-проверку.", geo: FRANKFURT },
    { callsign: b, kind: "accept", text: "Беру dev.example.com. Риск высокий — захожу аккуратно, только пассив.", geo: FRANKFURT },
    { callsign: c, kind: "recon", text: "Shodan по 203.0.113.0/24 — три живых хоста, геолокацию отправил на глобус.", geo: AMSTERDAM },
    { callsign: c, kind: "finding", severity: "medium", text: "На 203.0.113.21 устаревший баннер OpenSSH. Оформляю находку, нужна верификация.", geo: AMSTERDAM },
    { callsign: e, kind: "verify", text: `Подтверждаю находку ${c}: баннер воспроизведён в песочнице. Статус — confirmed.`, geo: AMSTERDAM },
    { callsign: b, kind: "finding", severity: "low", text: "dev.example.com отдаёт слабые заголовки безопасности. Низкий приоритет, в отчёт.", geo: FRANKFURT },
    { callsign: d, kind: "recon", text: "holehe: dev@example.com засветился на двух сервисах. Чистый пассив, в графе разведки." },
    { callsign: a, kind: "delegate", text: `${e}, глянь 203.0.113.34 (files-lab) — похоже на открытый листинг каталога.`, geo: WARSAW },
    { callsign: e, kind: "accept", text: "Принял 203.0.113.34, смотрю. Деструктив не трогаю, scope держу.", geo: WARSAW },
    { callsign: ORCHESTRATOR, kind: "escalate", text: "Напоминание: внешние письма — только через оператора. Мы фиксируем находки, не действуем по целям." },
    { callsign: c, kind: "status", text: "Рейт-лимит в норме, цели отвечают стабильно, здоровье хостов ОК." },
  ];
}
