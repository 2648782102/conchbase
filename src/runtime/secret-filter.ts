const SECRET_PATTERN = /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{2,}|\bBearer\s+[A-Za-z0-9._-]{10,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bpassword\b|\bapiKey\b|\bprivateKey\b|\.conchbase\/|runtime\.sqlite/i;

export function containsSecretLike(value: string | null | undefined): boolean {
  return SECRET_PATTERN.test(value ?? '');
}
