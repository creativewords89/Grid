// App-wide signals between screens that don't share state.

/** Fired after something may have changed the number of waiting reviews. */
export const REVIEWS_CHANGED = "gr:reviews-changed";

export function reviewsChanged() {
  window.dispatchEvent(new Event(REVIEWS_CHANGED));
}

/** Answers the person asked were reviewed (detail: their ids and conversations). */
export const ANSWERS_CHANGED = "gr:answers-changed";

/** A file's status changed (for the Documents screen). */
export const FILES_CHANGED = "gr:files-changed";

export type AnswersChanged = { id: string; conversation_id: string | null }[];
