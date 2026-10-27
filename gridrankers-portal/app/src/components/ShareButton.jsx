import { usePortal } from '../context.js';
import { copyText, taskLink } from '../lib/share.js';

// ↗ Share on a task card (design SHR-1B): copies a link to the task, to paste in any chat.
export default function ShareButton({ task }) {
	const { toast } = usePortal();
	const share = async () => {
		try {
			await copyText(taskLink(task.id));
			toast('Link copied — paste it in a chat');
		} catch (err) {
			toast('Couldn’t copy the link.');
		}
	};
	return (
		<button type="button" className="btn small share-btn" aria-label={`Share ${task.title}`} title="Copy a link to this task" onClick={share}>
			↗ Share
		</button>
	);
}
