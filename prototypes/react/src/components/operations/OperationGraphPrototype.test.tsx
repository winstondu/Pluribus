import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationGraphPrototype } from './OperationGraphPrototype';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function select(name: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
}
function complete() {
  fireEvent.click(screen.getByRole('button', { name: 'Complete selected' }));
  act(() => { vi.advanceTimersByTime(180); });
}

describe('operation graph demo', () => {
  it('releases a join only after both dependencies complete, without taking a model slot', () => {
    render(<OperationGraphPrototype />);
    select('Join sibling results');
    expect(screen.getByRole('button', { name: 'Complete selected' })).toBeDisabled();
    expect(screen.getByText(/Waiting for Explore neighborhoods, Find activities/)).toBeInTheDocument();
    select('Explore neighborhoods'); complete();
    select('Join sibling results');
    expect(screen.getByRole('button', { name: 'Complete selected' })).toBeDisabled();
    expect(screen.getByText(/Waiting for Find activities/)).toBeInTheDocument();
    select('Find activities'); complete();
    select('Join sibling results');
    expect(screen.getByRole('button', { name: 'Complete selected' })).toBeEnabled();
    expect(screen.getByText('1 / 4')).toBeInTheDocument();
    expect(screen.getByText(/no model call/)).toBeInTheDocument();
    complete();
    expect(screen.getByText('1 / 4')).toBeInTheDocument();
    select('Compose itinerary');
    expect(screen.getByRole('button', { name: 'Complete selected' })).toBeDisabled();
  });

  it('does not release a dependent of a failed operation', () => {
    render(<OperationGraphPrototype />);
    select('Review budget');
    expect(screen.getByText('Failed', { selector: '.op-detail-status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete selected' })).toBeDisabled();
    select('Finalize budget');
    expect(screen.getByText(/Recovery needed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete selected' })).toBeDisabled();
  });

  it('keeps every retired operation selectable and preserves selected details', () => {
    render(<OperationGraphPrototype />);
    complete();
    expect(screen.getByText('Completed', { selector: '.op-detail-status' })).toBeInTheDocument();
    select('Find activities'); complete();
    const history = screen.getByText('Operation history').closest<HTMLElement>('.op-history')!;
    fireEvent.click(within(history).getByRole('button', { name: /Explore neighborhoods/ }));
    expect(screen.getByText('Explore neighborhoods', { selector: '.op-detail-top strong' })).toBeInTheDocument();
    expect(screen.getByText('Completed', { selector: '.op-detail-status' })).toBeInTheDocument();
    expect(within(history).getByRole('button', { name: /Find activities/ })).toBeInTheDocument();
  });

  it('does not force-scroll on append and cancels a pending retirement on reset', () => {
    render(<OperationGraphPrototype />);
    const scroll = screen.getByLabelText('Scrollable dependency network');
    scroll.scrollLeft = 123;
    fireEvent.click(screen.getByRole('button', { name: /Add demo work/ }));
    expect(scroll.scrollLeft).toBe(123);
    fireEvent.click(screen.getByRole('button', { name: 'Complete selected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole('button', { name: /Explore neighborhoods/ })).toBeInTheDocument();
    expect(screen.getByText('No completed operations yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Follow-up 1/ })).not.toBeInTheDocument();
  });
});
