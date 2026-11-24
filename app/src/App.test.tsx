import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Checkouts } from './components/Checkouts';
import { Notifications } from './components/Notifications';
import { isIos } from './lib/push';
import { createMockServices } from './lib/mock';
import type { Api, LoansResponse, Services } from './types';

afterEach(() => {
  window.location.hash = '';
});

async function signedIn(): Promise<Services> {
  const s = createMockServices();
  await s.auth.confirmCode('123456');
  return s;
}

describe('Checkouts', () => {
  it('lists loans soonest first with overdue items highlighted, and filters by card', async () => {
    const s = await signedIn();
    const data = await s.api.getLoans();
    render(<Checkouts data={data} api={s.api} reload={async () => {}} />);
    const rows = screen.getAllByTestId('loan');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveClass('overdue');
    expect(within(rows[0]!).getByText(/The Overstory/)).toBeInTheDocument();
    expect(rows[5]).not.toHaveClass('overdue');
    expect(screen.getByText(/Couldn’t refresh Spouse/)).toBeInTheDocument();
    expect(screen.getByText(/Kids' card owes \$4\.99/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: "Kids' card" }));
    expect(screen.getAllByTestId('loan')).toHaveLength(3);
  });

  it('shows per-item renewal results, including failures from the library', async () => {
    const s = await signedIn();
    const data = await s.api.getLoans();
    render(<Checkouts data={data} api={s.api} reload={async () => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Renew Ember Rising' }));
    expect(await screen.findByText(/Renewed — now due/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: "Renew Ember's End" }));
    expect(await screen.findByText(/exceeded renewal limit/)).toBeInTheDocument();
  });

  it('disables renew when the library does not offer it', async () => {
    const s = await signedIn();
    const data = await s.api.getLoans();
    render(<Checkouts data={data} api={s.api} reload={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Renew Project Hail Mary' })).toBeDisabled();
  });

  it('prompts to add a card when there are none', () => {
    const data: LoansResponse = { accounts: [], loans: [] };
    render(<Checkouts data={data} api={{} as Api} reload={async () => {}} />);
    expect(screen.getByText(/Add a library card/)).toBeInTheDocument();
  });
});

describe('Notifications', () => {
  it('saves preferences', async () => {
    const s = await signedIn();
    const put = vi.spyOn(s.api, 'putPrefs');
    render(<Notifications api={s.api} push={s.push} />);
    await userEvent.click(await screen.findByLabelText('Notify before due date'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]![0].triggers).toMatchObject({ overdue: true, daysBefore: 2 });
  });

  it('shows the Add to Home Screen hint when push needs an installed app', async () => {
    const s = await signedIn();
    s.push.status = () => 'needs-install';
    render(<Notifications api={s.api} push={s.push} />);
    expect(await screen.findByText(/Add Neverdue to your Home Screen first/)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('subscribes and unsubscribes this device', async () => {
    const s = await signedIn();
    const add = vi.spyOn(s.api, 'addPushSubscription');
    const remove = vi.spyOn(s.api, 'removePushSubscription');
    render(<Notifications api={s.api} push={s.push} />);
    const sw = await screen.findByRole('switch');
    await userEvent.click(sw);
    await waitFor(() => expect(add).toHaveBeenCalled());
    await waitFor(() => expect(sw).toBeChecked());
    await userEvent.click(sw);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('https://mock.push/endpoint'));
  });
});

describe('push helpers', () => {
  it('detects iOS devices, including iPadOS reporting as a Mac', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
  });
});

describe('App', () => {
  it('requires sign-in, then shows data, and sign-out clears everything', async () => {
    const s = createMockServices();
    render(<App services={s} />);
    await userEvent.type(await screen.findByLabelText('Email'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText(/Code from your email/), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/The Overstory/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText(/The Overstory/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Kids' card|4821/);
  });

  it('notes paused cards on the configuration page', async () => {
    const s = await signedIn();
    render(<App services={s} />);
    await screen.findByText(/The Overstory/);
    await userEvent.click(screen.getByRole('link', { name: /Cards/ }));
    expect(await screen.findByText(/Paused: the library rejected/)).toBeInTheDocument();
  });

  it('switches tabs from the tab bar', async () => {
    const s = await signedIn();
    render(<App services={s} />);
    expect(await screen.findByText(/The Overstory/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: /Cards/ }));
    expect(await screen.findByRole('heading', { name: 'Library cards' })).toBeInTheDocument();
    expect(screen.getByText(/•••• 4821/)).toBeInTheDocument();
  });
});
