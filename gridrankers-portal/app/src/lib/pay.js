// Pay (SPEC.md 6.19): pure helpers for the setup page, the Salary tab and Payment information.
// The server decides every number; these only format and check what is typed.
import { fmtMinutes } from './reports.js';

// A month's salary is this many days' pay.
export const DAYS_IN_MONTH = 30;

// Working hours a day to pick from (minutes); "Other" types any hours from 1 to 16.
export const DAY_CHOICES = [300, 360, 480];
export const MIN_DAY = 60;
export const MAX_DAY = 960;

// Ways to be paid.
export const METHODS = [
	['bank', 'Bank account'],
	['bkash', 'bKash'],
	['nagad', 'Nagad'],
];
export const methodName = (m) => (METHODS.find(([k]) => k === m) || [m, m])[1];

// 29813 → "29,813".
export const money = (n) => Math.round(+n || 0).toLocaleString('en-US');

// 390 → "6h 30m".
export const hours = (min) => fmtMinutes(min);

// 480 → "8 hours", 330 → "5h 30m".
export const dayLength = (min) => (min % 60 ? fmtMinutes(min) : `${min / 60} hours`);

// A day's pay: salary ÷ 30; an hour's pay: a day's pay ÷ the hours.
export const dayPay = (salary) => (+salary || 0) / DAYS_IN_MONTH;
export const hourPay = (salary, dayMinutes) => (dayMinutes > 0 ? (dayPay(salary) * 60) / dayMinutes : 0);

// "30,000" or "30000 " → 30000; anything else → 0.
export function parseSalary(value) {
	const s = String(value == null ? '' : value).replace(/[,\s]/g, '');
	return /^\d+$/.test(s) ? parseInt(s, 10) : 0;
}

// Digits only.
const digits = (s) => String(s || '').replace(/\D/g, '');

// What blocks saving the pay form, or '' when it can be saved (the server checks again).
export function payError(form) {
	const m = +form.day_minutes || 0;
	if (m < MIN_DAY || m > MAX_DAY) return 'Pick how many hours you work a day (1 to 16).';
	const salary = parseSalary(form.salary);
	if (salary < 1 || salary > 10000000) return 'Write your monthly salary in BDT.';
	if (!METHODS.some(([k]) => k === form.method)) return 'Choose how you are paid: bank account, bKash or Nagad.';
	if (form.method === 'bank' && !String(form.bank_name || '').trim()) return 'Write the bank name.';
	if (!String(form.account_name || '').trim()) return 'Write the account name.';
	const number = String(form.account_number || '').trim();
	if (form.method === 'bank') {
		if (!/^[\d\s-]+$/.test(number) || digits(number).length < 6 || digits(number).length > 34) return 'Write the bank account number (digits only).';
	} else if (!/^[\d\s-]+$/.test(number) || !/^01\d{9}$/.test(digits(number))) {
		return 'Write the 11-digit mobile number, e.g. 01712345678.';
	}
	return '';
}

// "•••• 5678".
export const masked = (number) => '•••• ' + digits(number).slice(-4);

// Where the money goes: "Dutch-Bangla Bank · Gulshan", "bKash".
export function payWhere(pay) {
	if (!pay) return '';
	if (pay.method !== 'bank') return methodName(pay.method);
	return [pay.bank_name, pay.branch].filter(Boolean).join(' · ');
}

// "2026-10" → "October 2026"; with short=true "Oct".
export function monthTitle(month, short = false) {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(y, m - 1, 1);
	return short ? d.toLocaleDateString('en-US', { month: 'long' }) : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// "2026-10" ± n months.
export function addMonths(month, n) {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(Date.UTC(y, m - 1 + n, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// "2026-11-01" → "Nov 1".
export function shortDay(ymd) {
	const [y, m, d] = ymd.split('-').map(Number);
	return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// The month calendar (design PAY-3): weeks start on Saturday; blanks before the 1st.
export const WEEK = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export function calendarCells(days) {
	if (!days || !days.length) return [];
	const [y, m, d] = days[0].day.split('-').map(Number);
	const lead = (new Date(y, m - 1, d).getDay() + 1) % 7;
	return [...Array(lead).fill(null), ...days];
}

// One day's tone on the calendar: full (green), short (amber), extra (blue), off, leave, empty, future.
export function dayTone(day, dayMinutes) {
	if (day.kind === 'future') return 'future';
	if (day.kind === 'day_off') return day.minutes ? 'extra' : 'off';
	if (day.kind === 'leave') return day.minutes ? 'extra' : 'leave';
	if (!day.minutes) return 'empty';
	if (day.extra > 0) return 'extra';
	return day.minutes >= dayMinutes ? 'full' : 'short';
}

// The leave line under the month (design PAY-3): "No days off · casual day paid + 1,000",
// "1 day off · the casual day", "2 days off · 1 deducted − 1,000".
export function leaveLine(summary) {
	const { leave } = summary;
	if (!leave.taken) return { text: 'No days off · the unused casual day is paid', amount: summary.leave_pay, sign: '+' };
	if (!leave.deducted) return { text: '1 day off · the casual day, paid', amount: 0, sign: '' };
	return { text: `${leave.taken} days off · 1 casual day is paid · ${leave.deducted} × ${money(dayPay(summary.salary))}`, amount: summary.deducted, sign: '−' };
}
