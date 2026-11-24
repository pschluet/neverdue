import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Checkouts } from './components/Checkouts';
import { Notifications } from './components/Notifications';
import { isIos } from './lib/push';
import { createMockServices } from './lib/mock';
import { createQueryClient } from './lib/queries';
import type { Api, LoansResponse, Services } from './types';

afterEach(() => {
  window.location.hash = '';
});

const withQuery = (ui: ReactElement) => (
  <QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>
);

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
    render(withQuery(<Notifications api={s.api} push={s.push} />));
    await userEvent.click(await screen.findByLabelText('Notify before due date'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]![0].triggers).toMatchObject({ overdue: true, daysBefore: 2 });
  });

  it('lets the days field be cleared and retyped', async () => {
    const s = await signedIn();
    const put = vi.spyOn(s.api, 'putPrefs');
    render(withQuery(<Notifications api={s.api} push={s.push} />));
    await userEvent.click(await screen.findByLabelText('Notify before due date'));
    const days = screen.getByLabelText('Days before due');
    await userEvent.clear(days);
    expect(days).toHaveValue(null);
    await userEvent.type(days, '14');
    expect(days).toHaveValue(14);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]![0].triggers).toMatchObject({ daysBefore: 14 });
  });

  it('shows the Add to Home Screen hint when push needs an installed app', async () => {
    const s = await signedIn();
    s.push.status = () => 'needs-install';
    render(withQuery(<Notifications api={s.api} push={s.push} />));
    expect(await screen.findByText(/Add Neverdue to your Home Screen first/)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('subscribes and unsubscribes this device', async () => {
    const s = await signedIn();
    const add = vi.spyOn(s.api, 'addPushSubscription');
    const remove = vi.spyOn(s.api, 'removePushSubscription');
    render(withQuery(<Notifications api={s.api} push={s.push} />));
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

  it('hides the Admin tab from regular users', async () => {
    const s = await signedIn();
    render(<App services={s} />);
    await screen.findByText(/The Overstory/);
    expect(screen.queryByRole('link', { name: /Admin/ })).not.toBeInTheDocument();
    window.location.hash = '#/admin';
    await waitFor(() => expect(screen.getByText(/The Overstory/)).toBeInTheDocument());
  });

  it('lets the admin invite, disable and delete users', async () => {
    const s = createMockServices();
    await s.auth.requestCode('paul@paulschlueter.com');
    await s.auth.confirmCode('123456');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App services={s} />);
    await userEvent.click(await screen.findByRole('link', { name: /Admin/ }));
    expect(await screen.findAllByTestId('user')).toHaveLength(4);
    expect(screen.getByText('(you)')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();

    const sam = screen.getByText('sam@example.com').closest('li')!;
    await userEvent.click(within(sam).getByRole('button', { name: 'Disable' }));
    expect(await within(sam).findByText('Disabled')).toBeInTheDocument();

    await userEvent.click(within(sam).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('sam@example.com')).not.toBeInTheDocument());
  });

  it('lets the admin link two users and unlink them, choosing who keeps the cards', async () => {
    const s = createMockServices();
    await s.auth.requestCode('paul@paulschlueter.com');
    await s.auth.confirmCode('123456');
    render(<App services={s} />);
    await userEvent.click(await screen.findByRole('link', { name: /Admin/ }));
    await screen.findAllByTestId('user');
    const row = (email: string) =>
      screen
        .getAllByTestId('user')
        .find((li) => within(li).queryByText(email, { selector: 'strong' }))!;

    await userEvent.click(
      within(row('paul@paulschlueter.com')).getByRole('button', { name: /Link to another user/ }),
    );
    await userEvent.selectOptions(screen.getByLabelText(/Link paul@paulschlueter.com with/), [
      'sam@example.com',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(
      await within(row('sam@example.com')).findByText('Linked with paul@paulschlueter.com'),
    ).toBeInTheDocument();
    expect(within(row('paul@paulschlueter.com')).getByText(/3 cards/)).toBeInTheDocument();
    expect(within(row('sam@example.com')).getByText(/3 cards/)).toBeInTheDocument();

    await userEvent.click(within(row('sam@example.com')).getByRole('button', { name: 'Unlink…' }));
    await userEvent.click(screen.getByRole('radio', { name: 'sam@example.com' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(screen.queryByTestId('linked')).not.toBeInTheDocument());
    expect(within(row('sam@example.com')).getByText(/3 cards/)).toBeInTheDocument();
    expect(within(row('paul@paulschlueter.com')).getByText(/0 cards/)).toBeInTheDocument();
  });

  it('does not refetch prefs when switching back to the Alerts tab', async () => {
    const s = await signedIn();
    const get = vi.spyOn(s.api, 'getPrefs');
    render(<App services={s} />);
    await screen.findByText(/The Overstory/);
    await userEvent.click(screen.getByRole('link', { name: /Alerts/ }));
    await screen.findByRole('heading', { name: 'Notifications' });
    await userEvent.click(screen.getByRole('link', { name: /Checkouts/ }));
    await screen.findByText(/The Overstory/);
    await userEvent.click(screen.getByRole('link', { name: /Alerts/ }));
    await screen.findByRole('heading', { name: 'Notifications' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('shows saved prefs after switching away and back, without refetching', async () => {
    const s = await signedIn();
    const get = vi.spyOn(s.api, 'getPrefs');
    render(<App services={s} />);
    await screen.findByText(/The Overstory/);
    await userEvent.click(screen.getByRole('link', { name: /Alerts/ }));
    await userEvent.click(await screen.findByLabelText('Notify before due date'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved');
    await userEvent.click(screen.getByRole('link', { name: /Checkouts/ }));
    await screen.findByText(/The Overstory/);
    await userEvent.click(screen.getByRole('link', { name: /Alerts/ }));
    expect(await screen.findByLabelText('Days before due')).toHaveValue(2);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('caches the admin user list but refreshes it after a change', async () => {
    const s = createMockServices();
    await s.auth.requestCode('paul@paulschlueter.com');
    await s.auth.confirmCode('123456');
    const list = vi.spyOn(s.api, 'adminListUsers');
    render(<App services={s} />);
    await userEvent.click(await screen.findByRole('link', { name: /Admin/ }));
    await screen.findAllByTestId('user');
    await userEvent.click(screen.getByRole('link', { name: /Checkouts/ }));
    await screen.findByText(/The Overstory/);
    await userEvent.click(screen.getByRole('link', { name: /Admin/ }));
    await screen.findAllByTestId('user');
    expect(list).toHaveBeenCalledTimes(1);

    const sam = screen.getByText('sam@example.com').closest('li')!;
    await userEvent.click(within(sam).getByRole('button', { name: 'Disable' }));
    expect(await within(sam).findByText('Disabled')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
