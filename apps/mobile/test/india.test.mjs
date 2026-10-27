// The state picker on the details screen (src/lib/india.ts). Run: npm test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { INDIAN_STATES, matchStates, stateName } from '../src/lib/india.ts';

test('finds a state by the start of any word in its name', () => {
  assert.deepEqual(
    matchStates('pra').map(([, name]) => name),
    ['Andhra Pradesh', 'Arunachal Pradesh', 'Himachal Pradesh', 'Madhya Pradesh', 'Uttar Pradesh'],
  );
  assert.deepEqual(matchStates('tamil n').map(([code]) => code), ['33']);
  assert.deepEqual(matchStates('BENGAL').map(([code]) => code), ['19']);
  assert.deepEqual(matchStates('  '), []);
  assert.equal(stateName('29'), 'Karnataka');
  assert.equal(stateName('25'), null); // Daman and Diu's old code, merged into 26 in 2020
});

test('offers exactly the states and codes the API accepts', () => {
  const api = readFileSync(new URL('../../api/src/money/gst.ts', import.meta.url), 'utf8');
  const accepted = [...api.matchAll(/^ {2}'(\d{2})': '([^']+)',$/gm)].map(([, code, name]) => `${code} ${name}`).sort();
  assert.equal(accepted.length, 36);
  assert.deepEqual(INDIAN_STATES.map(([code, name]) => `${code} ${name}`).sort(), accepted);
});
