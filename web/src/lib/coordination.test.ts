import { describe, expect, it } from 'vitest';
import { branchView, readOnlyReason, routeCloses, type Board, type Fact } from './coordination';

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
});
