const AUTHORS_KEY = 'xRelationshipAuthors';
const SESSION_KEY = 'xRelationshipSession';
const API_CONFIG_KEY = 'xRelationshipApiConfig';

const state = {
  authors: [],
  session: null,
  apiConfig: { ownHandle: '', hasToken: false, checkFollowBack: false },
  replyToFollowers: false,
  autoFollowAuthors: false,
  filter: 'active',
  search: '',
  refreshingApi: false,
  profileScan: {
    running: false,
    cancelled: false,
    current: 0,
    total: 0,
    checked: 0,
    followsBack: 0,
    errors: 0,
    message: ''
  }
};

const requestedAuthor = new URLSearchParams(location.search).get('author') || '';
let requestedAuthorApplied = false;
let profileScanWindowId = null;

function callRelationship(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'xRelationship', action, ...payload }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Relationship CRM request failed.'));
        return;
      }
      resolve(response);
    });
  });
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function currentSessionAuthor() {
  const session = state.session;
  if (!session?.active) return null;
  const handle = session.queue[session.index];
  return state.authors.find(author => author.id === String(handle || '').toLowerCase()) || null;
}

function percent(part, total) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '—';
}

function replyPerformance(interaction) {
  const hasExternalReplyCount = interaction.replyExternalCount !== null
    && interaction.replyExternalCount !== undefined;
  const verified = interaction.resultSource === 'api' && hasExternalReplyCount;
  const totalLikes = Math.max(0, Number(interaction.replyLikeCount) || 0);
  const externalReplies = hasExternalReplyCount
    ? Math.max(0, Number(interaction.replyExternalCount) || 0)
    : 0;
  const likePoints = totalLikes > 0
    ? Math.min(40, 22 + ((totalLikes - 1) * 5))
    : 0;
  const replyPoints = externalReplies > 0
    ? Math.min(60, 40 + ((externalReplies - 1) * 10))
    : 0;
  return {
    verified,
    score: Math.min(100, likePoints + replyPoints),
    totalLikes,
    externalReplies,
    parts: [
      { label: `${totalLikes} total likes`, points: likePoints, active: totalLikes > 0 },
      { label: `${externalReplies} replies from others`, points: replyPoints, active: externalReplies > 0 }
    ]
  };
}

function authorStats(author) {
  const interactions = author.interactions || [];
  const sentItems = interactions.filter(item => item.status === 'sent');
  const verifiedItems = sentItems.filter(item => item.resultSource === 'api');
  return {
    sent: sentItems.length,
    checked: verifiedItems.length,
    liked: verifiedItems.filter(item => (Number(item.replyLikeCount) || 0) > 0).length,
    publiclyReplied: verifiedItems.filter(item => (Number(item.replyExternalCount) || 0) > 0).length,
    averageReplyScore: verifiedItems.length
      ? Math.round(verifiedItems.reduce((sum, item) => sum + replyPerformance(item).score, 0) / verifiedItems.length)
      : null
  };
}

function relationshipProgress(author) {
  const stats = authorStats(author);
  const contactPoints = Math.min(20, stats.sent * 5);
  const audienceLikePoints = stats.checked ? Math.round((stats.liked / stats.checked) * 25) : 0;
  const publicReplyPoints = stats.checked ? Math.round((stats.publiclyReplied / stats.checked) * 35) : 0;
  const followingPoints = author.following === true ? 10 : 0;
  const score = author.followsBack
    ? 100
    : Math.min(90, contactPoints + audienceLikePoints + publicReplyPoints + followingPoints);
  return {
    score,
    verifiedReplies: stats.checked,
    parts: [
      { label: `${stats.sent} contacts`, points: contactPoints, active: stats.sent > 0 },
      { label: 'Replies with likes', points: audienceLikePoints, active: stats.liked > 0 },
      { label: 'Public replies', points: publicReplyPoints, active: stats.publiclyReplied > 0 },
      { label: 'You follow', points: followingPoints, active: author.following === true }
    ]
  };
}

function scoreTone(score) {
  if (score >= 75) return 'strong';
  if (score >= 40) return 'promising';
  return 'early';
}

function renderStats() {
  const root = document.getElementById('stats');
  const followedBack = state.authors.filter(author => author.followsBack).length;
  const sent = state.authors.reduce((sum, author) => sum + authorStats(author).sent, 0);
  const checked = state.authors.reduce((sum, author) => sum + authorStats(author).checked, 0);
  const replyLikes = state.authors.reduce((sum, author) => sum + authorStats(author).liked, 0);
  const publicReplies = state.authors.reduce((sum, author) => sum + authorStats(author).publiclyReplied, 0);
  const contacted = state.authors.filter(author => authorStats(author).sent > 0).length;
  const verifiedReplyScores = state.authors.flatMap(author => {
    return (author.interactions || [])
      .filter(item => item.status === 'sent' && item.resultSource === 'api')
      .map(item => replyPerformance(item).score);
  });
  const contactedAuthors = state.authors.filter(author => authorStats(author).sent > 0);
  const averageReplyScore = verifiedReplyScores.length
    ? Math.round(verifiedReplyScores.reduce((sum, score) => sum + score, 0) / verifiedReplyScores.length)
    : null;
  const averageRelationshipScore = contactedAuthors.length
    ? Math.round(contactedAuthors.reduce((sum, author) => sum + relationshipProgress(author).score, 0) / contactedAuthors.length)
    : null;
  root.replaceChildren();
  [
    [state.authors.length, 'Tracked authors'],
    [sent, 'Sent replies'],
    [percent(publicReplies, checked), 'Replies with public responses'],
    [percent(replyLikes, checked), 'Replies with likes'],
    [averageReplyScore === null ? '—' : `${averageReplyScore}/100`, 'Average reply score'],
    [averageRelationshipScore === null ? '—' : `${averageRelationshipScore}/100`, 'Relationship progress'],
    [percent(followedBack, contacted), 'Follow-back success']
  ].forEach(([value, label]) => {
    const card = el('div', 'stat');
    card.append(el('strong', '', String(value)), el('span', '', label));
    root.appendChild(card);
  });
  root.dataset.sent = String(sent);
}

function renderSession() {
  const banner = document.getElementById('sessionBanner');
  const resume = document.getElementById('resumeSession');
  const author = currentSessionAuthor();
  const active = !!author;
  banner.hidden = !active;
  resume.hidden = !active;
  document.getElementById('startSession').disabled = !state.authors.some(item => {
    return item.status !== 'archived' && (state.replyToFollowers || !item.followsBack);
  });
  if (!active) return;
  document.getElementById('sessionTitle').textContent = `Session active · ${state.session.index + 1}/${state.session.queue.length}`;
  document.getElementById('sessionText').textContent = state.session.auto
    ? `Automatic session: @${author.handle}. AI Helper checks follow-back, replies to one unprocessed post, then continues to the next author.`
    : `Current author: @${author.handle}. Open X, prepare the draft, use the native Like/Follow controls, then complete the author.`;
  resume.textContent = `Resume @${author.handle}`;
}

function renderProfileScan() {
  const scan = state.profileScan;
  const banner = document.getElementById('profileScanBanner');
  const start = document.getElementById('checkFollowBackProfiles');
  const stop = document.getElementById('stopProfileScan');
  banner.hidden = !scan.running && !scan.message;
  banner.classList.toggle('is-complete', !scan.running && !!scan.message);
  stop.hidden = !scan.running;
  start.disabled = scan.running
    || state.refreshingApi
    || state.session?.active === true
    || !state.authors.some(author => author.status !== 'archived');
  document.getElementById('refreshResults').disabled = scan.running || state.refreshingApi;
  document.getElementById('startSession').disabled = scan.running || !state.authors.some(item => {
    return item.status !== 'archived' && (state.replyToFollowers || !item.followsBack);
  });
  start.textContent = scan.running ? `Checking ${scan.current}/${scan.total}` : 'Check follow-backs';
  document.getElementById('profileScanText').textContent = scan.message || (
    `Checking ${scan.current}/${scan.total} · verified ${scan.checked} · follows you ${scan.followsBack} · errors ${scan.errors}`
  );
}

async function refresh() {
  const [response, apiResponse, settings] = await Promise.all([
    callRelationship('list'),
    callRelationship('getApiConfig'),
    chrome.storage.sync.get({
      xRelationshipReplyToFollowers: false,
      xRelationshipAutoFollow: false
    })
  ]);
  state.authors = response.authors || [];
  state.session = response.session || null;
  state.apiConfig = apiResponse.config || state.apiConfig;
  state.replyToFollowers = settings.xRelationshipReplyToFollowers === true;
  state.autoFollowAuthors = settings.xRelationshipAutoFollow === true;
  document.getElementById('replyToFollowers').checked = state.replyToFollowers;
  document.getElementById('autoFollowAuthors').checked = state.autoFollowAuthors;
  if (requestedAuthor && !requestedAuthorApplied) {
    requestedAuthorApplied = true;
    state.filter = 'all';
    state.search = requestedAuthor.replace(/^@/, '');
    document.getElementById('filter').value = 'all';
    document.getElementById('search').value = state.search;
  }
  renderApiConfig();
  render();
}

function renderApiConfig() {
  const config = state.apiConfig || {};
  document.getElementById('ownHandle').value = config.ownHandle ? `@${config.ownHandle}` : '';
  const token = document.getElementById('bearerToken');
  token.value = '';
  token.placeholder = config.hasToken ? 'Saved locally — leave blank to keep it' : 'Paste token';
  document.getElementById('checkFollowBack').checked = config.checkFollowBack === true;
  const badge = document.getElementById('apiBadge');
  badge.className = config.hasToken && config.ownHandle ? 'badge success' : 'badge muted';
  badge.textContent = config.hasToken && config.ownHandle ? 'Configured' : 'Optional';
  const refreshButton = document.getElementById('refreshResults');
  refreshButton.disabled = state.refreshingApi;
  refreshButton.textContent = state.refreshingApi ? 'Refreshing…' : 'Refresh data';
}

function profileButton(author, text = 'Open profile') {
  const button = el('button', '', text);
  button.type = 'button';
  button.addEventListener('click', () => chrome.tabs.create({ url: author.profileUrl, active: true }));
  return button;
}

async function patchAuthor(author, patch) {
  await callRelationship('patchAuthor', { handle: author.handle, patch });
  await refresh();
}

async function patchInteraction(author, interaction, patch) {
  await callRelationship('patchInteraction', {
    handle: author.handle,
    interactionId: interaction.id,
    patch
  });
  await refresh();
}

function renderScoreBlock({ className = '', title, score, verified = true, pendingLabel = 'Awaiting API refresh', parts = [], hint = '' }) {
  const tone = scoreTone(score);
  const block = el('section', `score-block ${className} is-${tone}${verified ? '' : ' is-pending'}`.trim());
  const head = el('div', 'score-head');
  head.append(
    el('strong', '', title),
    el('span', 'score-value', verified ? `${score}/100` : pendingLabel)
  );
  const track = el('div', 'score-track');
  const fill = el('span', 'score-fill');
  fill.style.width = `${verified ? score : 0}%`;
  track.appendChild(fill);
  const chips = el('div', 'score-parts');
  parts.forEach(part => {
    const chip = el('span', part.active ? 'is-active' : '', `${part.label} +${part.points}`);
    chips.appendChild(chip);
  });
  block.append(head, track, chips);
  if (hint) block.appendChild(el('small', 'score-hint', hint));
  return block;
}

function renderInteraction(author, interaction) {
  const item = el('div', 'interaction');
  const head = el('div', 'interaction-head');
  const link = el('a', '', formatDate(interaction.sentAt || interaction.createdAt));
  link.href = interaction.postUrl || author.profileUrl;
  link.target = '_blank';
  link.rel = 'noreferrer';
  const status = el('span', `badge ${interaction.status === 'sent' ? 'success' : 'muted'}`, interaction.status);
  head.append(link, status);
  item.append(head, el('p', '', interaction.postText || 'Post text unavailable'));
  if (interaction.replyText) item.appendChild(el('p', 'reply', `Reply: ${interaction.replyText}`));

  const meta = el('div', 'interaction-meta');
  meta.appendChild(el('span', '', `Created: ${formatDate(interaction.createdAt)}`));
  if (interaction.sentAt) meta.appendChild(el('span', '', `Sent: ${formatDate(interaction.sentAt)}`));
  if (interaction.resultCheckedAt) meta.appendChild(el('span', '', `Checked: ${formatDate(interaction.resultCheckedAt)}`));
  if (interaction.resultSource) {
    const sourceLabel = interaction.resultSource === 'api'
      ? 'Verified by X API'
      : interaction.resultSource === 'page' ? 'Detected on page' : 'Set manually';
    meta.appendChild(el('span', `result-source is-${interaction.resultSource}`, sourceLabel));
  }
  meta.appendChild(el('span', '', `All likes: ${Number(interaction.replyLikeCount) || 0}`));
  meta.appendChild(el('span', '', `All replies: ${Number(interaction.replyReplyCount) || 0}`));
  meta.appendChild(el('span', '', interaction.replyExternalCount === null || interaction.replyExternalCount === undefined
    ? 'Replies from other users: awaiting refresh'
    : `Replies from other users: ${Number(interaction.replyExternalCount) || 0}`));
  const replyUrl = interaction.replyUrl || (interaction.replyPostId && state.apiConfig.ownHandle
    ? `https://x.com/${state.apiConfig.ownHandle}/status/${interaction.replyPostId}`
    : '');
  if (replyUrl) {
    const replyLink = el('a', '', 'Open our reply');
    replyLink.href = replyUrl;
    replyLink.target = '_blank';
    replyLink.rel = 'noreferrer';
    meta.appendChild(replyLink);
  }
  item.appendChild(meta);

  const performance = replyPerformance(interaction);
  const pendingLabel = interaction.resultCheckedAt && interaction.checkError
    ? 'API check failed'
    : 'Awaiting API refresh';
  item.appendChild(renderScoreBlock({
    className: 'reply-score',
    title: 'Reply signal score',
    score: performance.score,
    verified: performance.verified,
    pendingLabel,
    parts: performance.parts,
    hint: "First like +22, each next +5 (max +40). First direct reply +40, each next +10 (max +60). A continuation you post under somebody else's reply is not part of this count."
  }));

  if (interaction.checkError) item.appendChild(el('p', 'interaction-error', interaction.checkError));

  const context = el('div', 'interaction-context');
  const contextInput = el('textarea');
  contextInput.value = interaction.note || '';
  contextInput.placeholder = 'Optional local notes about this result';
  const saveContext = el('button', '', 'Save context');
  saveContext.type = 'button';
  saveContext.addEventListener('click', () => patchInteraction(author, interaction, {
    note: contextInput.value
  }));
  context.append(contextInput, saveContext);
  item.appendChild(context);
  return item;
}

function renderAuthor(author) {
  const stats = authorStats(author);
  const card = el('article', author.followsBack ? 'author-card is-followed-back' : 'author-card');
  const main = el('div', 'author-main');
  const identity = el('div', 'author-identity');
  const name = el('div', 'author-name');
  name.appendChild(el('strong', '', author.displayName || `@${author.handle}`));
  const badgeClass = author.followsBack ? 'badge success' : author.status === 'archived' ? 'badge muted' : 'badge';
  name.appendChild(el('span', badgeClass, author.followsBack ? 'Follows you' : author.status));
  identity.append(name, el('span', 'author-handle', `@${author.handle}`));

  const metric = (label, value) => {
    const box = el('div', 'metric');
    box.append(el('span', '', label), el('strong', '', value));
    return box;
  };
  const actions = el('div', 'author-actions');
  actions.appendChild(profileButton(author, 'Check in X'));
  const archive = el('button', '', author.status === 'archived' ? 'Restore' : 'Archive');
  archive.type = 'button';
  archive.addEventListener('click', () => patchAuthor(author, { status: author.status === 'archived' ? 'tracking' : 'archived' }));
  const remove = el('button', 'danger subtle', 'Delete');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!confirm(`Delete @${author.handle} and the complete local history?`)) return;
    await callRelationship('removeAuthor', { handle: author.handle });
    await refresh();
  });
  actions.append(archive, remove);

  main.append(
    identity,
    metric('Following', author.following === true ? 'Yes' : author.following === false ? 'No' : 'Unknown'),
    metric('Sent', String(stats.sent)),
    metric('Average reply', stats.averageReplyScore === null ? '—' : `${stats.averageReplyScore}/100`),
    metric('Public reply rate', percent(stats.publiclyReplied, stats.checked)),
    actions
  );

  const progress = relationshipProgress(author);
  const relationshipScore = renderScoreBlock({
    className: 'relationship-score',
    title: author.followsBack ? 'Relationship progress · Follow-back achieved' : 'Relationship progress',
    score: progress.score,
    verified: true,
    parts: progress.parts,
    hint: progress.verifiedReplies
      ? `Based on ${progress.verifiedReplies} API-verified replies. This is a transparent progress indicator, not a predicted follow-back probability.`
      : 'Engagement contribution is waiting for X API data. This is a progress indicator, not a predicted follow-back probability.'
  });

  const details = el('details', 'author-details');
  const checkedAt = author.lastApiCheckedAt || author.lastCheckedAt;
  const firstContactAt = author.interactions?.[0]?.createdAt;
  const summary = el('summary', '', `${author.interactions?.length || 0} interactions · first contact ${formatDate(firstContactAt)} · last contact ${formatDate(author.lastContactAt)} · checked ${formatDate(checkedAt)}`);
  const grid = el('div', 'detail-grid');
  const notes = el('div', 'notes');
  const notesInput = el('textarea');
  notesInput.value = author.notes || '';
  notesInput.placeholder = 'Local notes about this author';
  const saveNotes = el('button', '', 'Save notes');
  saveNotes.type = 'button';
  saveNotes.addEventListener('click', async () => {
    await patchAuthor(author, { notes: notesInput.value });
  });
  notes.append(el('strong', '', 'Notes'), notesInput, saveNotes);
  const interactions = el('div', 'interactions');
  interactions.appendChild(el('strong', '', 'Interaction history'));
  const history = [...(author.interactions || [])].reverse();
  if (!history.length) interactions.appendChild(el('p', '', 'No prepared replies yet.'));
  history.forEach(interaction => interactions.appendChild(renderInteraction(author, interaction)));
  grid.append(notes, interactions);
  details.append(summary, grid);
  card.append(main, relationshipScore, details);
  return card;
}

function filteredAuthors() {
  const query = state.search.toLowerCase();
  return state.authors.filter(author => {
    if (state.filter === 'active' && author.status === 'archived') return false;
    if (state.filter === 'followed_back' && !author.followsBack) return false;
    if (state.filter === 'tracking' && (author.status !== 'tracking' || author.followsBack)) return false;
    if (state.filter === 'archived' && author.status !== 'archived') return false;
    return !query || [author.handle, author.displayName, author.notes].some(value => String(value || '').toLowerCase().includes(query));
  });
}

function render() {
  renderStats();
  renderSession();
  renderProfileScan();
  const authors = filteredAuthors();
  const root = document.getElementById('authorList');
  root.replaceChildren(...authors.map(renderAuthor));
  document.getElementById('emptyState').hidden = authors.length > 0;
}

async function startSession() {
  if (state.profileScan.running) {
    alert('Stop the background follow-back check before starting a Relationship session.');
    return;
  }
  await chrome.storage.sync.set({ xAgentEnabled: true });
  const response = await callRelationship('startSession', {
    auto: true,
    replyToFollowers: state.replyToFollowers
  });
  state.authors = response.authors || [];
  state.session = response.session;
  render();
  const author = currentSessionAuthor();
  if (!author) {
    alert('There are no active authors to process.');
    return;
  }
  await chrome.tabs.create({ url: author.profileUrl, active: true });
}

async function endSession() {
  await callRelationship('endSession');
  await refresh();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function profileHandleFromUrl(value) {
  try {
    return new URL(value).pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
  } catch {
    return '';
  }
}

function profileScanUrl(author) {
  return `https://x.com/${encodeURIComponent(author.handle)}?dth_crm_scan=1`;
}

async function createProfileScanWindow(url) {
  try {
    return await chrome.windows.create({
      url,
      type: 'popup',
      state: 'minimized',
      focused: false
    });
  } catch {
    const scanWindow = await chrome.windows.create({
      url,
      type: 'popup',
      width: 420,
      height: 640,
      focused: false
    });
    try { await chrome.windows.update(scanWindow.id, { state: 'minimized' }); } catch { }
    return scanWindow;
  }
}

async function waitForProfileTab(tabId, handle, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const expected = String(handle || '').toLowerCase();
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && profileHandleFromUrl(tab.url) === expected) return;
    await wait(250);
  }
  throw new Error(`Timed out loading @${handle}.`);
}

async function inspectProfileTab(tabId, handle) {
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'xRelationshipInspectProfile',
        handle
      });
      if (response?.ok && response.ready) return response;
      lastError = response?.error || 'Profile was not ready.';
    } catch (error) {
      lastError = error.message || String(error);
    }
    await wait(500);
  }
  throw new Error(lastError || `Could not inspect @${handle}.`);
}

async function stopProfileScan() {
  state.profileScan.cancelled = true;
  state.profileScan.message = 'Stopping background check...';
  renderProfileScan();
  if (profileScanWindowId !== null) {
    try { await chrome.windows.remove(profileScanWindowId); } catch { }
  }
}

async function checkFollowBackProfiles() {
  if (state.profileScan.running) return;
  if (state.session?.active) {
    alert('End the active Relationship session before starting the background follow-back check.');
    return;
  }
  const authors = state.authors.filter(author => author.status !== 'archived');
  if (!authors.length) {
    alert('Add at least one active author to Relationship CRM first.');
    return;
  }
  state.profileScan = {
    running: true,
    cancelled: false,
    current: 0,
    total: authors.length,
    checked: 0,
    followsBack: 0,
    errors: 0,
    message: ''
  };
  renderProfileScan();
  let tabId = null;
  try {
    const scanWindow = await createProfileScanWindow(profileScanUrl(authors[0]));
    profileScanWindowId = scanWindow.id;
    tabId = scanWindow.tabs?.[0]?.id || null;
    if (!tabId) {
      const tabs = await chrome.tabs.query({ windowId: scanWindow.id });
      tabId = tabs[0]?.id || null;
    }
    if (!tabId) throw new Error('Could not create the background X tab.');

    for (let index = 0; index < authors.length; index++) {
      if (state.profileScan.cancelled) break;
      const author = authors[index];
      state.profileScan.current = index + 1;
      state.profileScan.message = '';
      renderProfileScan();
      try {
        if (index > 0) {
          await chrome.tabs.update(tabId, { url: profileScanUrl(author), active: true });
        }
        await waitForProfileTab(tabId, author.handle);
        const result = await inspectProfileTab(tabId, author.handle);
        const response = await callRelationship('patchAuthor', {
          handle: author.handle,
          patch: {
            displayName: result.displayName || author.displayName,
            following: result.following,
            followsBack: result.followsBack,
            lastCheckedAt: new Date().toISOString()
          }
        });
        state.authors = response.authors || state.authors;
        state.session = response.session || state.session;
        state.profileScan.checked += 1;
        if (result.followsBack) state.profileScan.followsBack += 1;
      } catch (error) {
        if (!state.profileScan.cancelled) {
          state.profileScan.errors += 1;
          console.warn(`[DTH CRM] Could not inspect @${author.handle}:`, error);
          if (/no tab with id|no window with id|invalid tab id/i.test(error.message || '')) {
            state.profileScan.cancelled = true;
          }
        }
      }
      renderProfileScan();
      if (!state.profileScan.cancelled && index + 1 < authors.length) await wait(1200);
    }
  } finally {
    if (profileScanWindowId !== null) {
      try { await chrome.windows.remove(profileScanWindowId); } catch { }
    }
    profileScanWindowId = null;
    const cancelled = state.profileScan.cancelled;
    state.profileScan.running = false;
    state.profileScan.message = cancelled
      ? `Check stopped · verified ${state.profileScan.checked}/${state.profileScan.total} · errors ${state.profileScan.errors}`
      : `Check complete · verified ${state.profileScan.checked}/${state.profileScan.total} · follows you ${state.profileScan.followsBack} · errors ${state.profileScan.errors}`;
    await refresh();
  }
}

async function exportData() {
  const response = await callRelationship('list');
  const blob = new Blob([JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    authors: response.authors,
    session: response.session
  }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ai-helper-relationship-crm-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setApiStatus(message, isError = false) {
  const status = document.getElementById('apiStatus');
  status.classList.toggle('is-error', isError);
  status.textContent = message;
}

async function saveApiSettings(clearToken = false) {
  const tokenInput = document.getElementById('bearerToken');
  const response = await callRelationship('saveApiConfig', {
    clearToken,
    config: {
      ownHandle: document.getElementById('ownHandle').value,
      bearerToken: clearToken ? '' : tokenInput.value,
      checkFollowBack: document.getElementById('checkFollowBack').checked
    }
  });
  state.apiConfig = response.config || state.apiConfig;
  renderApiConfig();
  setApiStatus(clearToken ? 'Saved Bearer Token removed.' : 'API settings saved locally.');
}

async function refreshApiData() {
  if (state.refreshingApi) return;
  if (!state.apiConfig?.hasToken || !state.apiConfig?.ownHandle) {
    document.querySelector('.api-panel').open = true;
    throw new Error('Save your X handle and Bearer Token before refreshing public results.');
  }
  state.refreshingApi = true;
  renderApiConfig();
  setApiStatus('Checking recent replies and engagement…');
  try {
    const response = await callRelationship('refreshApi');
    state.authors = response.authors || state.authors;
    state.session = response.session || state.session;
    const summary = response.summary || {};
    const warning = summary.warnings?.length ? ` ${summary.warnings.join(' ')}` : '';
    const reads = `${summary.postsRead || 0} posts, ${summary.usersRead || 0} users, ${summary.ownedReads || 0} owned resources`;
    const cache = summary.cacheHits ? ` ${summary.cacheHits} cached operation(s).` : '';
    const schedule = summary.deferred ? ` ${summary.deferred} not due yet.` : '';
    const remaining = summary.dueRemaining ? ` ${summary.dueRemaining} due item(s) remain for the next refresh.` : '';
    setApiStatus(`Checked ${summary.checked || 0} replies with ${summary.requests || 0} X API requests (${reads}).${cache}${schedule}${remaining} ${summary.errors || 0} items need attention.${warning}`, (summary.errors || 0) > 0);
    render();
  } finally {
    state.refreshingApi = false;
    renderApiConfig();
  }
}

document.getElementById('addAuthorForm').addEventListener('submit', async event => {
  event.preventDefault();
  const status = document.getElementById('formStatus');
  status.classList.remove('is-error');
  status.textContent = 'Saving…';
  try {
    await callRelationship('upsertAuthor', {
      author: {
        handle: document.getElementById('authorInput').value,
        notes: document.getElementById('authorNotes').value
      }
    });
    status.textContent = 'Author added locally.';
    event.target.reset();
    await refresh();
  } catch (error) {
    status.classList.add('is-error');
    status.textContent = error.message;
  }
});

document.getElementById('search').addEventListener('input', event => {
  state.search = event.target.value.trim();
  render();
});
document.getElementById('filter').addEventListener('change', event => {
  state.filter = event.target.value;
  render();
});
document.getElementById('startSession').addEventListener('click', () => startSession().catch(error => alert(error.message)));
document.getElementById('checkFollowBackProfiles').addEventListener('click', () => {
  checkFollowBackProfiles().catch(error => {
    state.profileScan.running = false;
    state.profileScan.message = `Background check failed: ${error.message}`;
    renderProfileScan();
  });
});
document.getElementById('stopProfileScan').addEventListener('click', () => {
  stopProfileScan().catch(() => {});
});
document.getElementById('refreshResults').addEventListener('click', () => {
  refreshApiData().catch(error => setApiStatus(error.message, true));
});
document.getElementById('apiForm').addEventListener('submit', event => {
  event.preventDefault();
  saveApiSettings(false).catch(error => setApiStatus(error.message, true));
});
document.getElementById('clearApiToken').addEventListener('click', () => {
  if (!confirm('Remove the locally saved X API Bearer Token?')) return;
  saveApiSettings(true).catch(error => setApiStatus(error.message, true));
});
document.getElementById('resumeSession').addEventListener('click', () => {
  const author = currentSessionAuthor();
  if (author) chrome.tabs.create({ url: author.profileUrl, active: true });
});
document.getElementById('endSession').addEventListener('click', () => endSession().catch(error => alert(error.message)));
document.getElementById('exportData').addEventListener('click', () => exportData().catch(error => alert(error.message)));
document.getElementById('importData').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await callRelationship('import', { data });
    await refresh();
  } catch (error) {
    alert(`Import failed: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});
document.getElementById('importHandles').addEventListener('click', () => {
  document.getElementById('importHandlesFile').click();
});
document.getElementById('importHandlesFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const response = await callRelationship('importHandles', { text: await file.text() });
    state.authors = response.authors || state.authors;
    state.session = response.session || state.session;
    render();
    const summary = response.importSummary || {};
    const parts = [
      `${summary.added || 0} added`,
      `${summary.existing || 0} already in CRM`,
      `${summary.duplicates || 0} duplicate lines`,
      `${summary.invalid || 0} invalid lines`
    ];
    if (summary.limited) {
      parts.push(`${summary.limited} skipped because the CRM limit is ${summary.maxAuthors || 250}`);
    }
    alert(`TXT import complete: ${parts.join(', ')}.`);
  } catch (error) {
    alert(`TXT import failed: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});
document.getElementById('replyToFollowers').addEventListener('change', async event => {
  state.replyToFollowers = event.target.checked;
  await chrome.storage.sync.set({
    xRelationshipReplyToFollowers: state.replyToFollowers
  });
  render();
});
document.getElementById('autoFollowAuthors').addEventListener('change', async event => {
  state.autoFollowAuthors = event.target.checked;
  await chrome.storage.sync.set({
    xRelationshipAutoFollow: state.autoFollowAuthors
  });
});
document.getElementById('resetData').addEventListener('click', async () => {
  if (!confirm('Delete every tracked author and all relationship history from this browser?')) return;
  await callRelationship('reset');
  await refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[AUTHORS_KEY] || changes[SESSION_KEY] || changes[API_CONFIG_KEY])) {
    if (!state.profileScan.running || changes[SESSION_KEY] || changes[API_CONFIG_KEY]) {
      refresh().catch(() => {});
    }
  }
  if (area === 'sync' && changes.xRelationshipReplyToFollowers) {
    state.replyToFollowers = changes.xRelationshipReplyToFollowers.newValue === true;
    document.getElementById('replyToFollowers').checked = state.replyToFollowers;
    render();
  }
  if (area === 'sync' && changes.xRelationshipAutoFollow) {
    state.autoFollowAuthors = changes.xRelationshipAutoFollow.newValue === true;
    document.getElementById('autoFollowAuthors').checked = state.autoFollowAuthors;
  }
});

window.addEventListener('beforeunload', () => {
  if (profileScanWindowId !== null) chrome.windows.remove(profileScanWindowId).catch(() => {});
});

refresh().catch(error => {
  document.getElementById('emptyState').hidden = false;
  document.getElementById('emptyState').textContent = `Could not load Relationship CRM: ${error.message}`;
});
