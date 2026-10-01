import { useState } from 'react';
import { usePortal } from '../context.js';
import { isManager } from '../lib/roles.js';
import MemberPage from './team/MemberPage.jsx';
import TeamArea from './team/TeamArea.jsx';

// Team area (admin/lead) and member pages (SPEC.md 7.5, 7.6). Members only see their own page.
export default function TeamView() {
	const { me, today, teamPerson, setTeamPerson } = usePortal();
	const [perf, setPerf] = useState({ mode: 'month', anchor: today });
	if (!isManager(me)) return <MemberPage pid={me.id} perf={perf} setPerf={setPerf} />;
	if (teamPerson && teamPerson !== 'all') return <MemberPage pid={teamPerson} perf={perf} setPerf={setPerf} onBack={() => setTeamPerson('all')} />;
	return <TeamArea perf={perf} setPerf={setPerf} onPerson={setTeamPerson} />;
}
