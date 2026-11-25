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
  const editor = { value: '', matches: selector => selector === 'textarea', focus() {} };
  const agent = vm.createContext({
    STATE: { settings: {} },
    editor,
    inputEvents: [],
    Math: Object.create(Math),
    xAgentPaused: false,
    xAgentNextReplyMs: null,
    performance: { now: () => clock },
    updateXAgentPanel() {},
    setXTextareaText(compose, value, type, data) {
      compose.value = value;
      agent.inputEvents.push({ value, type, data, at: clock });
    },
    async replaceComposeText(compose, value) { compose.value = value; },
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
    section('async function waitForXAgentCountdown', 'async function runXAgentReply')
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

test('CRM reading delay has its own random 3-5 second default', () => {
  const agent = createAgent();
  const draw = () => vm.runInContext('getRandomAgentDelayMs(X_RELATIONSHIP_READ_DELAY)', agent);
  assert.equal(draw(), 3000);
  agent.Math.random = () => 0.9999;
  assert.equal(draw(), 5000);
  agent.STATE.settings.xRelationshipReadDelayMinSeconds = 10;
  agent.STATE.settings.xRelationshipReadDelayMaxSeconds = 10;
  assert.equal(draw(), 11000);
  assert.equal(vm.runInContext('getRandomAgentDelayMs(X_AGENT_BEFORE_REPLY)', agent), 3000);
});

test('before-reply countdown waits for resume and clears after cancellation', async () => {
  const paused = createAgent({
    afterSleep(agent, clock) {
      if (clock === 400) agent.xAgentPaused = false;
    }
  });
  paused.xAgentPaused = true;
  assert.equal(await vm.runInContext(
    "waitForXAgentCountdown(getRandomAgentDelayMs(X_AGENT_BEFORE_REPLY), () => true, 'Waiting', true)", paused
  ), true);
  assert.equal(paused.performance.now(), 1400);
  assert.equal(paused.xAgentNextReplyMs, null);

  const stopped = createAgent({
    afterSleep(agent) { agent.canWrite = false; }
  });
  stopped.canWrite = true;
  assert.equal(await vm.runInContext(
    "waitForXAgentCountdown(getRandomAgentDelayMs(X_RELATIONSHIP_READ_DELAY), () => canWrite, 'Reading post')", stopped
  ), false);
  assert.equal(stopped.performance.now(), 200);
  assert.equal(stopped.xAgentNextReplyMs, null);
});

test('gradual typing writes full graphemes and stops when the user edits', async () => {
  const agent = createAgent();
  const emoji = '\u{1F469}\u200D\u{1F4BB}';
  agent.reply = 'A' + emoji + '!';
  assert.equal(await vm.runInContext('writeXAgentReply(editor, reply, () => true, false)', agent), true);
  assert.deepEqual(agent.inputEvents.map(event => event.data), ['A', emoji, '!']);
  assert.equal(agent.editor.value, agent.reply);

  const edited = createAgent({ afterSleep(agent) { agent.editor.value = 'User edit'; } });
  assert.equal(await vm.runInContext("writeXAgentReply(editor, 'Hello', () => true, false)", edited), false);
  assert.equal(edited.editor.value, 'User edit');
  assert.equal(edited.inputEvents.length, 1);

  agent.STATE.settings.xAgentTypeRepliesGradually = false;
  assert.equal(await vm.runInContext("writeXAgentReply(editor, 'Immediate', () => true, false)", agent), true);
  assert.equal(agent.editor.value, 'Immediate');
  assert.equal(agent.inputEvents.length, 3);
});

test('gradual typing samples a different pace for each word', async () => {
  const agent = createAgent();
  agent.Math.random = () => agent.inputEvents.length > 2 ? 0.9 : 0;
  agent.reply = 'ab cd';
  assert.equal(await vm.runInContext('writeXAgentReply(editor, reply, () => true, false)', agent), true);
  const [a, b, , c, d] = agent.inputEvents;
  assert.ok(d.at - c.at > 2 * (b.at - a.at));
  assert.equal(agent.editor.value, agent.reply);
});

test('typing can pass through a word break or pause within a word', () => {
  const agent = createAgent();
  const delay = (chunk, ...random) => {
    agent.chunk = chunk;
    agent.Math.random = () => random.shift() ?? 0;
    return vm.runInContext('getXReplyTypingDelay(chunk, 1, 60)', agent);
  };
  const normal = delay('a', 0.5, 0.2);
  assert.equal(delay(' ', 0.5, 0.2), normal);
  assert.ok(delay(' ', 0.5, 0.9, 0.5) > normal + 250);
  assert.ok(delay('a', 0.5, 0.99, 0.99) >= 1000);
  assert.ok(delay(',') > delay('a'));
  assert.ok(delay('.') > delay(','));
  assert.ok(delay('\n') > delay('.'));
});

test('CRM waits on the post, opens the editor, and waits again before writing', () => {
  const flow = section('async function runXAgentReply', 'function currentXRelationshipPending');
  assert.match(flow, /if \(options\.relationshipAuthor\) \{[\s\S]+getRandomAgentDelayMs\(X_RELATIONSHIP_READ_DELAY\)[\s\S]+await openReplyComposer/);
  assert.match(flow, /await openReplyComposer[\s\S]+getRandomAgentDelayMs\(X_AGENT_BEFORE_REPLY\)[\s\S]+await writeXAgentReply[\s\S]+await maybeSubmitReply/);
});
