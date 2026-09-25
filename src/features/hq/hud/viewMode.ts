/**
 * Which office the screen shows. The HQ is the only view offered: the classic
 * retro office no longer has a switch in the UI (it could not carry a team of
 * hundreds of agents), and a choice stored by older builds is ignored.
 */

export type OfficeViewMode = "hq" | "classic";

const noop = (): void => {};

export function useOfficeViewMode(): [OfficeViewMode, (mode: OfficeViewMode) => void] {
  return ["hq" as OfficeViewMode, noop];
}
