/**
 * The task board's cap on cards made automatically from agent activity.
 *
 * Every agent run becomes a card (source "openclaw_event"), and inferred
 * cards come from chat activity; with a live team that is thousands of cards
 * an hour. Uncapped, the board (and the copy saved with the studio settings)
 * grew to tens of thousands of cards and tens of megabytes, and every event,
 * render and save slowed down with it. Automatic cards are therefore capped,
 * keeping active cards first and then the most recently updated. Cards made by
 * a person or a playbook are never dropped.
 *
 * Shared by the board's reducer (client) and the settings normalizer (server),
 * so an oversized saved board is trimmed on its next read as well.
 */

export const MAX_AUTOMATIC_TASK_CARDS = 600;

type CappableCard = {
  source: string;
  isInferred: boolean;
  isArchived: boolean;
  updatedAt: string;
};

export const isAutomaticTaskCard = (card: CappableCard): boolean =>
  card.isInferred || card.source === "openclaw_event" || card.source === "fallback_inferred";

/**
 * For cards already in board order (active before archived, newest first):
 * every non-automatic card and the first `max` automatic ones.
 */
export function capSortedAutomaticCards<T extends CappableCard>(sorted: T[], max = MAX_AUTOMATIC_TASK_CARDS): T[] {
  let automatic = 0;
  for (const card of sorted) if (isAutomaticTaskCard(card)) automatic += 1;
  if (automatic <= max) return sorted;
  let kept = 0;
  return sorted.filter((card) => !isAutomaticTaskCard(card) || (kept += 1) <= max);
}

/**
 * For cards in any order: keeps the `max` best automatic cards (active first,
 * then newest) and every other card, in their original order.
 */
export function capAutomaticTaskCards<T extends CappableCard>(cards: T[], max = MAX_AUTOMATIC_TASK_CARDS): T[] {
  const automatic: Array<{ index: number; archived: number; time: number }> = [];
  cards.forEach((card, index) => {
    if (isAutomaticTaskCard(card)) {
      automatic.push({ index, archived: card.isArchived ? 1 : 0, time: Date.parse(card.updatedAt) || 0 });
    }
  });
  if (automatic.length <= max) return cards;
  automatic.sort((a, b) => a.archived - b.archived || b.time - a.time);
  const keep = new Set<number>();
  for (let i = 0; i < max; i++) keep.add(automatic[i].index);
  return cards.filter((card, index) => !isAutomaticTaskCard(card) || keep.has(index));
}
