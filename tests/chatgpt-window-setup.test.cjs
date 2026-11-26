const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('background.js', 'utf8');
const helpersStart = source.indexOf('function normalizeChatGPTConversationUrl');
const helpersEnd = source.indexOf('async function executeChatGPTFetchInTab');
const handlerStart = source.indexOf("if (msg && msg.type === 'setup-chatgpt-window')");
const handlerEnd = source.lastIndexOf('\n});');
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);

function setupFixture({ tabs, selected, check = () => ({ ok: false }), configuredUrl = '', screen = { width: 1280, height: 800 } }) {
  const events = [];
  let target;
  let focusedWindow = 1;
  const mainWindow = { id: 1, width: 1280, height: 800, state: 'maximized' };
  const helperWindow = { id: 8, width: 1024, height: 800, state: 'normal' };
  const chrome = {
    runtime: {},
    storage: { local: {
      get: async () => ({ chatgptUiTarget: target || selected }),
      set: async data => { target = data.chatgptUiTarget; },
    } },
    tabs: {
      query: async () => tabs,
      sendMessage(id, msg, opts, callback = opts) {
        if (msg.type === 'ping') callback({ ok: true });
        if (msg.type === 'get-screen-size') {
          events.push(['screen', id]);
          callback(screen);
        }
        if (msg.type === 'chatgpt-composer-status') {
          assert.equal(opts.frameId, 0);
          events.push(['composer', id, msg.wait]);
          callback(check(id, msg.wait, helperWindow.width));
        }
      },
    },
    windows: {
      getLastFocused: async () => focusedWindow === 1 ? mainWindow : helperWindow,
      get: async id => id === mainWindow.id ? mainWindow : helperWindow,
      create: async options => {
        events.push(['windows.create', options.tabId]);
        tabs.find(tab => tab.id === options.tabId).windowId = helperWindow.id;
        helperWindow.width = options.width;
        if (options.focused) focusedWindow = helperWindow.id;
        return helperWindow;
      },
      update: async (id, options) => {
        events.push(['windows.update', id, options]);
        Object.assign(id === helperWindow.id ? helperWindow : mainWindow, options);
        if (options.focused) focusedWindow = id;
      },
    },
  };
  const context = vm.createContext({
    URL, chrome,
    CHATGPT_UI_TARGET_KEY: 'chatgptUiTarget',
    CHATGPT_HELPER_WIDTH: 1024,
    getSettings: async () => ({ chatgptConversationUrl: configuredUrl }),
    setTimeout: callback => queueMicrotask(callback),
    clearTimeout() {},
  });
  vm.runInContext(source.slice(helpersStart, helpersEnd), context);
  vm.runInContext(`function handle(msg, sender, sendResponse) { ${source.slice(handlerStart, handlerEnd)} }`, context);
  return {
    events,
    get target() { return target; },
    get focusedWindow() { return focusedWindow; },
    getUiTab: () => context.getActiveChatGPTTab({ ui: true }),
    run: (options = {}, sender = {}) => new Promise(resolve => {
      assert.equal(context.handle({ type: 'setup-chatgpt-window', ...options }, sender, resolve), true);
    }),
  };
}

test('1px setup prefers the active ChatGPT tab over an old helper', async () => {
  const fixture = setupFixture({
    tabs: [
      { id: 10, windowId: 8, active: true, url: 'https://chatgpt.com/' },
      { id: 20, windowId: 1, active: true, url: 'https://chatgpt.com/' },
    ],
    selected: { tabId: 10, windowId: 8 },
  });
  assert.equal((await fixture.run()).ok, true);
  assert.equal(fixture.events.some(([name]) => name === 'composer'), false);
  assert.equal(fixture.target.tabId, 20);
  assert.equal(fixture.target.windowId, 8);
  assert.equal((await fixture.getUiTab()).id, 20);
});

test('1px keeps the same gap and detached window even when no composer responds', async () => {
  const fixture = setupFixture({
    tabs: [{ id: 20, windowId: 1, active: true, url: 'https://chatgpt.com/' }],
  });
  assert.equal((await fixture.run({}, { tab: { id: 20 } })).ok, true);
  assert.deepEqual(fixture.events[0], ['windows.create', 20]);
  assert.equal(fixture.focusedWindow, 1);
  assert.equal(fixture.target.tabId, 20);
  const [, , helper] = fixture.events.find(([name, id]) => name === 'windows.update' && id === 8);
  const [, , main] = fixture.events.find(([name, id, data]) => name === 'windows.update' && id === 1 && data.focused);
  assert.equal(helper.left, 0);
  assert.equal(helper.width, 1024);
  assert.equal(main.left - helper.left, 1);
  assert.equal(main.width, 1279);
});

test('1px reuses its detached window on repeated setup', async () => {
  const fixture = setupFixture({
    tabs: [{ id: 20, windowId: 1, active: true, url: 'https://chatgpt.com/' }],
  });
  assert.equal((await fixture.run()).ok, true);
  assert.equal((await fixture.run()).ok, true);
  assert.equal(fixture.events.filter(([name]) => name === 'windows.create').length, 1);
  assert.equal(fixture.target.tabId, 20);
  assert.equal(fixture.focusedWindow, 1);
});

test('1px keeps the gap when the left edge of the work area is not zero', async () => {
  const fixture = setupFixture({
    tabs: [{ id: 20, windowId: 1, active: true, url: 'https://chatgpt.com/' }],
    screen: { left: -1280, top: 48, width: 1280, height: 800 },
  });
  assert.equal((await fixture.run()).ok, true);
  const [, , helper] = fixture.events.find(([name, id]) => name === 'windows.update' && id === 8);
  const [, , main] = fixture.events.find(([name, id, data]) => name === 'windows.update' && id === 1 && data.focused);
  assert.equal(helper.left, -1280);
  assert.equal(main.left, -1279);
  assert.equal(main.top, 48);
});

test('popup 1px uses its own monitor bounds even if the new ChatGPT tab does not answer', async () => {
  const fixture = setupFixture({
    tabs: [{ id: 20, windowId: 1, active: true, url: 'https://chatgpt.com/' }],
    screen: null,
  });
  assert.equal((await fixture.run({
    originWindowId: 1, screenBounds: { width: 2560, height: 1440, left: 1280, top: 10 },
  })).ok, true);
  assert.equal(fixture.events.some(([name]) => name === 'screen'), false);
  const [, , main] = fixture.events.find(([name, id, data]) => name === 'windows.update' && id === 1 && data.focused);
  assert.equal(main.width, 2559);
  assert.equal(main.left, 1281);
  assert.equal(main.top, 10);
});

test('when no screen reports its bounds, 1px retains the existing window size', async () => {
  const fixture = setupFixture({
    tabs: [{ id: 20, windowId: 1, active: true, url: 'https://chatgpt.com/' }],
    screen: null,
  });
  assert.equal((await fixture.run()).ok, true);
  const [, , main] = fixture.events.find(([name, id, data]) => name === 'windows.update' && id === 1 && data.focused);
  assert.equal(main.width, 1279);
});
