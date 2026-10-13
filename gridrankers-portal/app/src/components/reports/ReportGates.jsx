import { usePortal } from '../../context.js';
import { addDays } from '../../lib/cycles.js';
import { dayTitle } from '../../lib/reports.js';
import Modal from '../Modal.jsx';
import ReportEditor from './ReportEditor.jsx';

// Before you sign out (SPEC.md 6.18, design DR-D): on a working day, Sign out first asks for
// today's report. "Send report and sign out" needs at least one entry; "Sign out for now" is for a
// break — the report is still due by the evening.
export function SignOutDialog({ open, onClose, onSignOut, dueText }) {
	const { reports } = usePortal();
	const state = reports.state;
	return (
		<Modal open={open} onClose={onClose} className="dr-dlg dr-gate-dlg" labelledBy="drOutTitle">
			{open && state && (
				<div className="dr-gate">
					<div className="dr-gate-h">
						<span className="dr-gate-ic" aria-hidden="true">
							📝
						</span>
						<div>
							<h2 id="drOutTitle">Before you sign out</h2>
							<p className="muted">Send today’s report — what you did today.</p>
						</div>
						<button type="button" className="dr-x" aria-label="Close" onClick={onClose}>
							×
						</button>
					</div>
					<ReportEditor
						day={state.today}
						report={state.report}
						onSaved={reports.update}
						compact
						sendLabel="Send report and sign out"
						onSent={() => {
							onClose();
							onSignOut();
						}}
					/>
					<p className="dr-gate-alt">
						Taking a break?{' '}
						<button type="button" className="linkbtn" onClick={() => (onClose(), onSignOut())}>
							Sign out for now
						</button>{' '}
						— the report is still due by {dueText}
					</p>
				</div>
			)}
		</Modal>
	);
}

// A missing report (design DR-D): someone closed the browser instead of signing out. The next time
// they open the portal they send it (marked Late) before anything else. Days off and leave never ask.
export function MissingReport({ onSignOut }) {
	const { reports } = usePortal();
	const state = reports.state;
	const day = state.missing;
	const yesterday = addDays(state.today, -1) === day;
	return (
		<div className="dr-missing" role="main">
			<div className="dr-missing-card">
				<span className="dr-gate-ic big" aria-hidden="true">
					⏰
				</span>
				<h1>{yesterday ? 'Yesterday’s report is missing' : 'A report is missing'}</h1>
				<p className="muted">{dayTitle(day)}. Write what you did before you continue — it will be marked Late.</p>
				<ReportEditor key={day} day={day} report={state.missing_report} onSaved={reports.update} compact sendLabel={yesterday ? 'Send yesterday’s report' : 'Send the report'} onSent={reports.reload} />
				<p className="muted dr-gate-alt">
					Not needed on days off or approved leave.{' '}
					<button type="button" className="linkbtn" onClick={onSignOut}>
						Sign out
					</button>
				</p>
			</div>
		</div>
	);
}
