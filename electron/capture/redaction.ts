// Scrub obvious secrets BEFORE they hit disk.
// Patterns are intentionally conservative — false positives are fine,
// false negatives (leaked secret) are not.

const RULES: { name: string; re: RegExp; replace: string }[] = [
  { name: 'openai-key',       re: /\bsk-[a-zA-Z0-9_-]{20,}\b/g,                                replace: '[redacted:openai-key]' },
  { name: 'anthropic-key',    re: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,                            replace: '[redacted:anthropic-key]' },
  { name: 'github-token',     re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,                            replace: '[redacted:github-token]' },
  { name: 'aws-access',       re: /\bAKIA[0-9A-Z]{16}\b/g,                                      replace: '[redacted:aws-access-key]' },
  { name: 'aws-secret',       re: /\b[A-Za-z0-9/+=]{40}\b(?=.*\baws\b)/gi,                       replace: '[redacted:aws-secret]' },
  { name: 'google-api',       re: /\bAIza[0-9A-Za-z_-]{35}\b/g,                                  replace: '[redacted:google-key]' },
  { name: 'jwt',              re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[redacted:jwt]' },
  { name: 'private-key',      re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '[redacted:private-key]' },
  { name: 'ssn',              re: /\b\d{3}-\d{2}-\d{4}\b/g,                                     replace: '[redacted:ssn]' }
  // credit-card handled separately below (Luhn check)
];

function luhnRedact(s: string): string {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return s;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0 ? '[redacted:credit-card]' : s;
}

const CC_RE = /\b(?:\d[ -]*?){13,19}\b/g;

export function redact(text: string): { text: string; redacted: string[] } {
  let out = text;
  const hits: string[] = [];
  for (const rule of RULES) {
    const before = out;
    out = out.replace(rule.re, rule.replace);
    if (out !== before) hits.push(rule.name);
  }
  out = out.replace(CC_RE, (m) => {
    const r = luhnRedact(m);
    if (r !== m) hits.push('credit-card');
    return r;
  });
  return { text: out, redacted: Array.from(new Set(hits)) };
}
