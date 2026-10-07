"use client";

import { useState } from "react";
import { Eraser, Mic, PenLine, Square, X } from "lucide-react";

import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import { geoController } from "./geoController";
import { useVoiceCapture } from "./useVoiceCapture";
import { parseWhiteboardCommand, type WhiteboardAction } from "./whiteboard";

const WHITEBOARD_KIND = "whiteboard" as const;

/**
 * «Доска» — voice (or text) whiteboard. The owner (or an agent) says a short
 * command — «отметь Москву», «нарисуй дугу от Москвы до Берлина», «очисти
 * доску» — and the globe gains a pin or arc through geoController. All pins
 * and arcs created here carry a kind="whiteboard" tag so «очисти» removes only
 * these, not scope or OSINT entities. Pure data commands (whiteboard.ts) +
 * useVoiceCapture (STT) + geoController.
 */
export function HqGeoWhiteboard() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [log, setLog] = useState<Array<{ cmd: string; result: string }>>([]);
  const [lastPinId, setLastPinId] = useState<string | null>(null);

  const apply = (action: WhiteboardAction, raw: string): string => {
    switch (action.type) {
      case "pin": {
        const target = geoController.addTarget({ lat: action.lat, lon: action.lon, label: action.label, kind: WHITEBOARD_KIND });
        setLastPinId(target.id);
        return `Пин: ${action.label} (${action.lat.toFixed(2)}°, ${action.lon.toFixed(2)}°)`;
      }
      case "arc": {
        const arc = geoController.addArc(action.from, action.to, "engagement", `${action.from.label} → ${action.to.label}`);
        if (!arc) return "Не смог нарисовать дугу (цели не найдены).";
        return `Дуга: ${action.from.label} → ${action.to.label}`;
      }
      case "relabel-last": {
        if (!lastPinId) return "Нет точки для подписи — сначала «отметь …».";
        const scene = geoController.getScene();
        const existing = scene.targets.find((t) => t.id === lastPinId);
        if (!existing) return "Точка исчезла — не могу переподписать.";
        geoController.addTarget({ ...existing, label: action.label });
        return `Переподписано: ${action.label}`;
      }
      case "clear": {
        const scene = geoController.getScene();
        geoController.setTargets(scene.targets.filter((t) => t.kind !== WHITEBOARD_KIND));
        setLastPinId(null);
        return "Доска очищена.";
      }
      default:
        return `Не понял: «${raw}».`;
    }
  };

  const run = (raw: string) => {
    const action = parseWhiteboardCommand(raw);
    const result = action ? apply(action, raw) : `Не понял: «${raw}». Пример: отметь Москву; дугу от Москвы до Берлина.`;
    setLog((prev) => [{ cmd: raw, result }, ...prev].slice(0, 8));
    setText("");
  };

  const capture = useVoiceCapture({ onTranscript: (t) => run(t) });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`h-8 px-2.5 font-mono text-[11px] ${hqHudButtonClass(open)}`}
        title="Голосовая доска: отметь город, нарисуй дугу между городами"
      >
        <PenLine className="mr-1 inline h-3.5 w-3.5" />
        Доска
      </button>
      {open ? (
        <div className={`absolute right-3 bottom-28 z-10 w-[320px] overflow-hidden ${HQ_HUD_GLASS}`}>
          <header className="flex items-center justify-between border-b border-white/10 bg-black/60 px-3 py-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200">
              Голосовая доска
            </span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Закрыть" className="text-white/60 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              if (text.trim()) run(text.trim());
            }}
            className="flex items-center gap-1.5 border-b border-white/10 bg-black/40 px-2 py-1.5"
          >
            <input
              value={text}
              onChange={(ev) => setText(ev.target.value)}
              placeholder="отметь Москву…"
              className="h-7 flex-1 bg-transparent px-1.5 font-mono text-[11px] text-white placeholder:text-white/35 focus:outline-none"
            />
            <button
              type="button"
              onPointerDown={() => void capture.start()}
              onPointerUp={() => void capture.stop()}
              onPointerLeave={() => {
                if (capture.state === "recording") void capture.stop();
              }}
              className={`flex h-7 w-7 items-center justify-center rounded border font-mono text-[10px] ${
                capture.state === "recording"
                  ? "border-red-500/60 bg-red-500/20 text-red-100"
                  : "border-white/15 bg-white/5 text-white/80 hover:border-white/30"
              }`}
              title="Удерживай для голоса"
              aria-label="Голосовая команда"
            >
              {capture.state === "recording" ? <Square className="h-3 w-3" /> : <Mic className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => run("очисти доску")}
              className="flex h-7 w-7 items-center justify-center rounded border border-white/15 bg-white/5 text-white/70 hover:border-white/30 hover:text-white"
              title="Очистить доску"
              aria-label="Очистить доску"
            >
              <Eraser className="h-3.5 w-3.5" />
            </button>
          </form>
          {capture.error ? (
            <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-1 font-mono text-[10px] text-red-200">
              Голос: {capture.error}
            </div>
          ) : null}
          {log.length === 0 ? (
            <div className="px-3 py-3 font-mono text-[10px] text-white/55">
              Примеры: «отметь Москву», «нарисуй дугу от Москвы до Берлина», «подпиши точку АГЕНТ-07», «очисти доску».
            </div>
          ) : (
            <ul className="max-h-[220px] divide-y divide-white/5 overflow-y-auto">
              {log.map((entry, i) => (
                <li key={i} className="px-3 py-1.5 font-mono text-[10px]">
                  <div className="truncate text-white/60">« {entry.cmd}»</div>
                  <div className="truncate text-white/90">{entry.result}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
}
