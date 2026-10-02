// Display helpers for roles. Permissions are enforced by the server; the UI only hides
// what a person can't do.

export const ROLE = { admin: 'Super Admin', lead: 'Team Leader', member: 'Team Member' };

export const isManager = (me) => !!me && (me.role === 'admin' || me.role === 'lead');
export const isAdmin = (me) => !!me && me.role === 'admin';

// Viewing someone's My day (SPEC.md 7.0, view only): the Super Admin can view Team Leaders and
// Team Members; a Team Leader can view Team Members and other Team Leaders; nobody views the
// Super Admin, and Team Members view nobody.
export const canViewDay = (viewer, target) => !!viewer && !!target && viewer.id !== target.id && +target.active !== 0 && target.role !== 'admin' && isManager(viewer);

export const initials = (name) =>
	(name || '')
		.trim()
		.split(/\s+/)
		.map((w) => w[0])
		.join('')
		.slice(0, 2)
		.toUpperCase();
