const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('background.js', 'utf8');
const start = source.indexOf('function normalizeGeminiModelId');
const end = source.indexOf('async function fetchGeminiModelCatalog');
assert.ok(start >= 0 && end > start, 'Gemini model helpers were not found');

const context = {
  GEMINI_KNOWN_FALLBACKS: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash'
  ]
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}
this.helpers = {
  knownGeminiModelOptions,
  isGeminiRegionError,
  isGeminiTextModel,
  pickAutomaticGeminiModel,
  sortGeminiModels
};`, context);

const { isGeminiTextModel, pickAutomaticGeminiModel } = context.helpers;
const generateContent = ['generateContent'];

assert.equal(isGeminiTextModel({
  name: 'models/gemini-3.7-flash',
  supportedGenerationMethods: generateContent
}), true);
assert.equal(isGeminiTextModel({
  name: 'models/gemini-3.1-flash-image',
  supportedGenerationMethods: generateContent
}), false);
assert.equal(isGeminiTextModel({
  name: 'models/gemini-3.1-flash-live-preview',
  supportedGenerationMethods: generateContent
}), false);
assert.equal(isGeminiTextModel({
  name: 'models/gemini-3.5-flash',
  supportedGenerationMethods: ['countTokens']
}), false);

assert.equal(pickAutomaticGeminiModel([
  { id: 'gemini-3.1-pro-preview' },
  { id: 'gemini-3.5-flash-lite' },
  { id: 'gemini-3.6-flash' },
  { id: 'gemini-3.7-flash' }
]), 'gemini-3.7-flash');

assert.equal(pickAutomaticGeminiModel([
  { id: 'gemini-4.0-pro' },
  { id: 'gemini-3.5-flash-lite' }
]), 'gemini-3.5-flash-lite');

assert.equal(context.helpers.isGeminiRegionError({
  message: 'Gemini models: HTTP 400 User location is not supported for the API use.'
}), true);
assert.equal(context.helpers.knownGeminiModelOptions().length, 3);

console.log('Gemini dynamic model selection regression test: OK');
