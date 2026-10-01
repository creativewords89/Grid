import { usePortal } from '../../context.js';
import { dateTime } from '../../lib/format.js';
import { pendingReviews, reviewsOf } from '../../lib/reviews.js';
import { REVIEW_TXT } from '../../lib/tasks.js';
import useReview from './useReview.js';

function useOpen() {
	const { setProject, setView } = usePortal();
	return (x) => {
		setProject(x.project_id);
		setView(x.tab);
	};
}

// "Waiting for your review" (SPEC.md 6.6): not dismissable, Accept / Revise / Reject.
export function WaitingForReview() {
	const { data } = usePortal();
	const decide = useReview();
	const open = useOpen();
	const list = pendingReviews(data);
	if (!list.length) return null;
	const name = (id) => (data.members[id] ? data.members[id].name : 'Someone');
	return (
		<section className="nt-card rv-card">
			<div className="nt-head">
				<span>Waiting for your review</span>
				<em>{list.length}</em>
				<span className="muted">stays here until accepted, revised or rejected</span>
			</div>
			<ul className="nt-list">
				{list.map((x) => (
					<li key={x.kind + x.id}>
						<span className="nt-ico k-hours" aria-hidden="true">
							✓
						</span>
						<div className="nt-body">
							<div className="nt-title">
								<b>{name(x.review.submittedBy)}</b> completed <b>“{x.title}”</b>
							</div>
							<div className="nt-meta">
								<span>{data.projects[x.project_id].name}</span>
								<span>{x.where}</span>
								<span>{dateTime(x.review.submittedAt)}</span>
							</div>
							{x.completion && (
								<div className="rv-comp">
									“{x.completion.note}”
									{x.completion.link && /^https?:\/\//.test(x.completion.link) && (
										<>
											{' · '}
											<a href={x.completion.link} target="_blank" rel="noopener noreferrer">
												link
											</a>
										</>
									)}
								</div>
							)}
						</div>
						<div className="nt-acts">
							<button type="button" className="linkbtn" onClick={() => open(x)}>
								Open
							</button>
							<button type="button" className="btn small primary" onClick={() => decide(x.kind, x.id, 'accept')}>
								Accept
							</button>
							<button type="button" className="btn small" onClick={() => decide(x.kind, x.id, 'revision')}>
								Revise
							</button>
							<button type="button" className="btn small danger-soft" onClick={() => decide(x.kind, x.id, 'reject')}>
								Reject
							</button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

// "Reviews of your work" (My tasks): revision requests and rejections with the reviewer's note.
export function ReviewsOfWork({ memberId, self }) {
	const { data } = usePortal();
	const open = useOpen();
	const list = reviewsOf(data, memberId);
	if (!list.length) return null;
	const name = (id) => (data.members[id] ? data.members[id].name : '');
	return (
		<section className="nt-card rv-mine">
			<div className="nt-head">
				<span>{self ? 'Reviews of your work' : 'Reviews'}</span>
				<em>{list.length}</em>
			</div>
			<ul className="nt-list">
				{list.map((x, i) => (
					<li key={i}>
						<span className={'nt-ico ' + (x.review.state === 'rejected' ? 'k-warn' : x.review.state === 'revision' ? 'k-extra' : 'k-hours')} aria-hidden="true">
							{x.review.state === 'rejected' ? '✕' : x.review.state === 'revision' ? '↻' : '…'}
						</span>
						<div className="nt-body">
							<div className="nt-title">
								<span className={'rv-tag rv-t-' + x.review.state}>{REVIEW_TXT[x.review.state]}</span> <b>{x.title}</b>
							</div>
							<div className="nt-meta">
								<span>{data.projects[x.project_id].name}</span>
								{x.where && <span>{x.where}</span>}
								{x.review.state !== 'pending' && name(x.review.by) && <span>by {name(x.review.by)}</span>}
								{x.review.note && <span className="rv-note-i">“{x.review.note}”</span>}
							</div>
						</div>
						<div className="nt-acts">
							<button type="button" className="linkbtn" onClick={() => open(x)}>
								Open
							</button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
