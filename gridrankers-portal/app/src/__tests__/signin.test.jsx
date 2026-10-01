import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SignIn from '../components/SignIn.jsx';

afterEach(cleanup);

describe('SignIn', () => {
	it('shows the spec wording and the forgot-code message', () => {
		render(<SignIn api={{ post: vi.fn() }} onSignedIn={() => {}} />);

		expect(screen.getByText('Sign in to continue')).toBeTruthy();
		expect(screen.getByLabelText('Your code')).toBeTruthy();
		fireEvent.click(screen.getByText('Forgot your code?'));
		expect(screen.getByText('Ask your Super Admin to set a new code (Team → Settings → Set code)')).toBeTruthy();
	});

	it('signs in and shows server errors', async () => {
		const post = vi
			.fn()
			.mockRejectedValueOnce(new Error("That code doesn't match anyone."))
			.mockResolvedValueOnce({ member: { id: 'm1' } });
		const onSignedIn = vi.fn();
		render(<SignIn api={{ post }} onSignedIn={onSignedIn} />);

		fireEvent.change(screen.getByLabelText('Your code'), { target: { value: 'WRONG1' } });
		fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(await screen.findByText("That code doesn't match anyone.")).toBeTruthy();

		fireEvent.change(screen.getByLabelText('Your code'), { target: { value: 'RIGHT1' } });
		fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ id: 'm1' }));
		expect(post).toHaveBeenLastCalledWith('auth/login', { code: 'RIGHT1' });
	});

	it('requires a code', () => {
		const post = vi.fn();
		render(<SignIn api={{ post }} onSignedIn={() => {}} />);
		fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(screen.getByText('Enter your code.')).toBeTruthy();
		expect(post).not.toHaveBeenCalled();
	});
});
