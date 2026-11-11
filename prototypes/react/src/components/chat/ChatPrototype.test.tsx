import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChatPrototype } from './ChatPrototype';

describe('ChatPrototype', () => {
  it('targets individual sections and queues a follow-up only while its prerequisite is pending', async () => {
    const user = userEvent.setup();
    render(<ChatPrototype />);
    await user.click(screen.getByRole('button', { name: '↩ Reply to Sky' }));
    expect(screen.getByText('Replying to Sky')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Explain more');
    await user.click(screen.getByRole('button', { name: 'Send ↑' }));
    expect(screen.getByRole('status')).toHaveTextContent('waiting for the Sky answer');
    const packing = screen.getByText('Pack water, weather-ready layers, sturdy shoes, snacks, a map, and a small first-aid kit.').closest('article')!;
    const group = screen.getByText('Menu translation').closest('article')!;
    expect(packing.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Advance demo: Menu responds' }));
    expect(packing.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('“Sopa de verduras” means vegetable soup.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    const sections = screen.getByText('Menu translation').closest('section')!.parentElement!;
    expect(within(sections).getAllByRole('button', { name: /Reply to/ })[0]).toHaveTextContent('Menu');
    await user.click(screen.getByRole('button', { name: 'Advance demo: Sky responds' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/Air molecules scatter/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '↩ Reply to Menu' }));
    expect(screen.getByText('Replying to Menu')).toBeInTheDocument();
  });

  it('keeps a sibling response available when one section fails and retries locally', async () => {
    const user = userEvent.setup();
    render(<ChatPrototype />);
    await user.click(screen.getByRole('button', { name: 'Advance demo: Menu responds' }));
    await user.click(screen.getByRole('button', { name: 'Simulate failure' }));
    expect(screen.getByText(/Failed before output/)).toBeInTheDocument();
    expect(screen.getByText('“Sopa de verduras” means vegetable soup.')).toBeInTheDocument();
    expect(screen.getByText('1 done · 1 failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Advance demo: Sky responds' }));
    expect(screen.getByText(/Failed before output/)).toBeInTheDocument();
    expect(screen.getByText('1 done · 1 failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(/Failed before output/)).not.toBeInTheDocument();
    expect(screen.getByText('“Sopa de verduras” means vegetable soup.')).toBeInTheDocument();
  });

  it('asks for a fixture target before submitting an untargeted follow-up', async () => {
    const user = userEvent.setup();
    render(<ChatPrototype />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Tell me more about that');
    await user.click(screen.getByRole('button', { name: 'Send ↑' }));
    expect(screen.getByText('Which response is this about?')).toBeInTheDocument();
    await user.click(within(screen.getByText('Which response is this about?').parentElement!).getByRole('button', { name: /^Menu$/ }));
    expect(screen.getByText('Tell me more about that')).toBeInTheDocument();
    expect(screen.getByText('Reply to Menu')).toBeInTheDocument();
  });
  it('submits an independent request without asking for a target', async () => {
    const user = userEvent.setup();
    render(<ChatPrototype />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Translate hello into French');
    await user.click(screen.getByRole('button', { name: 'Send ↑' }));
    expect(screen.getByText('Translate hello into French')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.queryByText('Which response is this about?')).not.toBeInTheDocument();
  });

});
