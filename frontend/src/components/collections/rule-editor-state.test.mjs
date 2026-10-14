import assert from 'node:assert/strict';
import test from 'node:test';
import { saveTierLevels, validTierLevels } from './rule-editor-state.ts';

const levels = [30, 50, 100, 150, 200].map((minimum, index) => ({ key: String(index), minimumTonnes: String(minimum), benefitValue: String([250, 350, 400, 425, 450][index]) }));
test('all five valid levels are retained and only obsolete thresholds removed', async () => {
  const events = [];
  await saveTierLevels([{ id: 'retain', minimum_tonnes: '30.000000' }, { id: 'remove', minimum_tonnes: '999' }], levels, {
    save: async tier => events.push(`save:${tier.minimumTonnes}`), remove: async tier => events.push(`remove:${tier.id}`),
  });
  assert.deepEqual(events, ['save:30', 'save:50', 'save:100', 'save:150', 'save:200', 'remove:remove']);
});
test('failed replacement writes never remove existing levels', async () => {
  let removed = false;
  await assert.rejects(saveTierLevels([{ id: 'old', minimum_tonnes: '999' }], levels, {
    save: async () => { throw new Error('offline'); }, remove: async () => { removed = true; },
  }), /offline/);
  assert.equal(removed, false);
});
test('missing, duplicate and invalid levels are rejected before writing', async () => {
  for (const invalid of [[], [levels[0], { ...levels[0], minimumTonnes: '30.0' }], [{ ...levels[0], benefitValue: 'NaN' }], [{ ...levels[0], minimumTonnes: '-1' }]]) {
    assert.equal(validTierLevels(invalid), false);
    await assert.rejects(saveTierLevels([], invalid, { save: async () => assert.fail('must not write'), remove: async () => assert.fail('must not delete') }));
  }
});
