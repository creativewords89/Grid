import { usePortal } from '../../context.js';

const STATE = { accept: 'accepted', revision: 'revision', reject: 'rejected' };

// Accept / revise / reject. The decision shows immediately (optimistic); the server's row
// replaces it, or the old row comes back with an error toast.
export default function useReview() {
	const { api, data, dispatch, toast, confirm, me } = usePortal();

	return async function decide(kind, id, action) {
		const table = kind === 'item' ? 'meeting_tasks' : 'records';
		const before = data[table][id];
		if (!before) return;

		let note = '';
		if (action !== 'accept') {
			note = await confirm({
				title: action === 'reject' ? 'Reject this work?' : 'Ask for a revision?',
				message: action === 'reject' ? 'The task goes back to To do and the completed units are removed from their report.' : 'The task goes back to In progress so they can fix it.',
				input: action === 'reject' ? 'Reason' : 'What needs changing',
				placeholder: action === 'reject' ? "Why it's not accepted" : 'e.g. add the city name to the H1',
				ok: action === 'reject' ? 'Reject' : 'Request revision',
				danger: action === 'reject',
			});
			if (note === null) return;
			if (!note) return toast('Add a short note so they know what to do.');
		}

		dispatch({ type: 'upsert', table, row: { ...before, review: { ...(before.review || {}), state: STATE[action], by: me.id, note } } });
		try {
			const row = await api.post('review', { kind, id, action, note });
			dispatch({ type: 'upsert', table, row });
			toast(action === 'accept' ? 'Accepted' : action === 'reject' ? 'Rejected — sent back' : 'Revision requested');
		} catch (err) {
			dispatch({ type: 'upsert', table, row: before });
			toast(err.message);
		}
	};
}
