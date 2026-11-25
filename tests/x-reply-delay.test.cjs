const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('x-content.js', 'utf8');
function section(first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return source.slice(start, end);
}

function createAgent({ afterSleep } = {}) {
  let clock = 0;
  const agent = vm.createContext({
    STATE: { settings: {} },
    Math: Object.create(Math),
    xAgentPaused: false,
    xAgentNextReplyMs: null,
    performance: { now: () => clock },
    updateXAgentPanel() {},
    async sleep(ms) {
      clock += ms;
      afterSleep?.(agent, clock);
    }
  });
  agent.Math.random = () => 0;
  vm.runInContext([
    section('const X_AGENT_BETWEEN_REPLIES', 'function scheduleXAgentSettingSave'),
    section('function normalizeXAgentNumber', 'function normalizeXAgentDelayPair'),
    section('function getAgentDelayRange', 'function findSubmitButton'),
    section('async function waitBeforeXAgentReply', 'async function runXAgentReply')
  ].join('\n'), agent);
  return agent;
}

test('before-reply delay draws from the configured bounds each time', () => {
  const agent = createAgent();
  const draw = () => vm.runInContext('getRandomAgentDelayMs(X_AGENT_BEFORE_REPLY)', agent);
  assert.equal(draw(), 1000);
  agent.Math.random = () => 0.9999;
  assert.equal(draw(), 3000);

  agent.STATE.settings.xAgentBeforeReplyMinSeconds = 9;
  agent.STATE.settings.xAgentBeforeReplyMaxSeconds = 3;
  assert.equal(draw(), 9000);
  agent.Math.random = () => 0;
  assert.equal(draw(), 3000);

  agent.STATE.settings.xAgentBeforeReplyMinSeconds = 600;
  agent.STATE.settings.xAgentBeforeReplyMaxSeconds = 600;
  assert.equal(draw(), 599000);
  assert.equal(vm.runInContext('getRandomAgentDelayMs()', agent), 30000);
});

test('before-reply countdown waits for resume and clears after cancellation', async () => {
  const paused = createAgent({
    afterSleep(agent, clock) {
      if (clock === 400) agent.xAgentPaused = false;
    }
  });
  paused.xAgentPaused = true;
  assert.equal(await vm.runInContext('waitBeforeXAgentReply(() => true, true)', paused), true);
  assert.equal(paused.performance.now(), 1400);
  assert.equal(paused.xAgentNextReplyMs, null);

  const stopped = createAgent({
    afterSleep(agent) { agent.canWrite = false; }
  });
  stopped.canWrite = true;
  assert.equal(await vm.runInContext('waitBeforeXAgentReply(() => canWrite, false)', stopped), false);
  assert.equal(stopped.performance.now(), 200);
  assert.equal(stopped.xAgentNextReplyMs, null);
});

test('reply flow waits after opening the editor and before inserting text', () => {
  const flow = section('async function runXAgentReply', 'function currentXRelationshipPending');
  assert.match(flow, /await openReplyComposer[\s\S]+await waitBeforeXAgentReply[\s\S]+await replaceComposeText/);
});
