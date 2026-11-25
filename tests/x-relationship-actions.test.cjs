const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('x-content.js', 'utf8');
const helperStart = source.indexOf('async function followCurrentXRelationshipAuthor');
const helperEnd = source.indexOf('function scheduleXRelationshipScan');
const stateStart = source.indexOf('function getXProfileFollowState');
const stateEnd = source.indexOf('function findXProfileFollowButton');
const likedStart = source.indexOf('function getXPostLiked');
const likedEnd = source.indexOf('function findPrimaryTweetTextBlock');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Relationship follow helper was not found');

function button(testid, { disabled = false, label = '', nextLabel = '' } = {}) {
  return {
    dataset: { testid },
    disabled,
    clicks: 0,
    getAttribute(name) {
      if (name === 'aria-label') return label;
      return name === 'aria-disabled' && disabled ? 'true' : null;
    },
    click() {
      this.clicks += 1;
      this.dataset.testid = 'profile-unfollow';
      if (nextLabel) {
        this.dataset.testid = '';
        label = nextLabel;
      }
    }
  };
}

const context = vm.createContext({
  currentButton: null,
  currentXProfileHandle: () => 'target',
  normalizeXProfileLabel: value => String(value || '').trim().toLowerCase(),
  isEnabledXControl: control => !control.disabled,
  findXProfileFollowButton() {
    return context.currentButton;
  },
  async sleep() {}
});
vm.runInContext(
  source.slice(stateStart, stateEnd) + source.slice(helperStart, helperEnd) + source.slice(likedStart, likedEnd),
  context
);
const follow = () => vm.runInContext("followCurrentXRelationshipAuthor('target')", context);

(async () => {
  context.currentButton = button('profile-follow');
  assert.equal(await follow(), 'following');
  assert.equal(context.currentButton.clicks, 1);

  context.currentButton = button('profile-unfollow');
  assert.equal(await follow(), 'following');
  assert.equal(context.currentButton.clicks, 0);

  context.currentButton = button('profile-follow', { disabled: true });
  assert.equal(await follow(), '');
  assert.equal(context.currentButton.clicks, 0);

  context.currentButton = button('', { label: 'Начать читать @TARGET', nextLabel: 'Перестать читать @target' });
  assert.equal(await follow(), 'following');
  assert.equal(context.currentButton.clicks, 1);
  assert.equal(await follow(), 'following');
  assert.equal(context.currentButton.clicks, 1);

  context.currentButton = button('', { label: 'Начать читать @suggested' });
  assert.equal(await follow(), '');
  assert.equal(context.currentButton.clicks, 0);

  context.currentButton = button('', { label: 'Cancel follow request to @target' });
  assert.equal(await follow(), 'requested');
  assert.equal(context.currentButton.clicks, 0);

  const getLiked = (pressed, testid) => {
    context.likeButton = { getAttribute: () => pressed, dataset: { testid } };
    return vm.runInContext('getXPostLiked(likeButton)', context);
  };
  assert.equal(getLiked('true'), true);
  assert.equal(getLiked('false'), false);
  assert.equal(getLiked(null, 'unlike'), true);
  assert.equal(getLiked(null, 'like'), false);
  assert.equal(getLiked(null), null);

  assert.match(source, /X_RELATIONSHIP_PROFILE_SCAN_MODE/);
  assert.match(source, /type === 'xRelationshipInspectProfile'/);

  const dashboard = fs.readFileSync('relationship/relationship.js', 'utf8');
  assert.match(dashboard, /\?dth_crm_scan=1/);
  assert.match(dashboard, /state: 'minimized'/);
  assert.match(dashboard, /End the active Relationship session/);

  console.log('X relationship actions regression test: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
