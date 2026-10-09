// App-wide signals between screens that don't share state.

/** Fired after something may have changed the number of waiting reviews. */
export const REVIEWS_CHANGED = "gr:reviews-changed";

export function reviewsChanged() {
  window.dispatchEvent(new Event(REVIEWS_CHANGED));
}
