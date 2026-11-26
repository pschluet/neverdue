import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const OPTIONS = [
  { value: 'daily', label: 'Once a day' },
  { value: 'weekly', label: 'Once a week' },
  { value: 'monthly', label: 'Once a month' },
];

function Harness({ onChange = () => undefined }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState('daily');
  return (
    <>
      <Select
        label="Frequency"
        value={value}
        options={OPTIONS}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
      <button>Elsewhere</button>
    </>
  );
}

describe('Select', () => {
  it('shows the current value and picks an option by tapping', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Frequency' });
    expect(trigger).toHaveTextContent('Once a day');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: 'Once a day' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('option', { name: 'Once a week' }));

    expect(onChange).toHaveBeenCalledWith('weekly');
    expect(trigger).toHaveTextContent('Once a week');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('works from the keyboard', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: 'Frequency' });
    trigger.focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(trigger).toHaveTextContent('Once a month');

    await userEvent.keyboard('{Enter}{Home}');
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Once a day' }).id,
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('Once a month');
    expect(trigger).toHaveFocus();
  });

  it('closes when tapping outside', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Frequency' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
