import { usePortal } from '../../context.js';
import { submission } from '../meeting/useTaskActions.js';

// Ticks and status moves on a recurring task's period record, plus delete with Undo.
export default function useRecordActions() {
	const { api, dispatch, toast, confirm, askCompletion } = usePortal();

	const store = (res) => {
		if (res.record) dispatch({ type: 'upsert', table: 'records', row: res.record });
		else dispatch({ type: 'remove', table: 'records', id: res.id });
		return res.record;
	};

	const tick = async (task, periodKey, delta, who = {}) => {
		try {
			const body = { taskId: task.id, periodKey, delta, ...who };
			let res;
			try {
				res = await api.post('records/tick', body);
			} catch (err) {
				// The last unit completes the task: everyone fills in the submission (SPEC.md 6.6).
				if (err.code !== 'grp_completion_required') throw err;
				const sub = await askCompletion(task.title);
				if (!sub) return;
				res = await api.post('records/tick', { ...body, ...submission(sub) });
			}
			const rec = store(res);
			const n = Math.max(1, task.target || 1);
			toast(rec && rec.status === 'done' ? (rec.review && rec.review.state === 'pending' ? 'All done — sent for review' : 'All done') : `${rec ? rec.count : 0}/${n} done`);
		} catch (err) {
			toast(err.message);
		}
	};

	// Steps (SPEC.md 6.16): one step of this period moves by one unit.
	const tickStep = async (task, periodKey, row, delta) => {
		try {
			const body = { taskId: task.id, periodKey, step: row.id, delta };
			let res;
			try {
				res = await api.post('records/step', body);
			} catch (err) {
				// The last unit of the last step completes the task: the submission first (SPEC.md 6.6).
				if (err.code !== 'grp_completion_required') throw err;
				const sub = await askCompletion(task.title);
				if (!sub) return;
				res = await api.post('records/step', { ...body, ...submission(sub) });
			}
			const rec = store(res);
			if (rec && rec.status === 'done') toast(rec.review && rec.review.state === 'pending' ? 'All steps done — sent for review' : 'All steps done');
			else toast(delta > 0 ? `${row.name}: ${row.target > 1 ? `${row.n + 1}/${row.target}` : 'done'}${row.next ? ` — ready for ${row.next.name}` : ''}` : `${row.name}: counted back`);
		} catch (err) {
			toast(err.message);
		}
	};

	const setStatus = async (task, periodKey, to) => {
		let body = { taskId: task.id, periodKey, status: to };
		if (to === 'done') {
			const sub = await askCompletion(task.title);
			if (!sub) return;
			body = { ...body, ...submission(sub) };
		}
		try {
			const rec = store(await api.post('records/status', body));
			toast(to === 'done' ? (rec && rec.review && rec.review.state === 'pending' ? 'Sent for review' : 'Completed') : to === 'skipped' ? 'Skipped' : to === 'doing' ? 'In progress' : 'Reset to not started');
		} catch (err) {
			toast(err.message);
		}
	};

	// Request undo (SPEC.md 6.6) on a period a Team Member moved to In progress by mistake.
	const requestUndo = async (task, periodKey) => {
		const reason = await confirm({
			title: 'Request undo',
			message: `“${task.title}” · In progress → Not started. A Team Leader or the Super Admin decides; you’ll get a notice with the answer.`,
			input: 'What was the mistake, and why undo it?',
			placeholder: 'e.g. I started the wrong task — I haven’t begun this one yet.',
			ok: 'Send request',
		});
		if (reason === null || reason === false) return;
		try {
			store(await api.post('records/undo', { taskId: task.id, periodKey, reason }));
			toast('Undo requested — a Team Leader or the Super Admin will answer');
		} catch (err) {
			toast(err.message);
		}
	};

	const decideUndo = async (task, periodKey, action, why, message) => {
		const note =
			typeof message === 'string'
				? message
				: await confirm({
						title: action === 'undo' ? 'Undo to Not started?' : 'Keep In progress?',
						message: `“${task.title}”${why ? ` · “${why}”` : ''}`,
						input: 'Message (optional)',
						ok: action === 'undo' ? 'Undo' : 'Keep In progress',
					});
		if (note === null || note === false) return;
		try {
			store(await api.post('records/undo/decide', { taskId: task.id, periodKey, action, note: typeof note === 'string' ? note : '' }));
			toast(action === 'undo' ? 'Undone — back to Not started' : 'Kept In progress');
		} catch (err) {
			toast(err.message);
		}
	};

	const remove = async (task) => {
		const ok = await confirm({ title: 'Delete this monthly task?', message: `“${task.title}” is removed from every cycle. You can undo this for 30 days.`, ok: 'Delete', danger: true });
		if (!ok) return;
		try {
			const res = await api.del(`monthly-tasks/${task.id}`);
			dispatch({ type: 'remove', table: 'monthly_tasks', id: task.id });
			// Show it in Recently deleted now, not at the next sync.
			if (res.trash) dispatch({ type: 'upsert', table: 'trash', row: res.trash });
			toast('Task deleted', {
				action: {
					label: 'Undo',
					run: async () => {
						try {
							dispatch({ type: 'upsert', table: 'monthly_tasks', row: await api.post(`trash/${res.trash_id}/restore`) });
							dispatch({ type: 'remove', table: 'trash', id: res.trash_id });
							toast(`“${task.title}” restored`);
						} catch (err) {
							toast(err.message);
						}
					},
				},
			});
		} catch (err) {
			toast(err.message);
		}
	};

	return { tick, tickStep, setStatus, remove, requestUndo, decideUndo };
}
