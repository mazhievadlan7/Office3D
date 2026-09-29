import Image from "next/image";
import { useMemo } from "react";
import { accentForSeed, type AgentAvatarProfile } from "@/lib/avatars/profile";
import {
  AGENT_BADGE_ACCENT_COLORS,
  agentBadgeImageFor,
  callsignInitials,
} from "@/lib/avatars/badge";
import { t } from "@/lib/i18n";

type AgentAvatarProps = {
  seed: string;
  name: string;
  avatarProfile?: AgentAvatarProfile | null;
  /** The agent's own picture from its identity; shown instead of the badge. */
  avatarUrl?: string | null;
  size?: number;
  isSelected?: boolean;
};

/** Below this size the callsign mark would be unreadable; the ring alone identifies. */
const MIN_SIZE_FOR_MARK = 36;

/**
 * The agent's chat badge: the HQ android's portrait inside a ring in the
 * agent's accent colour, with its callsign mark (lib/avatars/badge.ts).
 */
export const AgentAvatar = ({
  seed,
  name,
  avatarProfile,
  avatarUrl,
  size = 112,
  isSelected = false,
}: AgentAvatarProps) => {
  const customUrl = avatarUrl?.trim() || null;
  const accentId = avatarProfile?.accent ?? accentForSeed(seed);
  const accent = AGENT_BADGE_ACCENT_COLORS[accentId];
  const initials = useMemo(() => callsignInitials(name), [name]);
  const ring = Math.max(1.5, Math.round(size / 24));
  const showMark = !customUrl && initials && size >= MIN_SIZE_FOR_MARK;

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-full bg-[#050303] transition-transform duration-300 ${isSelected ? "agent-avatar-selected scale-[1.02]" : ""}`}
      style={{
        width: size,
        height: size,
        // Replaces .agent-avatar-selected's primary-coloured halo with the accent's.
        boxShadow: `${isSelected ? `0 0 0 2px ${accent}5c, ` : ""}0 0 ${Math.round(size / 5)}px ${accent}33`,
      }}
      data-accent={accentId}
    >
      <Image
        className="pointer-events-none h-full w-full select-none object-cover"
        src={customUrl ?? agentBadgeImageFor(size)}
        alt={t("avatar.alt", { name })}
        width={size}
        height={size}
        unoptimized
        draggable={false}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{ boxShadow: `inset 0 0 0 ${ring}px ${accent}` }}
      />
      {showMark ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-[9%] flex justify-center"
        >
          <span
            className="rounded-[3px] bg-black/75 px-1 font-mono font-semibold uppercase leading-none tracking-[0.08em] text-white"
            style={{
              fontSize: Math.max(8, Math.round(size / 5.2)),
              paddingTop: 2,
              paddingBottom: 2,
              boxShadow: `0 0 0 1px ${accent}99`,
            }}
          >
            {initials}
          </span>
        </span>
      ) : null}
    </div>
  );
};
