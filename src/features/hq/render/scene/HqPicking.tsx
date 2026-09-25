"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Raycaster, Vector2 } from "three";

import type { HqSimulation } from "../../core/sim";

/** What picking tells the HUD's hover card; implemented outside the Canvas. */
export type HqHoverSink = {
  show: (agentId: string, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  hide: () => void;
};

// Try the torso first (what the eye aims at), then the feet: from a 38°
// camera a click on a chest lands ~1.3 m behind the agent on the floor.
const PICK_HEIGHTS = [1.0, 0.1];
const PICK_RADII = [0.42, 0.5];
// A press that travels further than this is a pan, not a click.
const CLICK_SLOP_PX = 5;

const _ndc = new Vector2();
const _raycaster = new Raycaster();

/**
 * Agent picking without scene raycasts: the ray from the pointer meets a
 * horizontal plane and the sim finds the nearest agent there. Hover runs once
 * per frame (agents walk under a still pointer too), writes only to refs and
 * the canvas cursor, and never sets React state.
 */
export function HqPicking({
  simRef,
  hoveredIdRef,
  hoverSinkRef,
  onSelect,
  onFocus,
}: {
  simRef: MutableRefObject<HqSimulation | null>;
  hoveredIdRef: MutableRefObject<string | null>;
  hoverSinkRef: MutableRefObject<HqHoverSink | null>;
  onSelect: (agentId: string) => void;
  onFocus: (agentId: string) => void;
}) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const pointer = useRef({ inside: false, moved: false, x: 0, y: 0, w: 1, h: 1, downX: 0, downY: 0, down: false });
  const callbacks = useRef({ onSelect, onFocus });

  useEffect(() => {
    callbacks.current.onSelect = onSelect;
    callbacks.current.onFocus = onFocus;
  });

  const pickAt = (x: number, y: number, w: number, h: number): string | null => {
    const sim = simRef.current;
    if (!sim || w <= 0 || h <= 0) return null;
    _ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    _raycaster.setFromCamera(_ndc, camera);
    const { origin, direction } = _raycaster.ray;
    if (direction.y > -1e-4) return null;
    for (let i = 0; i < PICK_HEIGHTS.length; i += 1) {
      const t = (PICK_HEIGHTS[i] - origin.y) / direction.y;
      if (t <= 0) continue;
      const index = sim.pick(origin.x + direction.x * t, origin.z + direction.z * t, PICK_RADII[i]);
      if (index >= 0) return sim.frame.ids[index] ?? null;
    }
    return null;
  };

  useEffect(() => {
    const element = gl.domElement;
    const state = pointer.current;
    const read = (event: PointerEvent | MouseEvent) => {
      state.x = event.offsetX;
      state.y = event.offsetY;
      state.w = element.clientWidth;
      state.h = element.clientHeight;
    };
    const onMove = (event: PointerEvent) => {
      read(event);
      state.inside = true;
      state.moved = true;
    };
    const onLeave = () => {
      state.inside = false;
      state.down = false;
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      read(event);
      state.down = true;
      state.downX = state.x;
      state.downY = state.y;
    };
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0 || !state.down) return;
      state.down = false;
      read(event);
      if (Math.hypot(state.x - state.downX, state.y - state.downY) > CLICK_SLOP_PX) return;
      const id = pickAt(state.x, state.y, state.w, state.h);
      if (id) callbacks.current.onSelect(id);
    };
    const onDoubleClick = (event: MouseEvent) => {
      read(event);
      const id = pickAt(state.x, state.y, state.w, state.h);
      if (id) callbacks.current.onFocus(id);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerleave", onLeave);
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("dblclick", onDoubleClick);
    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("dblclick", onDoubleClick);
      element.style.cursor = "";
    };
    // pickAt reads refs and the stable camera only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);

  useFrame(() => {
    const state = pointer.current;
    const sink = hoverSinkRef.current;
    const previous = hoveredIdRef.current;
    // No hover while dragging: the pointer is steering the camera.
    const id = state.inside && !state.down ? pickAt(state.x, state.y, state.w, state.h) : null;
    if (id !== previous) {
      hoveredIdRef.current = id;
      gl.domElement.style.cursor = id ? "pointer" : "";
      if (id) sink?.show(id, state.x, state.y);
      else sink?.hide();
    } else if (id && state.moved) {
      sink?.move(state.x, state.y);
    }
    state.moved = false;
  });

  return null;
}
