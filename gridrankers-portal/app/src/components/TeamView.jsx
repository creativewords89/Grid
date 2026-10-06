import { useState } from 'react';
import { usePortal } from '../context.js';
import { canOpenPage, isManager } from '../lib/roles.js';
import MemberPage from './team/MemberPage.jsx';

// Your page and member pages (SPEC.md 7.5, 7.6). The name chip opens your own page; the Super
// Admin and Team Leaders run the team from its tabs and open anyone's page from Team.
export default function TeamView() {
	const { data, me, today, teamPerson, setTeamPerson } = usePortal();
	const [perf, setPerf] = useState({ mode: 'month', anchor: today });
	if (!isManager(me)) return <MemberPage pid={me.id} perf={perf} setPerf={setPerf} />;
	// The team lives on My page (SPEC.md 7.6): "All team members" goes back to its Team tab.
	// A Team Leader opens Team Members' pages only; the Super Admin anyone's (SPEC.md section 3).
	const pid = teamPerson && teamPerson !== 'all' && canOpenPage(me, data.members[teamPerson]) ? teamPerson : me.id;
	return <MemberPage key={pid} pid={pid} perf={perf} setPerf={setPerf} initialTab={teamPerson === 'all' ? 'team' : undefined} onBack={() => setTeamPerson('all')} />;
}
