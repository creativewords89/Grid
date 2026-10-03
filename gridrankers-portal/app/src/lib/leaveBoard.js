// Leave tab (SPEC.md 7.5, design LV-A): the four numbers on top, the over-allowance warning of a
// waiting request and the list order. The server stays the source of truth for decisions.
import { isManager } from './roles.js';
import { LEAVE_PER_MONTH, leaveDays, takenInMonth, teamWeekly } from './people.js';
import { rowsOf } from './store.js';

// Waiting first, then newest first.
export const sortLeave = (rows) => [...rows].sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.from_date.localeCompare(a.from_date));

// A waiting request the viewer may decide: a Team Member's, decided by a leader or the Super Admin.
export const mayDecideLeave = (l, me, data) => l.status === 'pending' && isManager(me) && !!data.members[l.member_id] && data.members[l.member_id].role === 'member';

// Days a request would go over the 1-day allowance, summed over the months it touches.
export function overBy(data, leave) {
	const person = data.members[leave.member_id];
	if (!person) return 0;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const others = rowsOf(data, 'leave').filter((l) => l.id !== leave.id);
	return Object.entries(leaveDays(leave.from_date, leave.to_date, person, team, daysOff)).reduce((sum, [month, days]) => {
		const before = takenInMonth(person, month, others, team, daysOff);
		return sum + Math.max(0, before + days - LEAVE_PER_MONTH) - Math.max(0, before - LEAVE_PER_MONTH);
	}, 0);
}

// The numbers: waiting for the viewer, out today, taken this month, over the allowance.
export function leaveSummary(data, me, today) {
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const month = today.slice(0, 7);
	const people = rowsOf(data, 'members')
		.filter((m) => m.active && m.role !== 'admin')
		.sort((a, b) => a.name.localeCompare(b.name));
	const waiting = sortLeave(leaves.filter((l) => mayDecideLeave(l, me, data)));
	const outToday = leaves
		.filter((l) => l.status === 'approved' && today >= l.from_date && today <= l.to_date && data.members[l.member_id])
		.sort((a, b) => data.members[a.member_id].name.localeCompare(data.members[b.member_id].name));
	const taken = people.map((m) => ({ member: m, taken: takenInMonth(m, month, leaves, team, daysOff) }));
	return {
		month,
		waiting,
		outToday,
		takenDays: taken.reduce((s, t) => s + t.taken, 0),
		takenPeople: taken.filter((t) => t.taken > 0).length,
		over: taken.filter((t) => t.taken > LEAVE_PER_MONTH),
	};
}

// Issue a day off (SPEC.md 6.10): Team Leaders and the Super Admin, to active Team Members and
// Team Leaders, never to themselves. Mirrors GRP_Permissions::ISSUE_LEAVE.
export const mayIssueLeave = (me, p) => isManager(me) && !!p && +p.active !== 0 && p.id !== me.id && (p.role === 'member' || p.role === 'lead');

// A day off someone else issued: approved leave created by another person.
export const isIssued = (l) => !!l.created_by && l.created_by !== l.member_id;
