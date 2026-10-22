import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { dayTitle, seesTeamReports, summary, teamTotals, writesReports } from '../../lib/reports.js';
import { mayDecideLeave } from '../../lib/leaveBoard.js';
import { rowsOf } from '../../lib/store.js';
import PersonReports from './PersonReports.jsx';
import ReportEditor from './ReportEditor.jsx';
import TeamReports from './TeamReports.jsx';
import PaySheet from '../pay/PaySheet.jsx';
import PaymentInfo from '../pay/PaymentInfo.jsx';
import SalaryMonth from '../pay/SalaryMonth.jsx';
import Holidays from '../holidays/Holidays.jsx';

// Daily reports (SPEC.md 6.18), in the sidebar for everyone. Tabs (SPEC.md 6.19, 6.20): Reports,
// Salary, Payment information and Holidays. Under Reports, Team Leaders and Team Members get My reports
// (today's report, design DR-A; earlier ones on the day bar, DR-C); the Super Admin and Team Leaders
// get Team (everyone's report for a day, DR-B). Salary is your own month (PAY-3), or the Super
// Admin's pay sheet (PAY-4); Payment information is your pay and payment details (PAY-2); Holidays is
// the calendar of festival holidays and leave (HOL-1, HOL-2). A Team Leader, who has their own
// report, pay and leave and also a team, gets the tabs in two groups (design TL-B): Mine (My reports,
// Salary, Payment information, My holidays) and My team (Team reports, Team holidays, each with how
// many wait for them).
export default function DailyReports() {
	const { api, data, me } = usePortal();
	const writes = writesReports(me);
	const team = seesTeamReports(me);
	const admin = me.role === 'admin';
	const grouped = writes && team;
	const [area, setArea] = useState('reports');
	const [person, setPerson] = useState(null);
	// Team reports not sent today, for the My team badge.
	const [missing, setMissing] = useState(0);
	useEffect(() => {
		if (!grouped) return undefined;
		let live = true;
		api
			.get('daily-reports/team')
			.then((r) => live && setMissing(teamTotals((r.people || []).filter((p) => p.member_id !== me.id && data.members[p.member_id])).missing))
			.catch(() => {});
		return () => {
			live = false;
		};
		// Once per visit to the page, and again after leaving a person's reports.
	}, [api, grouped, person]);
	// The Team tab puts its ‹ day › on the right of this row (design TR-G1, date on the right).
	const [slot, setSlot] = useState(null);

	if (person) {
		return <PersonReports memberId={person} onBack={() => setPerson(null)} backLabel="Team reports" />;
	}

	if (grouped) {
		const waiting = rowsOf(data, 'leave').filter((l) => mayDecideLeave(l, me, data)).length;
		const Tab = ({ k, label, n }) => (
			<button type="button" role="tab" aria-selected={area === k} onClick={() => setArea(k)}>
				{label}
				{n ? <span className="dr-n">{n}</span> : null}
			</button>
		);
		return (
			<div className="dr">
				<div className="dr-top">
					<div className="dr-group">
						<span className="dr-group-k" id="drMine">
							Mine
						</span>
						<div className="pay-areas" role="tablist" aria-labelledby="drMine">
							<Tab k="reports" label="My reports" />
							<Tab k="salary" label="Salary" />
							<Tab k="payment" label="Payment information" />
							<Tab k="holidays" label="My holidays" />
						</div>
					</div>
					<span className="dr-group-sep" aria-hidden="true" />
					<div className="dr-group">
						<span className="dr-group-k" id="drTeam">
							My team
						</span>
						<div className="pay-areas" role="tablist" aria-labelledby="drTeam">
							<Tab k="team" label="Team reports" n={missing} />
							<Tab k="teamHolidays" label="Team holidays" n={waiting} />
						</div>
					</div>
					<div className="dr-top-end" ref={setSlot} />
				</div>
				{area === 'salary' ? (
					<SalaryMonth />
				) : area === 'payment' ? (
					<PaymentInfo />
				) : area === 'holidays' ? (
					<Holidays key="mine" slot={slot} scope="mine" />
				) : area === 'teamHolidays' ? (
					<Holidays key="team" slot={slot} scope="team" />
				) : area === 'team' ? (
					<TeamReports onOpenPerson={setPerson} slot={slot} />
				) : (
					<MyReports />
				)}
			</div>
		);
	}

	const areas = [['reports', 'Reports'], ['salary', 'Salary'], ...(admin ? [] : [['payment', 'Payment information']]), ['holidays', 'Holidays']];
	return (
		<div className="dr">
			<div className="dr-top">
				<div className="pay-areas" role="tablist" aria-label="Daily reports and pay">
					{areas.map(([k, label]) => (
						<button key={k} type="button" role="tab" aria-selected={area === k} onClick={() => setArea(k)}>
							{label}
						</button>
					))}
				</div>
				<div className="dr-top-end" ref={setSlot} />
			</div>
			{area === 'salary' ? admin ? <PaySheet /> : <SalaryMonth /> : area === 'payment' ? <PaymentInfo /> : area === 'holidays' ? <Holidays slot={slot} /> : team ? <TeamReports onOpenPerson={setPerson} slot={slot} /> : <MyReports />}
		</div>
	);
}

// Today's report (design DR-A), or earlier reports on the day bar.
function MyReports() {
	const { me, reports } = usePortal();
	const [earlier, setEarlier] = useState(false);
	const sendRef = useRef(null);
	const state = reports.state;

	if (earlier) {
		return <PersonReports memberId={me.id} onBack={() => setEarlier(false)} backLabel="Today" />;
	}
	if (!state) {
		return <p className="empty">Loading…</p>;
	}
	const report = state.report;
	const sent = !!(report && report.sent_at);
	const off = state.out_today;
	return (
		<div className="dr-mine">
			<div className="dr-head">
				<div>
					<div className="dr-kicker">Daily report · {dayTitle(state.today)}</div>
					<h2 className="dr-title">Today</h2>
				</div>
				<button type="button" className="linkbtn dr-earlier" onClick={() => setEarlier(true)}>
					Earlier reports ›
				</button>
				<button type="button" className="btn primary dr-send-top" onClick={() => sendRef.current && sendRef.current()}>
					{sent ? 'Update report' : 'Send report'}
				</button>
			</div>
			<div className="dr-status">
				{sent ? (
					<span className="dr-st ok">Sent {sentTime(report.sent_at)}</span>
				) : off ? (
					<span className="dr-st mute">{off === 'leave' ? 'You’re on leave today — no report needed.' : 'Day off — no report needed.'}</span>
				) : (
					<span className="dr-st warn">
						<b>Not sent</b> · due {fmtDue(state.due)}
					</span>
				)}
				<span className="dr-sum">{summary(report ? report.entries : [])}</span>
			</div>
			<ReportEditor key={state.today} day={state.today} report={report} onSaved={reports.update} hideSend sendRef={sendRef} />
		</div>
	);
}

// "19:00" → "7:00 pm".
export function fmtDue(hhmm) {
	const [h, m] = String(hhmm || '19:00').split(':').map(Number);
	return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// A sent time (UTC from the server) as the local time of day.
export function sentTime(at) {
	if (!at) return '';
	const d = new Date(String(at).replace(' ', 'T') + 'Z');
	return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
