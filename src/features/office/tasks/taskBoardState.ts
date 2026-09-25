import {
  defaultTaskBoardPreference,
  type TaskBoardCard,
  type TaskBoardPreference,
  type TaskBoardStatus,
} from "@/features/office/tasks/types";

type TaskBoardAction =
  | { type: "hydrate"; preference: TaskBoardPreference }
  | { type: "upsert"; card: TaskBoardCard }
  | { type: "upsertMany"; cards: TaskBoardCard[] }
  | { type: "update"; cardId: string; patch: Partial<TaskBoardCard> }
  | { type: "move"; cardId: string; status: TaskBoardStatus }
  | { type: "remove"; cardId: string }
  | { type: "select"; cardId: string | null };

// Cards are compared many times per sort; parse each card's time once.
const cardTimes = new WeakMap<TaskBoardCard, number>();
const cardTime = (card: TaskBoardCard): number => {
  let time = cardTimes.get(card);
  if (time === undefined) {
    time = Date.parse(card.updatedAt) || 0;
    cardTimes.set(card, time);
  }
  return time;
};

const compareCards = (left: TaskBoardCard, right: TaskBoardCard) => {
  const leftArchived = left.isArchived ? 1 : 0;
  const rightArchived = right.isArchived ? 1 : 0;
  if (leftArchived !== rightArchived) return leftArchived - rightArchived;
  const leftAt = cardTime(left);
  const rightAt = cardTime(right);
  if (leftAt !== rightAt) return rightAt - leftAt;
  return left.title.localeCompare(right.title);
};

/**
 * Cards captured from agent activity (not made by a person) are capped, oldest
 * first, so a busy team cannot grow the board, and the copy saved with the
 * studio settings, without bound.
 */
export const MAX_INFERRED_TASK_CARDS = 300;

const capInferredCards = (sorted: TaskBoardCard[]): TaskBoardCard[] => {
  let inferred = 0;
  for (const card of sorted) if (card.isInferred) inferred += 1;
  if (inferred <= MAX_INFERRED_TASK_CARDS) return sorted;
  let kept = 0;
  return sorted.filter((card) => !card.isInferred || (kept += 1) <= MAX_INFERRED_TASK_CARDS);
};

export const sortTaskBoardCards = (cards: TaskBoardCard[]): TaskBoardCard[] =>
  capInferredCards([...cards].sort(compareCards));

// `cards` is kept sorted, so a card goes straight to its place.
const insertSorted = (cards: TaskBoardCard[], card: TaskBoardCard): TaskBoardCard[] => {
  let low = 0;
  let high = cards.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareCards(cards[mid], card) <= 0) low = mid + 1;
    else high = mid;
  }
  return [...cards.slice(0, low), card, ...cards.slice(low)];
};

export const upsertTaskBoardCard = (
  cards: TaskBoardCard[],
  nextCard: TaskBoardCard,
): TaskBoardCard[] => {
  const cardId = nextCard.id.trim();
  if (!cardId) return cards;
  const existingIndex = cards.findIndex((card) => card.id === cardId);
  const rest =
    existingIndex < 0 ? cards : [...cards.slice(0, existingIndex), ...cards.slice(existingIndex + 1)];
  return capInferredCards(insertSorted(rest, nextCard));
};

export const taskBoardReducer = (
  state: TaskBoardPreference = defaultTaskBoardPreference(),
  action: TaskBoardAction,
): TaskBoardPreference => {
  switch (action.type) {
    case "hydrate":
      return {
        cards: sortTaskBoardCards(action.preference.cards),
        selectedCardId: action.preference.selectedCardId,
      };
    case "upsert":
      return {
        ...state,
        cards: upsertTaskBoardCard(state.cards, action.card),
      };
    case "upsertMany": {
      if (action.cards.length === 0) return state;
      // Apply every card, then sort once.
      const byId = new Map(state.cards.map((card) => [card.id, card] as const));
      for (const card of action.cards) {
        const cardId = card.id.trim();
        if (cardId) byId.set(cardId, card);
      }
      return { ...state, cards: sortTaskBoardCards([...byId.values()]) };
    }
    case "update": {
      const existing = state.cards.find((card) => card.id === action.cardId);
      if (!existing) return state;
      return {
        ...state,
        cards: upsertTaskBoardCard(state.cards, {
          ...existing,
          ...action.patch,
          updatedAt: action.patch.updatedAt ?? new Date().toISOString(),
        }),
      };
    }
    case "move": {
      const existing = state.cards.find((card) => card.id === action.cardId);
      if (!existing) return state;
      return {
        ...state,
        cards: upsertTaskBoardCard(state.cards, {
          ...existing,
          status: action.status,
          updatedAt: new Date().toISOString(),
        }),
      };
    }
    case "remove": {
      const cards = state.cards.filter((card) => card.id !== action.cardId);
      return {
        cards,
        selectedCardId:
          state.selectedCardId === action.cardId ? cards[0]?.id ?? null : state.selectedCardId,
      };
    }
    case "select":
      return {
        ...state,
        selectedCardId: action.cardId,
      };
    default:
      return state;
  }
};
