const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('chatgpt-proxy.js', 'utf8');

function responseBody(id, text, state = 'complete') {
  return {
    id, text, state,
    get innerText() { return this.text; },
    getClientRects: () => [{}],
    getAttribute(name) { return name === 'data-response-body' ? this.id : null; },
    closest(selector) {
      return selector === '[data-talvt-turn-state]' && this.state
        ? { getAttribute: () => this.state }
        : null;
    },
    querySelector: () => null,
    matches: () => true,
  };
}

function control(label) {
  return {
    getClientRects: () => [{}],
    closest: () => null,
    getAttribute: key => key === 'aria-label' ? label : null,
  };
}

function responseFixture({ bodies = [], buttons = [], stop = [], afterDelay } = {}) {
  let now = 0;
  const context = vm.createContext({
    console: { log() {} },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    document: {
      getElementById: id => id === 'dth-1px-host' ? {} : null,
      querySelectorAll(selector) {
        if (selector.startsWith('[data-response-body],')) return bodies;
        if (selector.startsWith('[data-testid="stop-button"]')) return stop;
        if (selector === 'button') return buttons;
        return [];
      },
    },
    Date: { now: () => now },
    setTimeout(callback, ms) {
      now += ms;
      afterDelay?.(now);
      queueMicrotask(callback);
    },
  });
  vm.runInContext(source, context);
  return {
    snapshot: context.getLatestChatGPTResponse,
    wait: context.waitForChatGPTResponse,
    elapsed: () => now,
  };
}

test('reads a new complete response body even if an obsolete Stop control remains', async () => {
  const bodies = [responseBody('previous', 'Same final text')];
  const { snapshot, wait } = responseFixture({ bodies, stop: [control('Stop')] });
  const previous = snapshot();
  bodies.splice(0, 1, responseBody('latest', previous.text));
  assert.equal(await wait(previous, 3000), previous.text);
});

test('does not return stable partial text before its turn is complete', async () => {
  const bodies = [];
  const next = responseBody('latest', 'Partial answer', 'streaming');
  const run = responseFixture({
    bodies,
    afterDelay(now) {
      if (now === 2800) {
        next.text = 'Finished answer\n\nSecond paragraph';
        next.state = 'complete';
      }
    },
  });
  const previous = run.snapshot();
  bodies.push(next);
  assert.equal(await run.wait(previous, 5500), 'Finished answer\n\nSecond paragraph');
  assert.ok(run.elapsed() >= 4800);
});

test('does not return the existing answer or a reformatted version of that turn', async () => {
  const bodies = [responseBody('previous', 'Previous answer')];
  const { snapshot, wait } = responseFixture({ bodies });
  const previous = snapshot();
  bodies[0] = responseBody('previous', 'Previous answer with a new display state');
  await assert.rejects(wait(previous, 3000), /Таймаут ожидания ответа/);
});

test('without an explicit completion marker waits for Stop to disappear', async () => {
  const bodies = [];
  const stop = [control('Stop')];
  const run = responseFixture({
    bodies, stop,
    afterDelay(now) {
      if (now === 2800) stop.length = 0;
    },
  });
  const previous = run.snapshot();
  bodies.push(responseBody('latest', 'Text on the older layout', ''));
  assert.equal(await run.wait(previous, 5500), 'Text on the older layout');
  assert.ok(run.elapsed() >= 4800);
});

test('an interrupted answer is not delivered while Continue generating is present', async () => {
  const bodies = [];
  const { snapshot, wait } = responseFixture({ bodies, buttons: [control('Продолжить генерацию')] });
  const previous = snapshot();
  bodies.push(responseBody('latest', 'Interrupted answer'));
  await assert.rejects(wait(previous, 4000), /остановил ответ до завершения/);
});
