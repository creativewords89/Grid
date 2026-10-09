import type { AnswerStatus } from "./api";

// Names for answer statuses in lists (SPEC sections 6.8 and 7.5).
export const STATUS_NAMES: Record<AnswerStatus, string> = {
  auto: "Answered",
  in_review: "In review",
  needs_info: "Needs info",
  verified: "Verified",
  corrected: "Corrected",
  wrong_no_answer: "No answer known",
};
