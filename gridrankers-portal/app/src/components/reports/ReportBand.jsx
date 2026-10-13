import { useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { after } from '../../lib/reports.js';
import { fmtDue } from './DailyReports.jsx';

// The reminder on My day (SPEC.md 6.18): from 5 pm on a working day until today's report is sent —
// amber, red once it's past the due time. Write report opens Daily reports.
export default function ReportBand() {
	const { reports, setView, viewOnly } = usePortal();
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const t = window.setInterval(() => setNow(new Date()), 60 * 1000);
		return () => window.clearInterval(t);
	}, []);
	const st = reports.state;
	if (viewOnly || !st || !st.writes || st.out_today || (st.report && st.report.sent_at) || !after(now, st.remind_from)) return null;
	const late = after(now, st.due);
	return (
		<div className={'dr-band' + (late ? ' late' : '')} role="status">
			<span aria-hidden="true">📝</span>
			<span className="dr-band-t">
				<b>Today’s report isn’t sent yet</b> · {late ? `it was due by ${fmtDue(st.due)}` : `due by ${fmtDue(st.due)}`}
			</span>
			<button type="button" className="btn small" onClick={() => setView('reports')}>
				Write report
			</button>
		</div>
	);
}
