import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { isAdmin, isManager } from '../../lib/roles.js';
import Avatar from '../Avatar.jsx';

export const STATUS = { pending: ['Waiting', 'f-amber'], approved: ['Approved', 'f-green'], rejected: ['Not approved', 'f-red'], cancelled: ['Cancelled', 'f-plain'] };
export const TYPE = { day: 'Day leave', sick: 'Sick leave' };

export const rangeText = (l) => (l.from_date === l.to_date ? short(l.from_date) : `${short(l.from_date)} – ${short(l.to_date)}`);

// What the viewer may do with a leave row (the server checks again, SPEC.md section 3).
export function leaveActions(l, me, owner) {
	const role = owner ? owner.role : '';
	const own = l.member_id === me.id;
	const out = [];
	if (l.status === 'pending' && isManager(me) && role === 'member') out.push('approve', 'reject');
	// A Team Leader may also cancel a day off they issued (SPEC.md 6.10).
	const cancel = isAdmin(me) || (me.role === 'lead' ? own || role === 'member' || l.created_by === me.id : own && l.status === 'pending');
	if ((l.status === 'pending' || l.status === 'approved') && cancel) out.push('cancel');
	return out;
}

// Approve / reject (optional message) / cancel a leave row.
export function useLeaveAction() {
	const { api, dispatch, toast, confirm, data } = usePortal();
	return async (l, action) => {
		const who = data.members[l.member_id];
		const name = who ? who.name : 'their';
		const message = await confirm({
			title: action === 'approve' ? `Approve ${name}’s leave?` : action === 'reject' ? `Reject ${name}’s leave?` : 'Cancel this leave?',
			message: `${TYPE[l.type] || 'Leave'} · ${rangeText(l)} (${l.days} day${l.days === 1 ? '' : 's'})${l.reason ? ` · “${l.reason}”` : ''}`,
			input: action === 'cancel' ? undefined : 'Message (optional)',
			ok: action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : 'Cancel leave',
			danger: action !== 'approve',
		});
		if (message === null || message === false) return;
		try {
			const row = await api.patch(`leave/${l.id}`, { action, message: typeof message === 'string' ? message : '' });
			dispatch({ type: 'upsert', table: 'leave', row });
			toast(action === 'approve' ? 'Leave approved' : action === 'reject' ? 'Leave rejected' : 'Leave cancelled');
		} catch (err) {
			toast(err.message);
		}
	};
}

const LABEL = { approve: 'Approve', reject: 'Reject', cancel: 'Cancel' };

// One row of a leave table.
export function LeaveRow({ l, showPerson }) {
	const { data, me } = usePortal();
	const act = useLeaveAction();
	const owner = data.members[l.member_id];
	const by = data.members[l.decided_by];
	const [st, cls] = STATUS[l.status] || [l.status, 'f-plain'];
	return (
		<tr>
			{showPerson && (
				<td>
					<span className="mt-who">
						<Avatar person={owner} small />
						<b>{owner ? owner.name : '—'}</b>
					</span>
				</td>
			)}
			<td>{TYPE[l.type] || '—'}</td>
			<td>{rangeText(l)}</td>
			<td>{l.days}</td>
			<td>
				<span className={'mp-flag ' + cls}>{st}</span>
			</td>
			<td>
				{by && l.decided_by !== l.member_id ? by.name : <span className="muted">—</span>}
				{l.message && <div className="muted">“{l.message}”</div>}
				{l.reason && <div className="muted">Reason: {l.reason}</div>}
			</td>
			<td className="mt-acts">
				{leaveActions(l, me, owner).map((a) => (
					<button key={a} type="button" className={'linkbtn' + (a === 'approve' ? '' : ' danger')} onClick={() => act(l, a)}>
						{LABEL[a]}
					</button>
				))}
			</td>
		</tr>
	);
}

export function LeaveTable({ rows, showPerson, empty }) {
	if (!rows.length) return <p className="d-empty">{empty}</p>;
	return (
		<div className="tbl-wrap">
			<table className="hrs mtable">
				<thead>
					<tr>
						{showPerson && <th>Person</th>}
						<th>Type</th>
						<th>Dates</th>
						<th>Days</th>
						<th>Status</th>
						<th>Decided by</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{rows.map((l) => (
						<LeaveRow key={l.id} l={l} showPerson={showPerson} />
					))}
				</tbody>
			</table>
		</div>
	);
}

// CSV download of a table (`rows` are arrays of cells; the first row is the header).
export function downloadCsv(name, rows) {
	const cell = (v) => {
		const s = String(v ?? '');
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Prints only the element with the given id (see .printing styles).
export function printOnly(id) {
	const el = document.getElementById(id);
	if (!el) return;
	el.classList.add('print-me');
	document.body.classList.add('printing');
	const done = () => {
		el.classList.remove('print-me');
		document.body.classList.remove('printing');
		window.removeEventListener('afterprint', done);
	};
	window.addEventListener('afterprint', done);
	window.print();
}
