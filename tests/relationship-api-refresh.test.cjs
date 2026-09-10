const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const stored = {
  xRelationshipApiConfig: {
    ownHandle: 'my_account',
    bearerToken: 'test-token',
    checkFollowBack: true,
    oauthAccessToken: 'legacy-user-token',
    oauthRefreshToken: 'legacy-refresh-token'
  },
  xRelationshipAuthors: [{
    id: 'author',
    handle: 'author',
    interactions: [{
      id: 'interaction-1',
      postId: '1111111111111111111',
      postUrl: 'https://x.com/author/status/1111111111111111111',
      postText: 'Original post',
      replyText: 'Our reply',
      status: 'sent',
      createdAt: '2026-08-14T10:00:00.000Z',
      sentAt: '2026-08-14T10:00:00.000Z'
    }, {
      id: 'legacy-error',
      postId: '4444444444444444444',
      postUrl: 'https://x.com/author/status/4444444444444444444',
      status: 'draft',
      checkError: 'Author-like check was skipped: X API 403: Authenticating with OAuth 2.0 Application-Only is forbidden for this endpoint. Supported authentication types are [OAuth 1.0a User Context, OAuth 2.0 User Context]. Original-post like check was skipped: X API 403: Authenticating with OAuth 2.0 Application-Only is forbidden for this endpoint. Supported authentication types are [OAuth 1.0a User Context, OAuth 2.0 User Context].'
    }]
  }],
  xRelationshipSession: {}
};

const listener = { addListener() {} };
const chrome = {
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(key => key in stored).map(key => [key, stored[key]]));
      },
      async set(values) {
        Object.assign(stored, values);
      }
    },
    sync: { async get() { return {}; }, async set() {} }
  },
  notifications: { onClicked: listener },
  runtime: { onInstalled: listener, onConnect: listener, onMessage: listener },
  contextMenus: { onClicked: listener },
  tabs: { onRemoved: listener },
  debugger: { onDetach: listener }
};

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 403 ? 'Forbidden' : 'OK',
    async json() { return payload; }
  };
}

async function fetchStub(input) {
  const url = new URL(String(input));
  const path = url.pathname;
  fetchStub.calls.push(`${path}?${url.searchParams.toString()}`);

  if (path.endsWith('/users/by')) {
    assert.equal(url.searchParams.get('usernames'), 'my_account');
    return jsonResponse(200, { data: [
      { id: '9000000000000000001', username: 'my_account', name: 'Me' }
    ] });
  }
  if (path.endsWith('/followers')) {
    return jsonResponse(200, { data: [] });
  }
  if (path.endsWith('/following')) {
    throw new Error('Refresh must not read the full following list. Page detection stores that state locally.');
  }
  if (path.endsWith('/9000000000000000001/tweets')) {
    return jsonResponse(200, { data: [{
      id: '2222222222222222222',
      text: 'Our reply',
      created_at: '2026-08-14T10:00:05.000Z',
      conversation_id: '1111111111111111111',
      referenced_tweets: [{ type: 'replied_to', id: '1111111111111111111' }],
      public_metrics: { like_count: 2, reply_count: 2 }
    }] });
  }
  if (path.endsWith('/tweets/search/recent')) {
    throw new Error('Refresh must not search for the identity of an author who replied.');
  }
  if (path.endsWith('/tweets')) {
    return jsonResponse(200, { data: [
      {
        id: '2222222222222222222',
        text: 'Our reply',
        conversation_id: '1111111111111111111',
        public_metrics: { like_count: 2, reply_count: 2 }
      }
    ] });
  }
  if (path.endsWith('/2222222222222222222/liking_users')) {
    throw new Error('Refresh must not request the identity of users who liked a reply.');
  }
  if (path.endsWith('/1111111111111111111/liking_users')) {
    throw new Error('Refresh must not request the identity of users who liked the source post.');
  }
  throw new Error(`Unexpected request: ${url}`);
}
fetchStub.calls = [];

const context = vm.createContext({
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  console,
  crypto: require('node:crypto').webcrypto,
  fetch: fetchStub,
  chrome,
  setTimeout,
  clearTimeout,
  Blob
});
vm.runInContext(fs.readFileSync('background.js', 'utf8'), context, { filename: 'background.js' });

(async () => {
  const result = await vm.runInContext('refreshXRelationshipApiData()', context);
  const interaction = result.authors[0].interactions[0];

  assert.equal(interaction.replyPostId, '2222222222222222222');
  assert.equal(interaction.replyUrl, 'https://x.com/my_account/status/2222222222222222222');
  assert.equal(interaction.resultSource, 'api');
  assert.equal(interaction.replyLiked, null);
  assert.equal('authorReplied' in interaction, false);
  assert.equal(interaction.likedOriginal, null);
  assert.equal(interaction.replyLikeCount, 2);
  assert.equal(interaction.replyReplyCount, 2);
  assert.equal(interaction.replyExternalCount, 2);
  assert.equal(result.summary.postsRead, 1);
  assert.equal(result.summary.usersRead, 1);
  assert.equal(result.summary.ownedReads, 1);
  assert.equal('oauthAccessToken' in stored.xRelationshipApiConfig, false);
  assert.equal('oauthRefreshToken' in stored.xRelationshipApiConfig, false);
  assert.equal(stored.xRelationshipApiConfig.ownUserId, '9000000000000000001');
  assert.doesNotMatch(result.summary.warnings.join(' '), /OAuth|like/i);
  assert.doesNotMatch(interaction.checkError, /Application-Only/);
  assert.equal(result.authors[0].interactions[1].checkError, '');
  assert.equal(stored.xRelationshipAuthors[0].interactions[0].replyUrl, interaction.replyUrl);
  context.testRelationshipAuthor = result.authors[0];
  const promptContext = vm.runInContext('buildXRelationshipPromptContext(testRelationshipAuthor)', context);
  assert.doesNotMatch(promptContext, /replyLiked|likedOriginal/);
  assert.doesNotMatch(promptContext, /authorReplied|authorReplyText/);
  assert.match(promptContext, /"replyExternalCount":2/);

  const dashboardSource = fs.readFileSync('relationship/relationship.js', 'utf8');
  const scoreFunction = dashboardSource.slice(
    dashboardSource.indexOf('function replyPerformance'),
    dashboardSource.indexOf('function authorStats')
  );
  const scoreContext = vm.createContext({ Math, Number });
  vm.runInContext(scoreFunction, scoreContext);
  scoreContext.oneLike = { resultSource: 'api', replyLikeCount: 1, replyExternalCount: 0 };
  scoreContext.twoLikesTwoReplies = { resultSource: 'api', replyLikeCount: 2, replyExternalCount: 2 };
  scoreContext.noSignals = { resultSource: 'api', replyLikeCount: 0, replyExternalCount: 0 };
  scoreContext.fullSignal = { resultSource: 'api', replyLikeCount: 100, replyExternalCount: 10 };
  assert.equal(vm.runInContext('replyPerformance(oneLike).score', scoreContext), 22);
  assert.equal(vm.runInContext('replyPerformance(twoLikesTwoReplies).score', scoreContext), 77);
  assert.equal(vm.runInContext('replyPerformance(noSignals).score', scoreContext), 0);
  assert.equal(vm.runInContext('replyPerformance(fullSignal).score', scoreContext), 100);

  const firstRequestCount = fetchStub.calls.length;
  const second = await vm.runInContext('refreshXRelationshipApiData()', context);
  const secondCalls = fetchStub.calls.slice(firstRequestCount);
  assert.equal(second.summary.requests, 0);
  assert.equal(second.summary.postsRead, 0);
  assert.equal(second.summary.usersRead, 0);
  assert.equal(second.summary.ownedReads, 0);
  assert.equal(second.summary.cacheHits, 1);
  assert.equal(second.summary.deferred, 1);
  assert.equal(secondCalls.filter(value => value.includes('/users/by?')).length, 0);
  assert.equal(secondCalls.filter(value => value.includes('/followers?')).length, 0);
  assert.equal(secondCalls.filter(value => value.includes('/tweets/search/recent?')).length, 0);
  assert.equal(secondCalls.length, 0);

  const automaticSession = await vm.runInContext(
    "handleXRelationshipCommand({ action: 'startSession', auto: true })",
    context
  );
  assert.equal(automaticSession.session.auto, true);
  assert.equal(automaticSession.session.index, 0);
  const guardedAdvance = await vm.runInContext(
    "handleXRelationshipCommand({ action: 'advanceSession', expectedHandle: 'another_author' })",
    context
  );
  assert.equal(guardedAdvance.session.index, 0);
  const validAdvance = await vm.runInContext(
    "handleXRelationshipCommand({ action: 'advanceSession', expectedHandle: 'author' })",
    context
  );
  assert.equal(validAdvance.session.active, false);

  context.handleImportText = '@New_User\ninvalid handle!\n@author\n@new_user\nhttps://x.com/Second_User';
  const importedHandles = await vm.runInContext(
    "handleXRelationshipCommand({ action: 'importHandles', text: handleImportText })",
    context
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(importedHandles.importSummary)),
    { added: 2, existing: 1, duplicates: 1, invalid: 1, limited: 0, maxAuthors: 100 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(importedHandles.authors.slice(0, 2).map(author => author.handle))),
    ['New_User', 'Second_User']
  );

  await vm.runInContext(
    "handleXRelationshipCommand({ action: 'patchAuthor', handle: 'New_User', patch: { followsBack: true } })",
    context
  );
  const followersExcluded = await vm.runInContext(
    "handleXRelationshipCommand({ action: 'startSession', handles: ['New_User'], auto: true, replyToFollowers: false })",
    context
  );
  assert.equal(followersExcluded.session.active, false);
  assert.equal(followersExcluded.session.replyToFollowers, false);
  const followersIncluded = await vm.runInContext(
    "handleXRelationshipCommand({ action: 'startSession', handles: ['New_User'], auto: true, replyToFollowers: true })",
    context
  );
  assert.equal(followersIncluded.session.active, true);
  assert.equal(followersIncluded.session.replyToFollowers, true);
  assert.deepEqual(Array.from(followersIncluded.session.queue), ['New_User']);

  const xContentSource = fs.readFileSync('x-content.js', 'utf8');
  const labelsStart = xContentSource.indexOf('const X_FOLLOWS_BACK_LABELS');
  const labelsEnd = xContentSource.indexOf('const LANG_LABELS');
  const labelHelperStart = xContentSource.indexOf('function normalizeXProfileLabel');
  const labelHelperEnd = xContentSource.indexOf('function detectXFollowsBack');
  assert.ok(labelsStart >= 0 && labelsEnd > labelsStart);
  assert.ok(labelHelperStart >= 0 && labelHelperEnd > labelHelperStart);
  const labelContext = vm.createContext({ Set, String });
  vm.runInContext(`
    ${xContentSource.slice(labelsStart, labelsEnd)}
    ${xContentSource.slice(labelHelperStart, labelHelperEnd)}
    this.isFollowBack = isXFollowsBackLabel;
  `, labelContext);
  assert.equal(labelContext.isFollowBack('Follows you'), true);
  assert.equal(labelContext.isFollowBack('Читает вас'), true);
  assert.equal(labelContext.isFollowBack('Obserwuje Cię'), true);
  assert.equal(labelContext.isFollowBack('Te sigue ·'), true);
  assert.equal(labelContext.isFollowBack('Following'), false);
  assert.match(xContentSource, /function likeXRelationshipArticle/);
  assert.match(xContentSource, /xRelationshipAutoLike/);
  assert.match(xContentSource, /xRelationshipReplyToFollowers/);
  const popupHtml = fs.readFileSync('popup\/popup.html', 'utf8');
  const relationshipHtml = fs.readFileSync('relationship\/relationship.html', 'utf8');
  assert.match(popupHtml, /id="xRelationshipPrompt"/);
  assert.match(popupHtml, /id="xRelationshipReplyToFollowers"/);
  assert.match(relationshipHtml, /id="importHandlesFile"/);
  assert.match(relationshipHtml, /id="replyToFollowers"/);

  console.log('Relationship cost-optimized refresh regression test: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
