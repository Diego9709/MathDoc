import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeGoals, coordination, branchRoute, branchView, branchesNeeding, goalStatement, nextStep, openGoals, readOnlyReason, routeCloses, solvedGoals, spentBy, writtenBack, type Board, type Fact, type Run, type Writeback } from './coordination';

const fact = (id: string, goal: string, premises: string[] = [], state: Fact['state'] = 'active'): Fact =>
  ({ id, goal, premises, trust: 'trusted', state, available: true });
const board = (facts: Fact[], extra: Partial<Board> = {}): Board => ({
  id: 'p', title: 'T', owner: 'alice', members: ['alice'], revision: 1, root: 'T', minimum_trust: 'audited',
  notes: '', budget: 0, spent: 0, ready: true, goals: {}, tasks: {}, attempts: {}, runs: {},
  facts: Object.fromEntries(facts.map((f) => [f.id, f])), ...extra,
});

describe('project boards in the browser', () => {
  it('closes a route only through the branch picks and active facts', () => {
    const b = board([fact('t1', 'T', ['A']), fact('t2', 'T', ['B']), fact('b', 'B')]);
    expect(routeCloses(b, {})).toBe(true);
    expect(routeCloses(b, { T: 't1' }), 'A is not proved').toBe(false);
    expect(routeCloses(b, { T: 't2' })).toBe(true);
    b.facts.b.state = 'paused';
    expect(routeCloses(b, { T: 't2' })).toBe(false);
  });
  it('shows a branch view and explains read-only boards', () => {
    const request = { database: 'd', branch: 'main', node: 'n', environment_id: 'e', bound: true, stale: false };
    const project = board([], {
      project: { database: 'd', environment_id: 'e', root_node: 'n' },
      branches: { main: { request, nodes: {}, picks: { T: 't' }, writebacks: {} } },
    });
    expect(branchView(project, 'main')?.picks).toEqual({ T: 't' });
    expect(branchView(project, 'alt')).toBeNull();
    expect(readOnlyReason(project)).toBeNull();
    expect(readOnlyReason({ ...project, project: { ...project.project!, superseded: true } })).toMatch(/environment changed/);
    const legacy = board([], { request, nodes: {} });
    expect(branchView(legacy, 'other')?.request.branch).toBe('main');
    expect(readOnlyReason(legacy)).toMatch(/read-only/);
  });
  it('marks the certificates an assembly of the branch would use, as the coordinator picks them', () => {
    // T has a complete proof and a decomposition through A; A has two complete proofs. Listed in
    // the order the choice must not follow.
    const b = board([fact('a2', 'A'), fact('a1', 'A'), fact('t-split', 'T', ['A']), fact('t-full', 'T')]);
    const route = (picks: Record<string, string>) => [...(branchRoute(b, picks) ?? [])].sort();
    // Unpicked goals take the fewest premises first, then the smallest ID.
    expect(route({})).toEqual(['t-full']);
    expect(route({ A: 'a2' }), 'a pick below an unused goal changes nothing').toEqual(['t-full']);
    expect(route({ T: 't-split' })).toEqual(['a1', 't-split']);
    expect(route({ T: 't-split', A: 'a2' })).toEqual(['a2', 't-split']);
    // A pick of a certificate that is not active closes no route.
    b.facts.a2.state = 'paused';
    expect(branchRoute(b, { T: 't-split', A: 'a2' })).toBeNull();
    expect(routeCloses(b, { T: 't-split', A: 'a2' })).toBe(false);
  });
  it('tells which runs are already written back to their branch', () => {
    const request = { database: 'd', branch: 'alt', node: 'n', environment_id: 'e', bound: true, stale: false };
    const run = (id: string): Run => ({ id, component: 'lean-worker', status: 'certified', branch: 'alt', route: { root: 't', steps: [] } });
    const batch = (id: string, r: string, status: Writeback['status']): Writeback => ({ batch_id: id, run: r, status, created: [], updated: [] });
    const b = board([], {
      project: { database: 'd', environment_id: 'e', root_node: 'n' },
      runs: { r1: run('r1'), r2: run('r2'), r3: run('r3') },
      branches: { alt: { request, nodes: {}, picks: {}, writebacks: { w1: batch('w1', 'r1', 'committed'), w2: batch('w2', 'r2', 'aborted') } } },
    });
    expect(writtenBack(b, b.runs.r1)?.batch_id).toBe('w1');
    // An aborted batch wrote nothing: the run can be accepted again.
    expect(writtenBack(b, b.runs.r2)).toBeNull();
    expect(writtenBack(b, b.runs.r3)).toBeNull();
    // A run of a branch the reader cannot see.
    expect(writtenBack(b, { ...run('r1'), branch: 'hidden' })).toBeNull();
  });
  it('keeps the premises of a proposed decomposition out of scheduling until it is active', () => {
    const b = board([fact('t', 'T', ['A']), fact('p', 'A', ['B'], 'proposed')]);
    expect([...activeGoals(b)].sort()).toEqual(['A', 'T']);
    b.facts.p.state = 'active';
    expect([...activeGoals(b)].sort()).toEqual(['A', 'B', 'T']);
    // A registered negation of an active goal can be worked on, until its goal is refuted.
    b.negations = { N: 'B' };
    expect(activeGoals(b).has('N')).toBe(true);
    b.goals.B = { key: 'B', statement: 'b', status: 'insufficient', refuted: { certificate: 'n' } };
    expect(activeGoals(b).has('N')).toBe(false);
  });
  it('names the branches whose route can need a goal, following picks', () => {
    const request = { database: 'd', branch: 'main', node: 'n', environment_id: 'e', bound: true, stale: false };
    const state = (picks: Record<string, string>) => ({ request, nodes: {}, picks, writebacks: {} });
    const b = board([fact('t1', 'T', ['A']), fact('t2', 'T', ['B'])], {
      project: { database: 'd', environment_id: 'e', root_node: 'n' },
      branches: { main: state({ T: 't1' }), alt: state({ T: 't2' }), any: state({}) },
    });
    expect(branchesNeeding(b, 'A')).toEqual(['main', 'any']);
    expect(branchesNeeding(b, 'B')).toEqual(['alt', 'any']);
    expect(branchesNeeding(b, 'C')).toEqual([]);
  });
  it('states a goal by its declaration, proposition or name', () => {
    const b = board([], {
      goals: {
        A: { key: 'A', statement: 'a', status: 'insufficient', declaration: { name: 'a', binders: '(n : Nat)', type: 'n = n' } },
        B: { key: 'B', statement: 'b', status: 'insufficient', proposition: '∀ (n : Nat), n = n' },
        C: { key: 'C', statement: 'c', status: 'insufficient' },
      },
    });
    expect(goalStatement(b, 'A')).toBe('a (n : Nat) : n = n');
    expect(goalStatement(b, 'B')).toBe('∀ (n : Nat), n = n');
    expect(goalStatement(b, 'C')).toBe('c');
  });
  it('adds up the budget by agent identity, closed attempts as spent and open ones as reserved', () => {
    const attempt = (id: string, actor: string, spent: number, reserved: number, outcome?: string) =>
      ({ id, task: 't', actor, epoch: 1, expires: 0, spent, reserved, ...(outcome ? { outcome } : {}) });
    const b = board([], {
      attempts: {
        a: attempt('a', 'bob/agent-a', 30, 50, 'submitted'),
        b: attempt('b', 'bob/agent-a', 0, 20),
        c: attempt('c', 'bob/agent-b', 40, 40, 'expired'),
      },
    });
    expect(spentBy(b)).toEqual([
      { actor: 'bob/agent-b', spent: 40, reserved: 0, attempts: 1 },
      { actor: 'bob/agent-a', spent: 30, reserved: 20, attempts: 2 },
    ]);
  });
});

describe('the next step on a branch', () => {
  const request = { database: 'd', branch: 'main', node: 'n', environment_id: 'e', bound: true, stale: false };
  const goal = (key: string, status: Board['goals'][string]['status'] = 'insufficient') => ({ key, statement: key, status });
  const project = (facts: Fact[], extra: Partial<Board> = {}) => board(facts, {
    project: { database: 'd', environment_id: 'e', root_node: 'n' },
    goals: { T: goal('T'), A: goal('A'), B: goal('B') },
    branches: { main: { request, nodes: {}, picks: {}, writebacks: {} } },
    ...extra,
  });
  it('lists the unproved goals nobody has split yet, following picks', () => {
    const b = project([fact('t1', 'T', ['A']), fact('t2', 'T', ['B']), fact('a', 'A', ['B'])]);
    // T and A are split; B is the goal to work on.
    expect(openGoals(b, {})).toEqual(['B']);
    expect(openGoals(b, { T: 't2' })).toEqual(['B']);
    b.facts.b = fact('b', 'B');
    expect(openGoals(b, {})).toEqual([]);
    expect([...solvedGoals(b)].sort()).toEqual(['A', 'B', 'T']);
    // Only active certificates prove: a paused proof of B leaves B open again.
    b.facts.b.state = 'paused';
    expect(openGoals(b, {})).toEqual(['B']);
    // Below a goal proved some other way nothing is needed; a pick follows only its certificate.
    b.facts.c = fact('c', 'T');
    expect(openGoals(b, {})).toEqual([]);
    expect(openGoals(b, { T: 't1' })).toEqual(['B']);
    // A goal with no certificate at all is its own open goal.
    expect(openGoals(project([]), {})).toEqual(['T']);
    // A cycle: every unproved goal has a certificate, so all of them are listed.
    expect(openGoals(project([fact('t', 'T', ['A']), fact('a', 'A', ['T'])]), {}).sort()).toEqual(['A', 'T']);
  });
  it('walks from open goals to review, assembly, writeback and done', () => {
    const b = project([fact('t', 'T', ['A'])]);
    expect(nextStep(b, 'main', true)).toMatchObject({ tone: 'todo', view: 'tasks', text: expect.stringMatching(/^1 goal still needs a proof: A\./) });
    // A proposed split of A waits for the owner, whom the step names.
    b.facts.p = fact('p', 'A', ['B'], 'proposed');
    expect(nextStep(b, 'main', true)).toMatchObject({ tone: 'todo', view: 'decompositions', text: expect.stringMatching(/your review/) });
    expect(nextStep(b, 'main', false)).toMatchObject({ tone: 'wait', text: expect.stringMatching(/the owner's review/) });
    // A proved: the route closes, and the owner assembles it.
    b.facts.a = fact('a', 'A');
    expect(nextStep(b, 'main', true)).toMatchObject({ tone: 'todo', view: 'review', text: expect.stringMatching(/^Every goal on main's route has a proof\. Assemble/) });
    const run = (id: string, status: Run['status'], failure?: string): Run =>
      ({ id, component: 'lean-worker', status, branch: 'main', route: { root: 'T', steps: [] }, ...(failure ? { failure } : {}) });
    b.runs = { r1: run('r1', 'running') };
    expect(nextStep(b, 'main', true)).toMatchObject({ tone: 'wait', text: expect.stringMatching(/^Assembling/) });
    b.runs = { r1: run('r1', 'failed', 'lean_error') };
    expect(nextStep(b, 'main', true)?.text).toMatch(/failed \(lean_error\)/);
    // The latest run counts: a later certified run waits to be written back.
    b.runs.r2 = run('r2', 'certified');
    expect(nextStep(b, 'main', true)).toMatchObject({ tone: 'todo', text: expect.stringMatching(/Preview what it changes/) });
    expect(nextStep(b, 'main', false)).toMatchObject({ tone: 'wait', text: expect.stringMatching(/waits for the owner/) });
    b.branches!.main.writebacks = { w: { batch_id: 'w', run: 'r2', status: 'committed', created: [], updated: [] } };
    expect(nextStep(b, 'main', true)).toMatchObject({ tone: 'done', text: expect.stringMatching(/^Proved\./) });
  });
  it('defers to the warnings and names unattached, converting and refuted branches', () => {
    const b = project([]);
    expect(nextStep(b, 'alt', true)).toMatchObject({ text: expect.stringMatching(/not attached/) });
    expect(nextStep({ ...b, ready: false }, 'main', true)).toMatchObject({ tone: 'wait', text: expect.stringMatching(/^Converting/) });
    expect(nextStep({ ...b, sync_error: 'down' }, 'main', true)).toBeNull();
    expect(nextStep({ ...b, branches: { main: { ...b.branches!.main, request: { ...request, stale: true } } } }, 'main', true)).toBeNull();
    expect(nextStep({ ...b, project: { ...b.project!, superseded: true } }, 'main', true)).toBeNull();
    expect(nextStep({ ...b, goals: { ...b.goals, T: { ...goal('T'), refuted: { certificate: 'n' } } } }, 'main', true)).toMatchObject({ tone: 'done', text: expect.stringMatching(/^Refuted/) });
  });
});

describe('sending commands', () => {
  afterEach(() => vi.unstubAllGlobals());
  const headers = (call: unknown[]) => new Headers((call[1] as RequestInit).headers);
  it('sends an outdated revision again at the latest one, once the board says which', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ reason: 'revision_conflict' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ id: 'p', revision: 7 }))
      .mockResolvedValueOnce(Response.json({ revision: 8, result: { id: 'run' } }));
    vi.stubGlobal('fetch', fetchMock);
    const reply = await coordination.command({ id: 'p', revision: 5 }, { type: 'assemble', component: 'lean-worker', branch: 'main' });
    expect(reply.revision).toBe(8);
    expect(headers(fetchMock.mock.calls[0]!).get('if-match')).toBe('"5"');
    expect(headers(fetchMock.mock.calls[2]!).get('if-match')).toBe('"7"');
    // The same request, so a lost reply would replay rather than run twice.
    expect(headers(fetchMock.mock.calls[2]!).get('idempotency-key')).toBe(headers(fetchMock.mock.calls[0]!).get('idempotency-key'));
  });
  it('gives up after three conflicts and passes other refusals on at once', async () => {
    const conflict = () => Promise.resolve(Response.json({ reason: 'revision_conflict' }, { status: 409 }));
    const board = () => Promise.resolve(Response.json({ id: 'p', revision: 1 }));
    const fetchMock = vi.fn<typeof fetch>((input) => (String(input).endsWith('/commands') ? conflict() : board()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(coordination.command({ id: 'p', revision: 0 }, { type: 'accept', run: 'r' })).rejects.toMatchObject({ message: 'revision_conflict' });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/commands'))).toHaveLength(4);
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ reason: 'owner_required' }, { status: 403 })));
    fetchMock.mockClear();
    await expect(coordination.command({ id: 'p', revision: 0 }, { type: 'accept', run: 'r' })).rejects.toMatchObject({ message: 'owner_required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('sends commands checked against the current board with If-Match *', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ revision: 3, result: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await coordination.command({ id: 'p', revision: 3 }, { type: 'note', goal: 'G', text: 'tried induction' });
    expect(headers(fetchMock.mock.calls[0]!).get('if-match')).toBe('*');
  });
});
