const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('background.js', 'utf8');
const helperStart = source.indexOf('const CHATGPT_UI_LABELS');
const helperEnd = source.indexOf('// --- Провайдеры ---');
const xReplyStart = source.indexOf('function cleanXAgentReply');
const xReplyEnd = source.indexOf('function normalizeXAgentFeedbackEntry');
const urlStart = source.indexOf('function normalizeChatGPTConversationUrl');
const urlEnd = source.indexOf('async function getConfiguredChatGPTConversationUrl');
const xPromptStart = source.indexOf('function buildXAgentMessages');
const xPromptEnd = source.indexOf('async function generateXAgentReply');

assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Output sanitizer helpers were not found');
assert.ok(xReplyStart >= 0 && xReplyEnd > xReplyStart, 'X reply sanitizer was not found');
assert.ok(urlStart >= 0 && urlEnd > urlStart, 'ChatGPT URL normalizer was not found');
assert.ok(xPromptStart >= 0 && xPromptEnd > xPromptStart, 'X Agent prompt builder was not found');

const context = { URL };
vm.createContext(context);
vm.runInContext(`
${source.slice(helperStart, helperEnd)}
${source.slice(xReplyStart, xReplyEnd)}
${source.slice(urlStart, urlEnd)}
const LANG_NAMES = { en: 'English' };
function buildXAgentFeedbackContext() { return ''; }
function buildXRelationshipPromptContext() { return ''; }
${source.slice(xPromptStart, xPromptEnd)}
this.helpers = {
  cleanAssistantUiText,
  extractFirstModelVariant,
  cleanTranslationResult,
  cleanXAgentReply,
  normalizeChatGPTConversationUrl,
  buildXAgentMessages
};
`, context);

const {
  cleanAssistantUiText,
  extractFirstModelVariant,
  cleanTranslationResult,
  cleanXAgentReply,
  normalizeChatGPTConversationUrl,
  buildXAgentMessages
} = context.helpers;

assert.equal(
  cleanAssistantUiText('A natural reply\nРедактировать ответ\nКопировать'),
  'A natural reply'
);
assert.equal(
  extractFirstModelVariant('Option 1: First answer\nOption 2: Second answer', true),
  'First answer'
);
assert.equal(
  extractFirstModelVariant('**Option 1**\nFirst answer\n\n**Option 2**\nSecond answer', true),
  'First answer'
);
assert.equal(
  cleanXAgentReply('Вариант 1: Connect with builders who ship.\nВариант 2: Great post!'),
  'Connect with builders who ship.'
);
assert.equal(
  cleanTranslationResult(
    '[[DTH\\_LINE\\_0\\_9F4A]]\nUser Safety: safe\nПривет мир',
    '[[DTH_LINE_0_9F4A]]\nHello world'
  ),
  '[[DTH_LINE_0_9F4A]]\nПривет мир'
);
assert.equal(cleanTranslationResult('[Hello world]', 'Привет мир'), 'Hello world');
assert.throws(
  () => cleanTranslationResult('You are a translator. Output ONLY the translation.', 'Привет'),
  /repeated instructions/
);
assert.throws(
  () => cleanTranslationResult('Привет мир', '[[DTH_LINE_0_9F4A]]\nHello world'),
  /missing structure marker/
);
assert.throws(
  () => cleanTranslationResult('[[DTH_LINE_0_9F4A]]\nUser Safety: safe', '[[DTH_LINE_0_9F4A]]\nHello world'),
  /only structure markers/
);

assert.equal(
  normalizeChatGPTConversationUrl('https://chatgpt.com/c/6a972ae9-60f0-83ed-a4ce-e3698c3c79e7?model=auto'),
  'https://chatgpt.com/c/6a972ae9-60f0-83ed-a4ce-e3698c3c79e7'
);
assert.equal(normalizeChatGPTConversationUrl('https://example.com/c/not-chatgpt'), '');

const xMessages = buildXAgentMessages({
  text: 'A unique post body',
  author: 'Test (@test)',
  url: 'https://x.com/test/status/123'
}, {
  xAgentPrompt: 'Keep it natural.',
  outboundTargetLang: 'en'
});
const serializedXPrompt = xMessages.map(message => {
  return `${message.role.toUpperCase()}:\n${message.content}`;
}).join('\n\n');
assert.equal(xMessages.length, 2);
assert.equal((serializedXPrompt.match(/You are an assistant that writes replies/g) || []).length, 1);
assert.equal((serializedXPrompt.match(/A unique post body/g) || []).length, 1);

console.log('Model output sanitizer regression test: OK');
