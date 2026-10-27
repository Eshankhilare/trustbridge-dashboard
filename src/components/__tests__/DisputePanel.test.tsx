import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DisputePanel } from '../DisputePanel';

const mockInvalidateQueries = vi.fn();
const mockMutate = vi.fn();
// Controllable mutation result state (the component reads isError/error at
// render time, so tests set this before rendering the error path).
const mockMutationResult: { isError: boolean; error: Error | null } = {
  isError: false,
  error: null,
};

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  );
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
    useMutation: (options: any) => ({
      // Merge the declared callbacks so tests can drive onSuccess/onError
      // through mockMutate's implementation.
      mutate: (vars: unknown, opts?: any) =>
        mockMutate(vars, { ...options, ...opts }),
      isLoading: false,
      get isError() {
        return mockMutationResult.isError;
      },
      get error() {
        return mockMutationResult.error;
      },
    }),
  };
});

const contributors = [
  { id: '1', githubUsername: 'alice' },
  { id: '2', githubUsername: 'bob' },
] as any;

function renderPanel(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DisputePanel contributors={contributors} {...props} />
    </QueryClientProvider>,
  );
}

describe('DisputePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutationResult.isError = false;
    mockMutationResult.error = null;
  });

  it('renders contributor select options', () => {
    renderPanel();
    const select = screen.getByLabelText(/registration/i);
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'alice' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'bob' })).toBeInTheDocument();
  });

  it('renders an empty select and disabled submit when there are no contributors', () => {
    renderPanel({ contributors: [] });
    const select = screen.getByLabelText(/registration/i);
    expect(select).toBeInTheDocument();
    expect(
      (select as HTMLSelectElement).options
    ).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: /file dispute/i })
    ).toBeDisabled();
  });

  it('clears the reason and invalidates the query on successful submit', async () => {
    const user = userEvent.setup();
    mockMutate.mockImplementation((_vars: unknown, opts: any) => {
      opts?.onSuccess?.();
    });

    renderPanel();

    await user.selectOptions(screen.getByLabelText(/registration/i), '1');
    const reason = screen.getByLabelText(/reason/i);
    await user.type(reason, 'Payment was never received');
    await user.click(screen.getByRole('button', { name: /file dispute/i }));

    await waitFor(() => expect(reason).toHaveValue(''));
    expect(mockInvalidateQueries).toHaveBeenCalled();
  });

  it('surfaces mutation errors accessibly', async () => {
    const user = userEvent.setup();
    mockMutate.mockImplementation((_vars: unknown, opts: any) => {
      opts?.onError?.(new Error('Failed to file dispute'));
    });

    // Drive the error path through render-time mutation state: the panel
    // shows the alert when the create mutation reports isError. (The shared
    // mutation mock reports the same state for the resolve mutation, so both
    // alerts render — assert on all of them.)
    mockMutationResult.isError = true;
    mockMutationResult.error = new Error('Failed to file dispute');
    renderPanel();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert).toHaveTextContent(/failed to file dispute/i);
    }
  });
});
