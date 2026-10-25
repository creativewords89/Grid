import { usePortal } from '../../context.js';
import { ago, waitTitle } from '../../lib/feed.js';
import { short } from '../../lib/format.js';
import { fmtMinutes } from '../../lib/reports.js';
import { leaveRules, overBy, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import useReview from '../review/useReview.js';

// "within the year's allowance" / "2 days over, deducted" for a pending request (SPEC.md 6.10).
function overText(data, leave) {
	const over = overBy(data.members[leave.member_id], leave, rowsOf(data, 'leave'), teamWeekly(data), rowsOf(data, 'days_off'), leaveRules(data));
	return { text: over > 0 ? `${over} day${over === 1 ? '' : 's'} over the allowance, deducted` : 'within the year’s allowance', over: over > 0 };
}

// One request as in design NF-C, without descriptions: a coloured icon, one sentence (who and what;
// the task opens from it), when, and the buttons. Notes, reasons and completion text are on the
// task's page and in the answer dialog.
function Row({ item, tone, icon, title, onOpen, children }) {
	return (
		<div className="ap-item ap-row">
			<span className={'nf-ic t-' + tone} aria-hidden="true">
				{icon}
			</span>
			<span className="ap-l1">
				{onOpen ? (
					<button type="button" className="ap-title" onClick={onOpen} title={title}>
						{title}
					</button>
				) : (
					<b className="ap-title" title={title}>
						{title}
					</b>
				)}
				<small>{item.at ? ago(item.at) : ''}</small>
			</span>
			<div className="ap-acts">{children}</div>
		</div>
	);
}

// One thing waiting for a Team Leader or the Super Admin, with its buttons (SPEC.md 7.0, designs
// NF-C, compact rows): shown under Waiting for you in Notifications.
export function ApprovalItem({ item }) {
	const { api, data, dispatch, toast, confirm, setProject, setSearch, setView } = usePortal();
	const decide = useReview();
	const go = (projectId, title, tab) => () => (setProject(projectId), title && setSearch(title), setView(tab));

	// Someone asked to undo In progress (SPEC.md 6.6): Undo (back to Not started) or Keep.
	if (item.kind === 'undo') {
		const answer = async (action) => {
			const note = await confirm({
				title: action === 'undo' ? 'Undo to Not started?' : 'Keep In progress?',
				message: `“${item.title}” · ${item.project.name}${item.undo.reason ? ` — “${item.undo.reason}”` : ''}`,
				input: 'Message (optional)',
				ok: action === 'undo' ? 'Undo' : 'Keep In progress',
			});
			if (note === null || note === false) return;
			const body = { action, note: typeof note === 'string' ? note : '' };
			try {
				if (item.item) dispatch({ type: 'upsert', table: 'meeting_tasks', row: await api.post(`meeting-tasks/${item.item.id}/undo/decide`, body) });
				else {
					const res = await api.post('records/undo/decide', { ...body, taskId: item.task.id, periodKey: item.record.period_key });
					if (res.record) dispatch({ type: 'upsert', table: 'records', row: res.record });
					else dispatch({ type: 'remove', table: 'records', id: res.id });
				}
				toast(action === 'undo' ? 'Undone — back to Not started' : 'Kept In progress');
			} catch (err) {
				toast(err.message);
			}
		};
		return (
			<Row item={item} tone="amber" icon="↶" title={waitTitle(item)} onOpen={go(item.project.id, item.title, item.tab)}>
				<button type="button" className="btn small ok-btn" onClick={() => answer('undo')}>
					Undo
				</button>
				<button type="button" className="btn small" onClick={() => answer('keep')}>
					Keep In progress
				</button>
			</Row>
		);
	}

	// Someone asked to untick a keyword box (SPEC.md 6.12): Untick, or Keep ticked.
	if (item.kind === 'untick') {
		const { kw, col, project } = item;
		const answer = async (body, done) => {
			try {
				dispatch({ type: 'upsert', table: 'keywords', row: await api.patch(`keywords/${kw.id}`, body) });
				toast(done);
			} catch (err) {
				toast(err.message);
			}
		};
		return (
			<Row item={item} tone="amber" icon="☐" title={waitTitle(item)} onOpen={go(project.id, '', 'plan')}>
				<button type="button" className="btn small danger-soft" onClick={() => answer({ check: { column: col.id, on: false } }, 'Unticked')}>
					Untick
				</button>
				<button type="button" className="btn small" onClick={() => answer({ keep: { column: col.id } }, 'Kept ticked')}>
					Keep ticked
				</button>
			</Row>
		);
	}

	if (item.kind === 'report_change') {
		const c = item.change;
		const lines = (c.entries || []).map((e) => `${e.title} ${fmtMinutes(e.from)} → ${fmtMinutes(e.to)}`).join(' · ');
		const answer = async (action) => {
			const message = await confirm({
				title: action === 'approve' ? `Approve ${item.who.name}’s change?` : `Reject ${item.who.name}’s change?`,
				message: `${short(c.day)} · ${fmtMinutes(c.from_minutes)} → ${fmtMinutes(c.to_minutes)} · ${lines}${c.reason ? ` · “${c.reason}”` : ''}`,
				input: 'Message (optional)',
				placeholder: action === 'approve' ? 'e.g. Fixed' : 'Why not',
				ok: action === 'approve' ? 'Approve' : 'Reject',
				danger: action === 'reject',
			});
			if (message === null) return;
			try {
				dispatch({ type: 'upsert', table: 'report_changes', row: await api.patch(`report-changes/${c.id}`, { action, message }) });
				toast(action === 'approve' ? 'Change approved — the report and salary are updated' : 'Change rejected');
			} catch (err) {
				toast(err.message);
			}
		};
		return (
			<Row item={item} tone="blue" icon="⏱" title={waitTitle(item)}>
				<button type="button" className="btn small ok-btn" onClick={() => answer('approve')}>
					Approve
				</button>
				<button type="button" className="btn small danger-soft" onClick={() => answer('reject')}>
					Reject
				</button>
			</Row>
		);
	}

	if (item.kind === 'leave') {
		const l = item.leave;
		const range = l.from_date === l.to_date ? short(l.from_date) : `${short(l.from_date)} – ${short(l.to_date)}`;
		const info = overText(data, l);
		const kind = l.type === 'sick' ? 'Sick leave' : 'Casual leave';
		const answer = async (action) => {
			const message = await confirm({
				title: action === 'approve' ? `Approve ${item.who.name}’s leave?` : `Reject ${item.who.name}’s leave?`,
				message: `${kind} · ${range} (${l.days} day${l.days === 1 ? '' : 's'}) · ${info.text}${l.reason ? ` · “${l.reason}”` : ''}`,
				input: 'Message (optional)',
				placeholder: action === 'approve' ? 'e.g. Enjoy the wedding!' : 'Why not',
				ok: action === 'approve' ? 'Approve' : 'Reject',
				danger: action === 'reject',
			});
			if (message === null) return;
			try {
				dispatch({ type: 'upsert', table: 'leave', row: await api.patch(`leave/${l.id}`, { action, message }) });
				toast(action === 'approve' ? 'Leave approved' : 'Leave rejected');
			} catch (err) {
				toast(err.message);
			}
		};
		return (
			<Row item={item} tone="green" icon="✚" title={waitTitle(item)}>
				<button type="button" className="btn small ok-btn" onClick={() => answer('approve')}>
					Approve
				</button>
				<button type="button" className="btn small danger-soft" onClick={() => answer('reject')}>
					Reject
				</button>
			</Row>
		);
	}

	const r = item.review;
	return (
		<Row item={item} tone="blue" icon="✓" title={waitTitle(item)} onOpen={go(r.project_id, r.title, r.tab)}>
			<button type="button" className="btn small ok-btn" onClick={() => decide(r.kind, r.id, 'accept')}>
				Approve
			</button>
			<button type="button" className="btn small danger-soft" onClick={() => decide(r.kind, r.id, 'revision')}>
				Send back
			</button>
		</Row>
	);
}
