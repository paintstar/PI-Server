export function estimateTextTokens(text = '') {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return cjk / 1.3 + (text.length - cjk) / 3.8;
}

export function estimateRoundedTokens(text = '') {
  return Math.round(estimateTextTokens(text));
}
