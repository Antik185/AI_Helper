const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('x-content.js', 'utf8');
const helperStart = source.indexOf('function getFocusedXCompose');
const helperEnd = source.indexOf('function composeHasText');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'X composer reuse helpers were not found');

function compose({ inDialog = false } = {}) {
  return {
    isConnected: true,
    matches(selector) {
      return selector === 'compose';
    },
    closest(selector) {
      return selector === '[role="dialog"]' && inDialog ? {} : null;
    }
  };
}

function article(postId, containedCompose = null) {
  return {
    postId,
    contains(value) {
      return value === containedCompose;
    }
  };
}

const context = vm.createContext({
  COMPOSE_SELECTORS: ['compose'],
  URLSearchParams,
  document: {
    activeElement: null,
    querySelectorAll: () => []
  },
  location: { href: 'https://x.com/example/status/123', pathname: '/example/status/123' },
  isVisible: () => true,
  findSubmitButton: () => ({}),
  getTweetUrl: value => `https://x.com/example/status/${value.postId}`,
  getXPostId: value => String(value).match(/(?:status\/|^)(\d+)$/)?.[1] || ''
});
vm.runInContext(source.slice(helperStart, helperEnd), context);

const focused = compose();
context.document.activeElement = focused;
context.targetArticle = article('123');
assert.equal(
  vm.runInContext('findExistingReplyComposer(targetArticle)', context),
  focused,
  'Focused inline reply composer should be reused for the open post'
);

context.otherArticle = article('456');
assert.equal(
  vm.runInContext('findExistingReplyComposer(otherArticle)', context),
  null,
  'Composer for the open post must not be reused for another post'
);

const modal = compose({ inDialog: true });
context.document.activeElement = modal;
assert.equal(
  vm.runInContext('findExistingReplyComposer(targetArticle)', context),
  null,
  'An unrelated modal composer must not be reused by URL alone'
);

context.location.pathname = '/compose/post';
context.location.search = '?in_reply_to=123';
context.document.querySelectorAll = () => [focused, modal];
assert.equal(vm.runInContext('findExistingReplyComposer(targetArticle)', context), modal);
assert.equal(vm.runInContext('findExistingReplyComposer(otherArticle)', context), null);
assert.equal(vm.runInContext("readXComposeText({ value: 'Typed reply', textContent: '' })", context), 'Typed reply');
assert.equal(vm.runInContext("readXComposeText({ value: '', textContent: 'Old reply' })", context), '');
context.location.pathname = '/example/status/123';
context.document.querySelectorAll = () => [];

const nested = compose();
context.document.activeElement = nested;
context.nestedArticle = article('456', nested);
assert.equal(
  vm.runInContext('findExistingReplyComposer(nestedArticle)', context),
  nested,
  'A composer inside the target article should be reused'
);

const replyFlow = source.slice(
  source.indexOf('async function runXAgentReply'),
  source.indexOf('function currentXRelationshipPending')
);
assert.match(replyFlow, /const preferredCompose = findExistingReplyComposer\(article\)/);
assert.match(replyFlow, /openReplyComposer\(target, preferredCompose\)/);

console.log('X composer reuse regression test: OK');
