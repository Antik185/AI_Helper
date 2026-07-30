const REPORT_KEY = 'xAgentLatestReport';
const FEEDBACK_KEY = 'xAgentFeedback';
let feedbackState = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}

function formatDuration(start, end) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function addStat(root, value, label) {
  const card = el('div', 'stat');
  card.append(el('span', 'stat-value', String(value)), el('span', 'stat-label', label));
  root.appendChild(card);
}

function feedbackId(item) {
  return `${item.url || ''}\n${item.reply || ''}`;
}

function normalizeFeedbackEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.reply) return null;
  let rating;
  if (entry.schemaVersion === 2) {
    rating = Math.max(1, Math.min(5, Math.round(Number(entry.rating) || 1)));
  } else {
    rating = entry.rating === -1 ? 1 : entry.rating === 1 ? 5 : Math.max(1, Math.min(5, Math.round(Number(entry.rating) || 1)));
  }
  return {
    ...entry,
    schemaVersion: 2,
    rating,
    userNote: String(entry.userNote || '')
  };
}

function currentFeedback(item) {
  return feedbackState.find(entry => entry.id === feedbackId(item)) || null;
}

function updateLearningSummary() {
  const count = feedbackState.length;
  const average = count
    ? (feedbackState.reduce((sum, item) => sum + item.rating, 0) / count).toFixed(1)
    : '—';
  document.getElementById('learningSummary').textContent =
    `Agent memory: ${count} saved ratings · average ${average}/5. Only explicitly saved feedback is used.`;
}

function updateFeedbackDraft(root, rating, savedFeedback) {
  root.querySelectorAll('.rating-button').forEach(button => {
    button.classList.toggle('is-active', Number(button.dataset.rating) === rating);
  });
  const ratingLabel = root.querySelector('.feedback-rating-value');
  if (ratingLabel) ratingLabel.textContent = rating ? `${rating}/5` : 'Not rated';
  const status = root.querySelector('.feedback-status');
  if (status) {
    status.textContent = savedFeedback
      ? `Saved to agent memory · ${savedFeedback.rating}/5`
      : 'Choose a rating and press Save feedback';
  }
  const save = root.querySelector('.feedback-save');
  if (save) save.disabled = !rating;
}

async function saveFeedback(item, rating, userNote, root) {
  if (!rating) return;
  const id = feedbackId(item);
  feedbackState = feedbackState.filter(entry => entry.id !== id);
  const saved = {
    schemaVersion: 2,
    id,
    rating,
    userNote: String(userNote || '').trim().slice(0, 1000),
    author: String(item.author || '').slice(0, 250),
    url: String(item.url || '').slice(0, 1000),
    postText: String(item.postText || '').slice(0, 4000),
    reply: String(item.reply || '').slice(0, 1000),
    createdAt: new Date().toISOString()
  };
  feedbackState.unshift(saved);
  feedbackState = feedbackState.slice(0, 100);
  await chrome.storage.local.set({ [FEEDBACK_KEY]: feedbackState });
  updateFeedbackDraft(root, rating, saved);
  const button = root.querySelector('.feedback-save');
  if (button) {
    button.textContent = 'Saved';
    setTimeout(() => { button.textContent = 'Save feedback'; }, 1200);
  }
  updateLearningSummary();
}

function renderFeedback(item) {
  const box = el('div', 'feedback');
  const existing = currentFeedback(item);
  let draftRating = existing?.rating || 0;

  const heading = el('div', 'feedback-heading');
  heading.append(
    el('strong', '', 'Rate this answer'),
    el('span', 'feedback-rating-value', draftRating ? `${draftRating}/5` : 'Not rated')
  );

  const rating = el('div', 'rating-scale');
  for (let value = 1; value <= 5; value++) {
    const button = el('button', 'rating-button', String(value));
    button.type = 'button';
    button.dataset.rating = String(value);
    button.title = `${value} out of 5`;
    button.addEventListener('click', () => {
      draftRating = value;
      updateFeedbackDraft(box, draftRating, null);
    });
    rating.appendChild(button);
  }

  const note = document.createElement('textarea');
  note.className = 'feedback-note';
  note.rows = 3;
  note.maxLength = 1000;
  note.placeholder = 'Describe how you would like this answer to look: tone, length, wording, missing details…';
  note.value = existing?.userNote || '';
  note.addEventListener('input', () => {
    const status = box.querySelector('.feedback-status');
    if (status) status.textContent = 'Unsaved changes';
  });

  const status = el('span', 'feedback-status');
  const save = el('button', 'feedback-save', 'Save feedback');
  save.type = 'button';
  save.addEventListener('click', () => saveFeedback(item, draftRating, note.value, box));

  const footer = el('div', 'feedback-footer');
  footer.append(status, save);
  box.append(heading, rating, note, footer);
  updateFeedbackDraft(box, draftRating, existing);
  return box;
}

function renderItem(item, index) {
  const card = el('article', 'item');
  const head = el('div', 'item-head');
  const author = el('strong', 'author', item.author || `Post ${index + 1}`);
  const status = el('span', `status status-${item.status}`, item.status);
  head.append(author, status);
  card.appendChild(head);

  card.append(el('h2', '', 'Post'), el('p', '', item.postText || 'Post text was not captured.'));

  if (item.reply) {
    card.append(el('h2', '', 'Agent reply'), el('p', 'reply', item.reply));
    card.appendChild(renderFeedback(item));
  }
  if (item.error) {
    card.append(el('h2', '', 'Error'), el('p', 'error', item.error));
  }
  if (item.url) {
    const actions = el('div', 'item-actions');
    const link = el('a', 'post-link', 'Open post');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    actions.appendChild(link);
    card.appendChild(actions);
  }
  return card;
}

function buildSummary(report) {
  return [
    `X Agent run: ${formatDate(report.finishedAt)}`,
    `Provider: ${report.provider === 'chatgpt' ? 'ChatGPT' : 'OpenRouter'}`,
    `Sent: ${report.sent}, drafts: ${report.drafts}, errors: ${report.errors}`,
    `Delay: ${report.delayMinSeconds}-${report.delayMaxSeconds}s`
  ].join('\n');
}

async function render() {
  const stored = await chrome.storage.local.get([REPORT_KEY, FEEDBACK_KEY]);
  const report = stored[REPORT_KEY];
  const rawFeedback = Array.isArray(stored[FEEDBACK_KEY]) ? stored[FEEDBACK_KEY] : [];
  feedbackState = rawFeedback.map(normalizeFeedbackEntry).filter(Boolean).slice(0, 100);
  if (rawFeedback.some(entry => entry?.schemaVersion !== 2)) {
    await chrome.storage.local.set({ [FEEDBACK_KEY]: feedbackState });
  }
  if (!report) {
    document.getElementById('emptyState').hidden = false;
    return;
  }

  const duration = formatDuration(report.startedAt, report.finishedAt);
  document.getElementById('runMeta').textContent =
    `${formatDate(report.finishedAt)} · ${report.provider === 'chatgpt' ? 'ChatGPT' : 'OpenRouter'}${duration ? ` · ${duration}` : ''}`;

  const stats = document.getElementById('stats');
  addStat(stats, report.sent || 0, 'Sent');
  addStat(stats, report.drafts || 0, 'Drafts');
  addStat(stats, report.errors || 0, 'Errors');
  addStat(stats, report.completed || 0, `Completed of ${report.requested || 0}`);

  document.getElementById('summary').textContent =
    report.stopped ? 'The run was stopped. Partial results are shown below.' : 'The run finished. All data stays in this browser.';

  const items = document.getElementById('items');
  (report.items || []).forEach((item, index) => items.appendChild(renderItem(item, index)));
  updateLearningSummary();
  document.getElementById('reportContent').hidden = false;

  document.getElementById('copySummary').addEventListener('click', async event => {
    await navigator.clipboard.writeText(buildSummary(report));
    const button = event.currentTarget;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy summary'; }, 1200);
  });

  document.getElementById('exportFeedback').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(feedbackState, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-helper-x-feedback-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  document.getElementById('resetFeedback').addEventListener('click', async () => {
    if (!confirm('Reset all X Agent memory? This cannot be undone.')) return;
    await chrome.storage.local.remove(FEEDBACK_KEY);
    location.reload();
  });
}

render().catch(error => {
  document.getElementById('emptyState').hidden = false;
  document.getElementById('emptyState').textContent = `Could not load report: ${error.message}`;
});
