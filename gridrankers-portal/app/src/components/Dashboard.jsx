import { useState } from 'react';
import { usePortal } from '../context.js';
import { isManager } from '../lib/roles.js';
import Approvals from './day/Approvals.jsx';
import DayHeader from './day/DayHeader.jsx';
import DayLeave from './day/Leave.jsx';
import MyProjects from './day/MyProjects.jsx';
import NeedsAttention, { useAttention } from './day/NeedsAttention.jsx';
import { AnnouncementDialog, ShoutoutDialog } from './day/PostDialogs.jsx';
import ProjectsBoard from './day/ProjectsBoard.jsx';
import { Shoutouts, WhosOut } from './day/Side.jsx';

const TAB_KEY = 'grp:dash-tab';

// Dashboard (SPEC.md 7.0): the landing page after sign-in. Everyone gets My day; the Super
// Admin and Team Leaders also get the Projects tab, Send shout-out and Post announcement.
export default function Dashboard({ onSignOut }) {
	const { me } = usePortal();
	const manager = isManager(me);
	const [tab, setTabState] = useState(() => {
		try {
			return window.sessionStorage.getItem(TAB_KEY) || 'day';
		} catch (e) {
			return 'day';
		}
	});
	const [dialog, setDialog] = useState(null);
	const items = useAttention();
	const setTab = (t) => {
		setTabState(t);
		try {
			window.sessionStorage.setItem(TAB_KEY, t);
		} catch (e) {
			/* not remembered */
		}
	};
	const current = manager ? tab : 'day';

	return (
		<div className="md">
			<DayHeader onSignOut={onSignOut} />
			{manager && (
				<div className="md-tabs">
					<div role="tablist" aria-label="Dashboard sections">
						<button type="button" role="tab" aria-selected={current === 'day'} onClick={() => setTab('day')}>
							My day
						</button>
						<button type="button" role="tab" aria-selected={current === 'projects'} onClick={() => setTab('projects')}>
							Projects {items.length > 0 && <span className="md-n">{items.length}</span>}
						</button>
					</div>
					<div className="md-acts">
						<button type="button" className="btn small" onClick={() => setDialog('shout')}>
							Send shout-out
						</button>
						<button type="button" className="btn small" onClick={() => setDialog('announce')}>
							Post announcement
						</button>
					</div>
				</div>
			)}
			{current === 'day' ? (
				<div className="md-grid">
					<div className="md-col">
						<MyProjects />
					</div>
					<div className="md-col">
						<WhosOut />
						{manager ? <Approvals /> : <Shoutouts />}
						{me.role !== 'admin' && <DayLeave />}
					</div>
				</div>
			) : (
				<div className="md-projects">
					<NeedsAttention items={items} />
					<ProjectsBoard />
				</div>
			)}
			{manager && (
				<>
					<ShoutoutDialog open={dialog === 'shout'} onClose={() => setDialog(null)} />
					<AnnouncementDialog open={dialog === 'announce'} onClose={() => setDialog(null)} />
				</>
			)}
		</div>
	);
}
