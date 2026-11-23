const SECRET_PATTERN = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{2,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})|\bghp_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}|\b(?:password|passwd|pwd|api[\s_-]?key|private[\s_-]?key|secret|credential|access[\s_-]?token|token)\b\s*[:=]\s*\S+|\b(?:secret|token)\s+[A-Za-z0-9._~+/=-]{10,}|\.conchbase\/|runtime\.sqlite/i;

export function containsSecretLike(value: string | null | undefined): boolean {
  return SECRET_PATTERN.test(value ?? '');
}
