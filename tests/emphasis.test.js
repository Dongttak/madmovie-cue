import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceClock, sourceAt, outputAt, continuitySegments, withoutAccents } from '../dist/emphasis.js';

test('selective slow clock is monotone, reversible and joins native speed smoothly', () => {
  const segment = { sourceStart: 10, sourceDuration: 3, duration: 3.3, timelineStart: 4, accent: { time: 11.5, kind: 'slow' } };
  let last = -1;
  for (let i = 0; i <= 600; i++) {
    const source = 10+i/200, output = outputAt(source, segment);
    assert.ok(output > last); last = output;
    assert.ok(Math.abs(sourceAt(output-4, segment)-source) < 1e-7);
  }
  assert.equal(sourceClock(0, 1.5, true), 0);
  assert.equal(sourceClock(3, 1.5, true), 3.3);
  for (const at of [1.2, 1.8]) {
    const derivative = (sourceClock(at+1e-5, 1.5, true)-sourceClock(at-1e-5, 1.5, true))/2e-5;
    assert.ok(Math.abs(derivative-1) < 1e-5);
  }
  assert.ok(Math.abs((sourceClock(1.50001,1.5,true)-sourceClock(1.49999,1.5,true))/.00002-2) < 1e-5);
});

test('comparison removes effects without losing source ranges or adding gaps', () => {
  const segments = continuitySegments([{ start: .25, end: 2.75, accent: { time: 1.5, kind: 'slow' } },
    { start: 5, end: 7, accent: { time: 6, kind: 'focus' } }], 60);
  assert.equal(segments[1].timelineStart, 2.8);
  const plain = withoutAccents(segments);
  assert.deepEqual(plain, [{ fileIndex: 0, sourceStart: .25, duration: 2.5, timelineStart: 0 },
    { fileIndex: 1, sourceStart: 5, duration: 2, timelineStart: 2.5 }]);
});
