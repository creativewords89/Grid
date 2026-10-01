import { usePortal } from '../../context.js';
import { isManager } from '../../lib/roles.js';
import useReview from './useReview.js';

// Reviewer buttons in a Details window (reference reviewActions).
export default function ReviewActions({ kind, id, review, done }) {
	const { me } = usePortal();
	const decide = useReview();
	if (!isManager(me)) return null;
	if (review && review.state === 'pending') {
		return (
			<div className="dt-racts">
				<button type="button" className="btn small primary" onClick={() => decide(kind, id, 'accept')}>
					Accept
				</button>
				<button type="button" className="btn small" onClick={() => decide(kind, id, 'revision')}>
					Revise
				</button>
				<button type="button" className="btn small danger-soft" onClick={() => decide(kind, id, 'reject')}>
					Reject
				</button>
			</div>
		);
	}
	if (done) {
		return (
			<div className="dt-racts">
				<span className="muted">Reopen this completed task:</span>
				<button type="button" className="btn small" onClick={() => decide(kind, id, 'revision')}>
					Request revision
				</button>
				<button type="button" className="btn small danger-soft" onClick={() => decide(kind, id, 'reject')}>
					Reject
				</button>
			</div>
		);
	}
	return null;
}
