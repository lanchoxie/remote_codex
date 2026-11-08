'use strict';

const IMAGE_INPUT_TYPES = new Set(['image', 'localImage']);

function normalizeInputTypes(inputTypes) {
  const values = Array.isArray(inputTypes) ? inputTypes : [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const type = String(value || '').trim();
    if (!type || seen.has(type)) {
      continue;
    }
    seen.add(type);
    result.push(type);
  }
  return result.slice(0, 8);
}

function classifyCodexInputCompatibilityError(message, inputTypes = []) {
  const rawMessage = String(message || '').trim();
  if (!rawMessage) {
    return null;
  }

  const normalizedTypes = normalizeInputTypes(inputTypes);
  const hasImageInput = normalizedTypes.some((type) => IMAGE_INPUT_TYPES.has(type));
  const indexedContentArrayError = /Invalid\s+['"`]?input\[\d+\]\.content['"`]?\s*:\s*array\s+too\s+long/i.test(rawMessage)
    || /\[\s*input\[\d+\]\.content\s*\][\s\S]{0,120}(?:array_above_max_length|array\s+too\s+long)/i.test(rawMessage);
  const indexedContentUnknownParameterError = /\[\s*input\[\d+\]\.content\s*\]\s*\[\s*unknown_parameter\s*\]/i.test(rawMessage)
    || /unknown\s+parameter\s*:\s*['"]?input\[\d+\]\.content['"]?/i.test(rawMessage);
  const zeroLengthArrayLimit = /Expected\s+(?:an\s+array\s+with\s+)?maximum\s+length\s+0\s*,?\s*(?:but\s+)?got\s+(?:an\s+array\s+with\s+)?length\s+1(?:\s+instead)?/i.test(rawMessage);
  const contentArrayRejected = indexedContentArrayError && zeroLengthArrayLimit;
  const contentSchemaRejected = contentArrayRejected || indexedContentUnknownParameterError;
  // Providers phrase this in either direction ("image is unsupported" or
  // "does not support image input"). Keep the capability hint bounded so a
  // generic error mentioning both words in unrelated contexts is not classified.
  const explicitImageRejection = /(?:image|vision|multimodal)[\s\S]{0,120}(?:unsupported|not\s+supported|does\s+not\s+support|cannot|can't|invalid)|(?:unsupported|not\s+supported|does\s+not\s+support|cannot|can't|invalid)[\s\S]{0,120}(?:image|vision|multimodal)/i.test(rawMessage);

  if (hasImageInput && (contentArrayRejected || explicitImageRejection)) {
    return {
      code: 'session_input_image_unsupported',
      kind: 'image',
      inputTypes: normalizedTypes,
      userMessage: 'This API/model does not accept image input. Remove the image attachment and retry; text-only prompts can continue.',
      rawMessage,
    };
  }

  if (contentSchemaRejected) {
    return {
      code: 'session_responses_history_incompatible',
      kind: 'responses-history',
      inputTypes: normalizedTypes,
      userMessage: "This API provider rejected the Session's Responses history; changing models (including switching to 5.6) does not fix this schema error. If this endpoint uses Sub2API, update to a build containing Wei-Shaw/sub2api PR #5888 (commit acce29af), then retry. If the provider still cannot read this history, create a new Session from the transcript. The original Session and its complete native history were not cropped or converted.",
      rawMessage,
    };
  }

  return null;
}

function isModelMetadataFallbackNotice(message) {
  return /^Model metadata for .+? not found\.?(?:\s+Defaulting to fallback metadata(?:[;:.]\s*.*)?)?$/i
    .test(String(message || '').trim());
}

module.exports = {
  classifyCodexInputCompatibilityError,
  isModelMetadataFallbackNotice,
  normalizeInputTypes,
};
