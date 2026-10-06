import { describe, expect, it } from 'vitest';
import { canOpenPage, canTour } from '../lib/roles.js';

const admin = { id: 'a', role: 'admin', active: 1 };
const admin2 = { id: 'a2', role: 'admin', active: 1 };
const lead = { id: 'l', role: 'lead', active: 1 };
const lead2 = { id: 'l2', role: 'lead', active: 1 };
const member = { id: 'm', role: 'member', active: 1 };

describe('touring someone’s portal (view only)', () => {
	it('the Super Admin tours anyone else; a Team Leader tours Team Members only', () => {
		expect(canTour(admin, lead)).toBe(true);
		expect(canTour(admin, member)).toBe(true);
		expect(canTour(admin, admin2)).toBe(true);
		expect(canTour(lead, member)).toBe(true);
		expect(canTour(lead, lead2)).toBe(false);
		expect(canTour(lead, admin)).toBe(false);
	});

	it('Team Members tour nobody; never yourself or someone removed', () => {
		expect(canTour(member, lead)).toBe(false);
		expect(canTour(member, { ...member, id: 'm2' })).toBe(false);
		expect(canTour(lead, lead)).toBe(false);
		expect(canTour(admin, { ...member, active: 0 })).toBe(false);
	});
});

describe('opening someone’s page', () => {
	it('your own; the Super Admin anyone’s; a Team Leader Team Members’ only; Team Members nobody else’s', () => {
		expect(canOpenPage(member, member)).toBe(true);
		expect(canOpenPage(member, { ...member, id: 'm2' })).toBe(false);
		expect(canOpenPage(member, lead)).toBe(false);
		expect(canOpenPage(lead, member)).toBe(true);
		expect(canOpenPage(lead, lead2)).toBe(false);
		expect(canOpenPage(lead, admin)).toBe(false);
		expect(canOpenPage(admin, lead)).toBe(true);
		expect(canOpenPage(admin, admin2)).toBe(true);
	});
});
