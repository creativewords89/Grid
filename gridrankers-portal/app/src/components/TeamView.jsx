import { usePortal } from '../context.js';
import { isManager } from '../lib/roles.js';
import { pendingReviews, reviewsOf } from '../lib/reviews.js';
import { ReviewsOfWork, WaitingForReview } from './review/ReviewLists.jsx';

// Team area (admin/lead) or own page (member). Step 12 adds the dashboards; reviews live here.
export default function TeamView() {
	const { data, me } = usePortal();
	if (isManager(me)) {
		return (
			<div className="grp-team">
				<WaitingForReview />
				{!pendingReviews(data).length && <p className="empty">Nothing is waiting for your review.</p>}
			</div>
		);
	}
	return (
		<div className="grp-team">
			<ReviewsOfWork memberId={me.id} self />
			{!reviewsOf(data, me.id).length && <p className="empty">No reviews of your work in the last 30 days.</p>}
		</div>
	);
}
