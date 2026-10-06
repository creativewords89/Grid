import { isManager } from './roles.js';

export const PRI = { urgent: 0, high: 1, normal: 2, low: 3 };
export const PRI_LABEL = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
export const STATUS_TXT = { todo: 'Not started', doing: 'In progress', done: 'Completed' };
export const REVIEW_TXT = { pending: 'Awaiting review', accepted: 'Accepted', revision: 'Revision requested', rejected: 'Rejected' };

// Assignees that are still on the team.
export const assigneesOf = (task, members) => (Array.isArray(task.assignees) ? task.assignees : []).filter((a) => members[a.id]);

export const isAssigned = (task, id) => (task.assignees || []).some((a) => a.id === id);

// Who may work on a task (SPEC.md 6.6; the server enforces the same rule): Team Members only on
// tasks assigned to them — an unassigned task must be assigned first.
export const canWorkOn = (task, me) => !!me && (isManager(me) || isAssigned(task, me.id));

export const progressTotal = (task) => Object.values(task.progress || {}).reduce((a, b) => a + (+b || 0), 0);

export const sortOpen = (a, b) => (PRI[a.priority] ?? 2) - (PRI[b.priority] ?? 2) || String(b.created_at || '').localeCompare(String(a.created_at || ''));

export const searchText = (parts) => parts.filter(Boolean).join(' ').toLowerCase();

// General tasks (SPEC.md 6.13): meeting tasks that aren't part of any project (`project_id` '').
export const GENERAL = '';
export const GENERAL_NAME = 'General tasks';
export const isGeneral = (t) => !!t && t.project_id === GENERAL && 'status' in t;
// A meeting task still shown: in a project that exists, or General.
export const liveTask = (data, t) => isGeneral(t) || !!data.projects[t.project_id];
// Where a meeting task lives: its project's name, or General tasks.
export const homeName = (data, t) => (isGeneral(t) ? GENERAL_NAME : data.projects[t.project_id] ? data.projects[t.project_id].name : '');
// The view that shows a meeting task: its project's board, or the General tasks board.
export const boardOf = (t) => (isGeneral(t) ? 'general' : 'board');
