// Pay helpers (SPEC.md 6.19).
import { describe, expect, it } from 'vitest';
import { addMonths, calendarCells, dayLength, dayPay, dayTone, hourPay, leaveLine, masked, money, parseSalary, payError, payWhere } from '../lib/pay.js';

const ok = { day_minutes: 480, salary: '30,000', method: 'bank', bank_name: 'Dutch-Bangla Bank', account_name: 'Rumi Akter', account_number: '1171 0100 2345 678' };

describe('pay maths', () => {
	it('a day is salary ÷ 30 and an hour a day ÷ the hours', () => {
		expect(dayPay(30000)).toBe(1000);
		expect(hourPay(30000, 480)).toBe(125);
		expect(hourPay(30000, 300)).toBe(200);
		expect(hourPay(18000, 360)).toBe(100);
	});
	it('formats money and day lengths', () => {
		expect(money(29812.5)).toBe('29,813');
		expect(dayLength(480)).toBe('8 hours');
		expect(dayLength(330)).toBe('5h 30m');
	});
	it('reads a typed salary', () => {
		expect(parseSalary('30,000')).toBe(30000);
		expect(parseSalary(' 25 000 ')).toBe(25000);
		expect(parseSalary('30k')).toBe(0);
	});
});

describe('payError', () => {
	it('accepts a full bank setup and a bKash number', () => {
		expect(payError(ok)).toBe('');
		expect(payError({ ...ok, method: 'bkash', bank_name: '', account_number: '017 1234 5678' })).toBe('');
	});
	it('asks for each missing field', () => {
		expect(payError({ ...ok, day_minutes: 0 })).toMatch(/hours/);
		expect(payError({ ...ok, salary: '' })).toMatch(/salary/);
		expect(payError({ ...ok, method: 'cash' })).toMatch(/Choose/);
		expect(payError({ ...ok, bank_name: ' ' })).toMatch(/bank name/);
		expect(payError({ ...ok, account_name: '' })).toMatch(/account name/);
		expect(payError({ ...ok, account_number: 'ABC' })).toMatch(/account number/);
		expect(payError({ ...ok, method: 'nagad', account_number: '12345' })).toMatch(/11-digit/);
	});
});

describe('display helpers', () => {
	it('hides all but the last 4 digits', () => {
		expect(masked('1171 0100 2345 678')).toBe('•••• 5678');
		expect(payWhere({ method: 'bank', bank_name: 'DBBL', branch: 'Gulshan' })).toBe('DBBL · Gulshan');
		expect(payWhere({ method: 'bkash' })).toBe('bKash');
	});
	it('moves months', () => {
		expect(addMonths('2026-01', -1)).toBe('2025-12');
		expect(addMonths('2026-12', 1)).toBe('2027-01');
	});
	it('starts the calendar on Saturday', () => {
		// 1 Oct 2026 is a Thursday: five blanks (Sat–Wed) before it.
		const cells = calendarCells([{ day: '2026-10-01' }, { day: '2026-10-02' }]);
		expect(cells.slice(0, 5)).toEqual([null, null, null, null, null]);
		expect(cells[5].day).toBe('2026-10-01');
	});
	it('colours each day', () => {
		expect(dayTone({ kind: 'work', minutes: 480, extra: 0 }, 480)).toBe('full');
		expect(dayTone({ kind: 'work', minutes: 360, extra: 0 }, 480)).toBe('short');
		expect(dayTone({ kind: 'work', minutes: 600, extra: 120 }, 480)).toBe('extra');
		expect(dayTone({ kind: 'work', minutes: 0, extra: 0 }, 480)).toBe('empty');
		expect(dayTone({ kind: 'day_off', minutes: 0, extra: 0 }, 480)).toBe('off');
		expect(dayTone({ kind: 'leave', minutes: 0, extra: 0 }, 480)).toBe('leave');
		expect(dayTone({ kind: 'future', minutes: 0, extra: 0 }, 480)).toBe('future');
	});
	it('explains the days off', () => {
		const base = { salary: 30000, leave_pay: 0, deducted: 0 };
		expect(leaveLine({ ...base, leave_pay: 20000, leave: { taken: 0, deducted: 0, paid: 20 } })).toMatchObject({ amount: 20000, sign: '+', text: 'No days off · unused leave paid · 20 × 1,000' });
		expect(leaveLine({ ...base, leave: { taken: 1, deducted: 0, paid: 0 } })).toMatchObject({ amount: 0, text: '1 day off · within the year’s allowance' });
		expect(leaveLine({ ...base, deducted: 1000, leave: { taken: 2, deducted: 1, paid: 0 } })).toMatchObject({ amount: 1000, sign: '−', text: '2 days off · 1 over the allowance · 1 × 1,000' });
	});
});
