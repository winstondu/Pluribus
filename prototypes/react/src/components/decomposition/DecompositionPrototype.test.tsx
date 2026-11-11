import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DecompositionPrototype } from './DecompositionPrototype';

describe('DecompositionPrototype', () => {
  it('compares the selected fragment with its exact source and shared local requirement', async () => {
    const user = userEvent.setup();
    render(<DecompositionPrototype />);
    expect(screen.getByText('Explain why the sky is blue. Keep the answer brief.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'B · Menu' }));
    expect(screen.getByText('Translate “sopa de verduras” into English. Keep the answer brief.')).toBeInTheDocument();
    expect(screen.getByText('Shared within this message · not session-wide')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fragments' }));
    const menu = screen.getByRole('button', { name: /Chain B · Menu/ });
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Translate “sopa de verduras” into English. Keep the answer brief.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Chain A · Sky/ }));
    expect(screen.getByText('Explain why the sky is blue. Keep the answer brief.')).toBeInTheDocument();
    expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the sequential split comparison even when debug is off', async () => {
    const user = userEvent.setup();
    render(<DecompositionPrototype />);
    await user.click(screen.getByRole('button', { name: 'Debug on' }));
    await user.click(screen.getByRole('button', { name: /Split from one message · Open Compare/ }));
    const panel = screen.getByText('Compare sequential split').parentElement!;
    expect(within(panel).getByText('Summarize the recommendation, then use that summary to draft an itinerary.')).toBeInTheDocument();
    expect(within(panel).getByText('Part 2 waits for the result of part 1.')).toBeInTheDocument();
  });
  it('preserves each sent reply target when another target is selected', async () => {
    const user = userEvent.setup();
    render(<DecompositionPrototype />);
    await user.click(screen.getByRole('button', { name: '↩ Reply to Sky' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'First follow-up');
    await user.click(screen.getByRole('button', { name: 'Send ↑' }));
    expect(screen.queryByText('Replying to Sky')).not.toBeInTheDocument();
    const first = screen.getByText('First follow-up').closest('article')!;
    expect(within(first).getByText('Reply to Sky')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '↩ Reply to Menu' }));
    expect(within(first).getByText('Reply to Sky')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Second follow-up');
    await user.click(screen.getByRole('button', { name: 'Send ↑' }));
    expect(within(screen.getByText('Second follow-up').closest('article')!).getByText('Reply to Menu')).toBeInTheDocument();
    expect(within(first).getByText('Reply to Sky')).toBeInTheDocument();
  });
});
