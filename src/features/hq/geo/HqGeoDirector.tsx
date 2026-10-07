"use client";

import { useRef, useState } from "react";
import { Camera, Download, Play, Plus, Trash2, Upload, X } from "lucide-react";
import * as CesiumNS from "cesium";

import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import {
  cameraToFrame,
  newTour,
  playTour,
  tourFromJson,
  tourToJson,
  type DirectorFrame,
  type DirectorPlayHandle,
  type DirectorTour,
} from "./director";

export type HqGeoDirectorProps = {
  viewer: CesiumNS.Viewer | null;
};

/**
 * «Режиссёр» — the cinematic-tour recorder/player. The owner builds a tour by
 * stepping through the globe and pressing «Кадр» at each view; the toolbar
 * lists the frames; «Воспроизвести» flies them in sequence. Tours export as
 * JSON and import back from a file. See director.ts for the engine.
 */
export function HqGeoDirector({ viewer }: HqGeoDirectorProps) {
  const [open, setOpen] = useState(false);
  const [tour, setTour] = useState<DirectorTour>(() => newTour("Мой тур"));
  const [caption, setCaption] = useState("");
  const [seconds, setSeconds] = useState(3);
  const [playing, setPlaying] = useState<string | null>(null);
  const [playingNow, setPlayingNow] = useState(false);
  const handleRef = useRef<DirectorPlayHandle | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const addFrame = () => {
    if (!viewer) return;
    const frame = cameraToFrame(viewer, seconds, caption.trim() || undefined);
    setTour((t) => ({ ...t, frames: [...t.frames, frame] }));
    setCaption("");
  };

  const dropFrame = (i: number) => setTour((t) => ({ ...t, frames: t.frames.filter((_, k) => k !== i) }));

  const play = () => {
    if (!viewer || !tour.frames.length) return;
    handleRef.current?.stop();
    setPlayingNow(true);
    const h = playTour(viewer, tour, (i, f) => {
      setPlaying(f?.caption ?? null);
      if (i === -1) setPlayingNow(false);
    });
    handleRef.current = h;
  };

  const stop = () => {
    handleRef.current?.stop();
    handleRef.current = null;
    setPlaying(null);
    setPlayingNow(false);
  };

  const exportJson = () => {
    const blob = new Blob([tourToJson(tour)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tour.name.replace(/\s+/g, "-")}.tour.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importJson = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const next = tourFromJson(text);
    if (next) setTour(next);
    ev.target.value = "";
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`h-8 px-2.5 font-mono text-[11px] ${hqHudButtonClass(open)}`}
        title="Режиссёр: запиши кадры и воспроизведи их как кино-тур"
      >
        <Camera className="mr-1 inline h-3.5 w-3.5" />
        Режиссёр
      </button>
      {open ? (
        <div className={`absolute left-3 top-40 z-10 w-[320px] overflow-hidden ${HQ_HUD_GLASS}`}>
          <header className="flex items-center justify-between border-b border-white/10 bg-black/60 px-3 py-2">
            <input
              value={tour.name}
              onChange={(ev) => setTour((t) => ({ ...t, name: ev.target.value }))}
              className="h-6 w-40 bg-transparent px-1 font-mono text-[11px] text-amber-200 focus:outline-none"
              aria-label="Название тура"
            />
            <button type="button" onClick={() => setOpen(false)} aria-label="Закрыть" className="text-white/60 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 bg-black/40 px-2 py-1.5">
            <input
              value={caption}
              onChange={(ev) => setCaption(ev.target.value)}
              placeholder="подпись (необязательно)"
              className="h-7 flex-1 bg-transparent px-1 font-mono text-[11px] text-white placeholder:text-white/35 focus:outline-none"
            />
            <input
              type="number"
              min={0.5}
              max={30}
              step={0.5}
              value={seconds}
              onChange={(ev) => setSeconds(Math.max(0.5, Math.min(30, Number(ev.target.value) || 3)))}
              className="h-7 w-14 bg-transparent px-1 font-mono text-[11px] text-white focus:outline-none"
              title="Секунд полёта к этому кадру"
            />
            <button
              type="button"
              onClick={addFrame}
              className="h-7 rounded border border-amber-500/50 bg-amber-500/15 px-2 font-mono text-[10px] uppercase tracking-[0.1em] text-amber-200"
              title="Записать текущий вид как кадр"
            >
              <Plus className="mr-1 inline h-3 w-3" />
              Кадр
            </button>
          </div>
          <ul className="max-h-[240px] divide-y divide-white/5 overflow-y-auto">
            {tour.frames.length === 0 ? (
              <li className="px-3 py-3 font-mono text-[10px] text-white/55">
                Кадров нет. Поставь камеру и нажми «Кадр».
              </li>
            ) : (
              tour.frames.map((f, i) => <TourFrameRow key={i} index={i} frame={f} onDrop={() => dropFrame(i)} />)
            )}
          </ul>
          <footer className="flex flex-wrap items-center gap-1 border-t border-white/10 bg-black/40 px-2 py-1.5">
            {playingNow ? (
              <button
                type="button"
                onClick={stop}
                className="h-7 flex-1 rounded border border-red-500/50 bg-red-500/15 px-2 font-mono text-[10px] uppercase tracking-[0.1em] text-red-200"
              >
                Стоп
              </button>
            ) : (
              <button
                type="button"
                onClick={play}
                disabled={tour.frames.length === 0}
                className="h-7 flex-1 rounded border border-emerald-500/50 bg-emerald-500/15 px-2 font-mono text-[10px] uppercase tracking-[0.1em] text-emerald-200 disabled:opacity-40"
              >
                <Play className="mr-1 inline h-3 w-3" />
                Воспроизвести
              </button>
            )}
            <button
              type="button"
              onClick={exportJson}
              disabled={tour.frames.length === 0}
              className="h-7 rounded border border-white/10 bg-white/5 px-2 font-mono text-[10px] uppercase tracking-[0.1em] text-white/80 disabled:opacity-40"
              title="Сохранить тур в JSON"
            >
              <Download className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="h-7 rounded border border-white/10 bg-white/5 px-2 font-mono text-[10px] uppercase tracking-[0.1em] text-white/80"
              title="Открыть тур из JSON"
            >
              <Upload className="h-3 w-3" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(ev) => void importJson(ev)}
            />
          </footer>
          {playing ? (
            <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-1.5 font-mono text-[10px] text-amber-200">
              {playing}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function TourFrameRow({ index, frame, onDrop }: { index: number; frame: DirectorFrame; onDrop: () => void }) {
  return (
    <li className="flex items-start gap-2 px-3 py-2 font-mono text-[10px]">
      <span className="w-6 shrink-0 text-white/40">#{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-white/80">{frame.caption || "— без подписи —"}</div>
        <div className="truncate text-white/40">
          φ {frame.lat.toFixed(2)}° λ {frame.lon.toFixed(2)}° · {Math.round(frame.height / 1000)} км · {frame.seconds}s
        </div>
      </div>
      <button type="button" onClick={onDrop} aria-label={`Удалить кадр ${index + 1}`} className="shrink-0 text-white/40 hover:text-red-300">
        <Trash2 className="h-3 w-3" />
      </button>
    </li>
  );
}
