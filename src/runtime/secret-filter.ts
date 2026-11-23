const SECRET_PATTERN = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{2,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})|\bghp_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}|\b(?:password|passwd|pwd|api[\s_-]?key|private[\s_-]?key|secret|credential|access[\s_-]?token|token)\b\s*[:=]\s*\S+|\b(?:secret|token)\s+[A-Za-z0-9._~+/=-]{10,}|\.conchbase\/|runtime\.sqlite/i;

const SENSITIVE_URL_PART = /(?:^|[/#?&])(?:sk[-_]?(?:live|test|proj)?[-_]?[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|(?:api|secret|token|pwd|passwd|password|credential)[-_][A-Za-z0-9_-]{8,})(?:$|[/#?&])/i;

export function containsSecretLike(value: string | null | undefined): boolean {
  return SECRET_PATTERN.test(value ?? '');
}

/**
 * Checks URL-local material that ordinary prose filters intentionally miss.
 *
 * Approval targets and web links can carry a credential in a path or fragment
 * without a context label. The query is stripped from durable approval
 * targets, but the raw URL must be classified before that happens, and the
 * derived target is checked again after slicing.
 */
export function containsSensitiveUrlTarget(value: string | URL): boolean {
  const text = String(value);
  if (containsSecretLike(text)) return true;
  let urlLocal = text;
  try {
    const parsed = new URL(text);
    urlLocal = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // A malformed URL is already rejected by the caller; still inspect the
    // raw text rather than silently treating it as safe.
  }
  return SENSITIVE_URL_PART.test(urlLocal);
}
