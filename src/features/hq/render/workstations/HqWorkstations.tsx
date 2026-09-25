"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, type MutableRefObject, type ReactNode } from "react";
import { HQ_WORKSTATION_URL } from "@/features/hq/core/config";
import type { HqSimulation } from "@/features/hq/core/sim";
import type { HqLayout } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { DeskStatusCache, WorkstationBatchSet } from "./batches";
import { createProceduralWorkstation, extractGlbWorkstation, type WorkstationSource } from "./geometry";
import { createWorkstationMaterials, type WorkstationMaterials } from "./materials";

export type HqWorkstationsProps = {
  layout: HqLayout;
  simRef: MutableRefObject<HqSimulation | null>;
  quality: HqQuality;
};

type BatchProps = HqWorkstationsProps & {
  source: WorkstationSource;
  materials: WorkstationMaterials;
  cache: DeskStatusCache;
};

/**
 * Every desk of the layout (AM7's desk excluded; the props module owns it):
 * desk, metal, chair, screens, LED strips and glass as instanced batches.
 * workstation.glb supplies the meshes; until it loads, or if it is missing,
 * procedural stand-ins with the same material groups keep the floor furnished.
 */
export function HqWorkstations({ layout, simRef, quality }: HqWorkstationsProps) {
  const materials = useMemo(() => createWorkstationMaterials(), []);
  const procedural = useMemo(() => createProceduralWorkstation(), []);
  const cache = useMemo(() => new DeskStatusCache(layout.desks.length), [layout.desks]);

  useEffect(() => () => materials.dispose(), [materials]);
  useEffect(() => () => procedural.dispose(), [procedural]);
  useEffect(() => materials.setQuality(quality), [materials, quality]);

  useFrame((state) => materials.setTime(state.clock.elapsedTime));

  if (layout.desks.length === 0) return null;

  const shared = { layout, simRef, quality, materials, cache };
  const fallback = <WorkstationBatches {...shared} source={procedural} />;
  return (
    <WorkstationAssetBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <GlbWorkstations {...shared} />
      </Suspense>
    </WorkstationAssetBoundary>
  );
}

function GlbWorkstations(props: Omit<BatchProps, "source">) {
  // No Draco or meshopt: the production CSP blocks their WebAssembly decoders.
  const { scene } = useGLTF(HQ_WORKSTATION_URL, false, false);
  const source = useMemo(() => extractGlbWorkstation(scene), [scene]);
  useEffect(() => () => source.dispose(), [source]);
  return <WorkstationBatches {...props} source={source} />;
}

function WorkstationBatches({ layout, simRef, quality, source, materials, cache }: BatchProps) {
  const batches = useMemo(
    () => new WorkstationBatchSet(layout.desks, source, materials, cache),
    [layout.desks, source, materials, cache],
  );
  useEffect(() => () => batches.dispose(), [batches]);
  useEffect(() => batches.setQuality(quality), [batches, quality]);

  useFrame((state) => {
    batches.update(state.camera, state.size.height, state.clock.elapsedTime, simRef.current?.deskStatus ?? null);
  });

  return <primitive object={batches.root} />;
}

type BoundaryProps = { fallback: ReactNode; children: ReactNode };

/** A missing or broken workstation.glb falls back to the procedural desks. */
class WorkstationAssetBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("HQ workstation.glb unavailable; drawing procedural desks.", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
