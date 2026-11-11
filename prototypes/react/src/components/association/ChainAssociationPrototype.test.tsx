import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChainAssociationPrototype } from './ChainAssociationPrototype';

describe('chain association', () => {
  it('focuses J and its consumed ancestry, excluding later source continuations', () => {
    render(<ChainAssociationPrototype />);
    expect(screen.getByText('Local-first').closest('.assoc-item')).toHaveClass('assoc-linked');
    expect(screen.getByText('Hosted').closest('.assoc-item')).toHaveClass('assoc-linked');
    expect(screen.getByText('Later on A').closest('.assoc-item')).toHaveClass('assoc-dim');
    expect(screen.getByText('Later on B').closest('.assoc-item')).toHaveClass('assoc-dim');
  });

  it('previews another chain after a click and restores the pinned selection on leave', () => {
    render(<ChainAssociationPrototype />);
    const j = screen.getByRole('button', { name: 'J1' });
    const a = screen.getByRole('button', { name: 'A1 → A2' });
    fireEvent.focus(j);
    fireEvent.click(j);
    fireEvent.mouseEnter(a);
    expect(screen.getByText('Focus: A')).toBeInTheDocument();
    fireEvent.mouseLeave(a);
    expect(screen.getByText('Focus: J')).toBeInTheDocument();
    fireEvent.blur(j);
    fireEvent.focus(a);
    expect(screen.getByText('Focus: A')).toBeInTheDocument();
    fireEvent.blur(a);
    expect(screen.getByText('Focus: J')).toBeInTheDocument();
  });
});
