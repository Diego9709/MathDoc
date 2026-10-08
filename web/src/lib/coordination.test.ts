import { describe, expect, it } from 'vitest';
import { activeGoals, branchView, branchesNeeding, goalStatement, readOnlyReason, routeCloses, spentBy, type Board, type Fact } from './coordination';

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
