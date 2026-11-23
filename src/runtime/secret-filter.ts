const SECRET_PATTERN = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{2,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})|\bghp_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\bBearer\s+[A-Za-z0-9._-]{10,}|\bpassword\b|\bapi[_-]?key\b|\bprivate[_-]?key\b|\bsecret\b|\bcredential\b|\.conchbase\/|runtime\.sqlite/i;

export function containsSecretLike(value: string | null | undefined): boolean {
  return SECRET_PATTERN.test(value ?? '');
}
