import { usePortal } from '../../context.js';

// The fields the server takes from the submission form.
export const submission = ({ note, links, files, comment, reviewer }) => ({ note, links, files, comment, ...(reviewer ? { reviewer } : {}) });

// Status, progress and delete for meeting tasks. Each write stores the row the server
// returns; errors become toasts with the server's message.
export default function useTaskActions() {
	const { api, dispatch, toast, confirm, askCompletion } = usePortal();
	const save = (row) => dispatch({ type: 'upsert', table: 'meeting_tasks', row });

	const setStatus = async (task, to) => {
		if (task.status === to) return;
		let body = { status: to };
		// Everyone fills in the submission form (SPEC.md 6.6, design SF-A).
		if (to === 'done') {
			const sub = await askCompletion(task.title);
			if (!sub) return;
			body = { ...body, ...submission(sub) };
		}
		try {
			const row = await api.post(`meeting-tasks/${task.id}/status`, body);
			save(row);
			toast(to === 'done' ? (row.review && row.review.state === 'pending' ? 'Sent for review' : 'Marked completed') : to === 'doing' ? 'In progress' : 'Back to Not started');
		} catch (err) {
			toast(err.message);
		}
	};

	const tick = async (task, memberId, delta) => {
		// The last unit completes the task: everyone fills in the submission (SPEC.md 6.6).
		let extra = {};
		const target = Math.max(1, task.target || 1);
		const total = Object.values(task.progress || {}).reduce((a, b) => a + b, 0);
		if (delta > 0 && total + 1 >= target && task.status !== 'done') {
			const sub = await askCompletion(task.title);
			if (!sub) return;
			extra = submission(sub);
		}
		try {
			const row = await api.post(`meeting-tasks/${task.id}/progress`, { memberId: memberId || '', delta, ...extra });
			save(row);
			const total = Object.values(row.progress || {}).reduce((a, b) => a + b, 0);
			if (row.status === 'done' && task.status !== 'done') toast(row.review && row.review.state === 'pending' ? 'All done — sent for review' : 'All done — completed');
			else toast(`${total}/${row.target} done`);
		} catch (err) {
			toast(err.message);
		}
	};

	const remove = async (task) => {
		const ok = await confirm({ title: 'Delete this task?', message: `“${task.title}” is removed from the board. You can undo this for 30 days.`, ok: 'Delete', danger: true });
		if (!ok) return;
		try {
			const res = await api.del(`meeting-tasks/${task.id}`);
			dispatch({ type: 'remove', table: 'meeting_tasks', id: task.id });
			// Show it in Recently deleted now, not at the next sync.
			if (res.trash) dispatch({ type: 'upsert', table: 'trash', row: res.trash });
			toast('Task deleted', {
				action: {
					label: 'Undo',
					run: async () => {
						try {
							save(await api.post(`trash/${res.trash_id}/restore`));
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

	// Request undo (SPEC.md 6.6): a Team Member who moved a task to In progress by mistake.
	const requestUndo = async (task) => {
		const reason = await confirm({
			title: 'Request undo',
			message: `“${task.title}” · In progress → Not started. A Team Leader or the Super Admin decides; you’ll get a notice with the answer.`,
			input: 'What was the mistake, and why undo it?',
			placeholder: 'e.g. I moved the wrong card — I haven’t started this one yet.',
			ok: 'Send request',
		});
		if (reason === null || reason === false) return;
		try {
			save(await api.post(`meeting-tasks/${task.id}/undo`, { reason }));
			toast('Undo requested — a Team Leader or the Super Admin will answer');
		} catch (err) {
			toast(err.message);
		}
	};

	// Team Leader / Super Admin: Undo (back to Not started) or Keep In progress. The card's Review
	// panel passes the message; without one, ask for it.
	const decideUndo = async (task, action, message) => {
		const note =
			typeof message === 'string'
				? message
				: await confirm({
						title: action === 'undo' ? 'Undo to Not started?' : 'Keep In progress?',
						message: `“${task.title}” · ${task.undo_request && task.undo_request.reason ? `“${task.undo_request.reason}”` : ''}`,
						input: 'Message (optional)',
						ok: action === 'undo' ? 'Undo' : 'Keep In progress',
					});
		if (note === null || note === false) return;
		try {
			save(await api.post(`meeting-tasks/${task.id}/undo/decide`, { action, note: typeof note === 'string' ? note : '' }));
			toast(action === 'undo' ? 'Undone — back to Not started' : 'Kept In progress');
		} catch (err) {
			toast(err.message);
		}
	};

	return { setStatus, tick, remove, requestUndo, decideUndo };
}
