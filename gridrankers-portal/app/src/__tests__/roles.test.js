import { describe, expect, it } from 'vitest';
import { canViewDay } from '../lib/roles.js';

const admin = { id: 'a', role: 'admin', active: 1 };
const lead = { id: 'l', role: 'lead', active: 1 };
const lead2 = { id: 'l2', role: 'lead', active: 1 };
const member = { id: 'm', role: 'member', active: 1 };

describe('viewing someone’s My day', () => {
	it('Super Admin views leaders and members; leaders view members and other leaders', () => {
		expect(canViewDay(admin, lead)).toBe(true);
		expect(canViewDay(admin, member)).toBe(true);
		expect(canViewDay(lead, member)).toBe(true);
		expect(canViewDay(lead, lead2)).toBe(true);
	});

	it('nobody views the Super Admin, members view nobody, and never yourself or someone removed', () => {
		expect(canViewDay(lead, admin)).toBe(false);
		expect(canViewDay(member, lead)).toBe(false);
		expect(canViewDay(member, { ...member, id: 'm2' })).toBe(false);
		expect(canViewDay(lead, lead)).toBe(false);
		expect(canViewDay(admin, { ...member, active: 0 })).toBe(false);
	});
});
