import type { DuplicateDetails } from "../api";
import { Markdown } from "./Markdown";
import { Modal } from "./ui";

/** SPEC 6.9: before adding a verified answer that repeats an existing one, ask. */
export function DuplicatePrompt({
  details,
  onChoose,
  onClose,
}: {
  details: DuplicateDetails;
  onChoose: (choice: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Update the existing verified answer instead?" onClose={onClose}>
      <div className="stack">
        <p className="muted">The team already verified an answer to this question:</p>
        <div className="card stack">
          <strong>{details.question}</strong>
          <Markdown text={details.answer} />
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => onChoose("new")}>
            Add as a new one
          </button>
          <button
            type="button"
            className="button button-primary"
            autoFocus
            onClick={() => onChoose(`update:${details.id}`)}
          >
            Update the existing one
          </button>
        </div>
      </div>
    </Modal>
  );
}
