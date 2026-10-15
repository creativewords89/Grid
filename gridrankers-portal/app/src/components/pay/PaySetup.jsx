import { usePortal } from '../../context.js';
import PayForm from './PayForm.jsx';

// Set up your work and pay (SPEC.md 6.19, design PAY-1): a Team Leader or Team Member who hasn't
// set their working hours, salary and payment details sees only this page — the server refuses
// every change until they have.
export default function PaySetup({ onSignOut }) {
	const { me, pay } = usePortal();
	return (
		<div className="pay-setup" role="main">
			<div className="pay-setup-card">
				<div className="pay-setup-top">
					<b>GridRankers</b>
					<span className="muted">
						{me.name} ·{' '}
						<button type="button" className="linkbtn" onClick={onSignOut}>
							Sign out
						</button>
					</span>
				</div>
				<div>
					<h1>Set up your work and pay</h1>
					<p className="muted">
						Fill these in once to start using the portal. You can change them later in <b>Daily reports → Payment information</b>.
					</p>
				</div>
				<PayForm pay={pay.state && pay.state.pay} onSaved={pay.update} submitLabel="Save and continue" />
			</div>
		</div>
	);
}
