import type { AnswerStatus, ReviewState } from "./api";

// Names for answer statuses in lists (SPEC sections 6.8 and 7.5).
export const STATUS_NAMES: Record<AnswerStatus, string> = {
  auto: "Answered",
  in_review: "In review",
  needs_info: "Needs info",
  verified: "Verified",
  corrected: "Corrected",
  wrong_no_answer: "No answer known",
};

export const REVIEW_STATES: Record<ReviewState, string> = {
  open: "Waiting",
  claimed: "Claimed",
  needs_info: "Waiting for the asker",
  approved: "Approved",
  edited: "Corrected",
  rejected: "Rejected",
  cancelled: "Cancelled",
};
