const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('chatgpt-proxy.js', 'utf8');

function createEditor({ tag = 'DIV', readOnly = false, inDialog = false, visible = true } = {}) {
  return {
    matches(selector) {
      return selector === ':disabled, [readonly]' ? readOnly : selector.includes(tag === 'TEXTAREA' ? 'textarea' : 'contenteditable');
    },
    closest: () => inDialog ? {} : null,
    classList: { contains: () => false },
    querySelectorAll: () => [],
    getClientRects: () => visible ? [{}] : [],
  };
}

function loadProxy({ anchors = [], regions = [], modernEditors = [], onWait, execCommand, title = '' } = {}) {
  let now = 0;
  const context = vm.createContext({
    console: { log() {} },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    window: {
      innerWidth: 1024,
      getComputedStyle: () => ({ visibility: 'visible' }),
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    },
    DataTransfer: class {
      setData(type, value) { this[type] = value; }
    },
    Event: class {
      constructor(type, init) { Object.assign(this, { type }, init); }
    },
    ClipboardEvent: class {
      constructor(type, init) { Object.assign(this, { type }, init); }
    },
    document: {
      title,
      execCommand,
      createRange: () => ({ selectNodeContents() {} }),
      getElementById: id => id === 'dth-1px-host' ? {} : null,
      querySelectorAll: selector => {
        if (selector.startsWith('#prompt-textarea')) return anchors;
        if (selector.startsWith('main .ProseMirror')) return modernEditors;
        return regions;
      },
    },
    Date: { now: () => now },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    setTimeout(callback, delay) {
      now += delay;
      onWait?.();
      queueMicrotask(callback);
    },
  });
  vm.runInContext(source, context);
  return context;
}

test('waits for the ChatGPT composer to mount', async () => {
  const anchors = [];
  const editor = createEditor();
  const { waitForChatGPTComposer } = loadProxy({ anchors, onWait: () => anchors.push(editor) });
  assert.equal(await waitForChatGPTComposer(1000), editor);
});

test('finds a writable textarea in a composer region without the old ID', () => {
  const editor = createEditor({ tag: 'TEXTAREA' });
  const { findChatGPTComposer } = loadProxy({
    anchors: [createEditor({ visible: false })],
    regions: [{ querySelectorAll: () => [createEditor({ readOnly: true }), editor] }],
  });
  assert.equal(findChatGPTComposer(), editor);
});

test('finds the ProseMirror textbox from the new ChatGPT layout without historic composer IDs', () => {
  const editor = createEditor();
  const { findChatGPTComposer } = loadProxy({ modernEditors: [editor] });
  assert.equal(findChatGPTComposer(), editor);
});

test('reads ProseMirror text without layout spacing or duplicated link widgets', () => {
  const text = data => ({ nodeType: 3, data });
  const element = (tagName, childNodes, decoration = false) => ({
    nodeType: 1, tagName, childNodes, matches: () => decoration,
  });
  const editor = {
    tagName: 'DIV',
    classList: { contains: token => token === 'ProseMirror' },
    innerText: 'See https://example.test /docs\nFollow-up',
    childNodes: [
      element('P', [
        text('See '),
        element('SPAN', [
          element('SPAN', [text('https://example.test')], true),
          text('https://example.test'),
        ]),
        text('/docs'),
      ]),
      element('P', [element('BR', [], true)]),
      element('P', [text('Follow-up'), element('BR', []), text('next line')]),
    ],
  };
  const { readChatGPTComposerText } = loadProxy();
  assert.equal(readChatGPTComposerText(editor), 'See https://example.test/docs\n\nFollow-up\nnext line\n');
});

test('selects a send control from the composer and does not click the voice button', () => {
  const button = (label, matches = false) => ({
    getAttribute: key => key === 'aria-label' ? label : null,
    getClientRects: () => [{}],
    matches: () => matches,
  });
  const voice = button('Начать голосовой разговор', true);
  const send = button('Отправить запрос');
  const { findChatGPTSendButton } = loadProxy();
  const editor = { closest: () => ({ querySelectorAll: () => [voice, send] }) };
  assert.equal(findChatGPTSendButton(editor), send);
});

test('does not choose an editor inside a dialog or an ambiguous composer region', async () => {
  const { waitForChatGPTComposer } = loadProxy({
    anchors: [createEditor({ inDialog: true })],
    regions: [{ querySelectorAll: () => [createEditor(), createEditor()] }],
  });
  await assert.rejects(waitForChatGPTComposer(500), /Не найдено доступное поле ввода/);
});

test('reports a verification page without looking for a usable editor there', async () => {
  const { waitForChatGPTComposer } = loadProxy({
    title: 'Один момент…',
    onWait: () => assert.fail('verification should be left for the user'),
  });
  await assert.rejects(waitForChatGPTComposer(), { code: 'verification' });
});

function pasteFixture(onPaste, onWait, onNativeInsert) {
  const actions = [];
  const pastes = [];
  const scope = { querySelectorAll: () => actions };
  const editor = {
    ...createEditor(),
    tagName: 'DIV',
    isConnected: true,
    innerText: '',
    closest: selector => selector === 'fieldset' ? scope : null,
    focus() {},
    dispatchEvent(event) {
      if (event.type === 'paste') {
        const text = event.clipboardData['text/plain'];
        pastes.push(text);
        onPaste?.(text);
      }
    },
  };
  const nativeInserts = [];
  if (onNativeInsert) {
    const matchesEditor = editor.matches;
    editor.matches = selector => selector === '.ProseMirror' || matchesEditor(selector);
  }
  const editors = [editor];
  const { insertChatGPTPrompt } = loadProxy({
    anchors: editors, onWait,
    execCommand(command, showUi, text) {
      assert.equal(command, 'insertText');
      assert.equal(showUi, false);
      nativeInserts.push(text);
      return onNativeInsert?.(text) ?? false;
    },
  });
  return {
    editor, editors, actions, pastes, nativeInserts,
    insert: text => insertChatGPTPrompt(editor, text),
  };
}

function textAttachmentAction(click, label = 'Показать в текстовом поле') {
  return { getClientRects: () => [{}], getAttribute: () => null, innerText: label, click };
}

test('pastes a short prompt once and verifies the text in the editor', async () => {
  const fixture = pasteFixture(text => { fixture.editor.innerText = text; });
  assert.equal(await fixture.insert('A short prompt'), fixture.editor);
  assert.deepEqual(fixture.pastes, ['A short prompt']);
});

test('inserts long plain text into ProseMirror without creating a paste card', async () => {
  const text = 'Line with markers: **bold**\n'.repeat(420).trim();
  const fixture = pasteFixture(null, null, value => {
    fixture.editor.innerText = value;
    return true;
  });
  assert.equal(await fixture.insert(text), fixture.editor);
  assert.deepEqual(fixture.nativeInserts, [text]);
  assert.deepEqual(fixture.pastes, []);
});

test('expands an asynchronous long-paste attachment and verifies the replacement editor', async () => {
  const text = 'A long prompt. '.repeat(1000).trim();
  let pendingAttachment = false;
  let reveals = 0;
  const fixture = pasteFixture(() => { pendingAttachment = true; }, () => {
    if (!pendingAttachment) return;
    pendingAttachment = false;
    fixture.actions.push(textAttachmentAction(() => {
      reveals++;
      fixture.actions.length = 0;
      fixture.editor.isConnected = false;
      fixture.editors[0] = { ...fixture.editor, isConnected: true, innerText: text };
    }));
  }, () => false);
  assert.equal(await fixture.insert(text), fixture.editors[0]);
  assert.equal(reveals, 1);
  assert.deepEqual(fixture.pastes, [text]);
  assert.deepEqual(fixture.nativeInserts, [text]);
});

test('leaves a pre-existing paste attachment alone and does not add another', async () => {
  const fixture = pasteFixture();
  fixture.actions.push(textAttachmentAction(() => assert.fail('do not touch an older draft'), 'Show in text field'));
  await assert.rejects(fixture.insert('New prompt'), /карточка с текстом предыдущего запроса/);
  assert.deepEqual(fixture.pastes, []);
});

test('rejects partial text after expanding a paste attachment', async () => {
  const fixture = pasteFixture(() => {
    fixture.actions.push(textAttachmentAction(() => {
      fixture.actions.length = 0;
      fixture.editor.innerText = 'Truncated content';
    }));
  });
  await assert.rejects(fixture.insert('A complete prompt'), /Не удалось развернуть вложенный текст запроса целиком/);
  assert.deepEqual(fixture.pastes, ['A complete prompt']);
});

test('ignores invisible editor markers when verifying the text', async () => {
  const fixture = pasteFixture(text => { fixture.editor.innerText = '\u200B' + text + '\uFEFF'; });
  assert.equal(await fixture.insert('Text with **literal** markers'), fixture.editor);
});
