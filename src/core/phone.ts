export function normalizePhone(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return null;
}

/** Valid phone clusters (10–11 digits after normalization). */
const PHONE_CLUSTER_RE =
  /(?:\+7|8)(?:[\s\-().]*\d){10}|(?:\+7|8)(?:[\s\-().]*\d){9,10}|\b\d(?:[\s\-().]*\d){9,10}\b/g;

/** Looser clusters for malformed phone attempts (12+ digits in one cluster). */
const PHONE_ATTEMPT_CLUSTER_RE = /(?:\+7|8)(?:[\s\-().]*\d){11,}|\b\d(?:[\s\-().]*\d){11,}\b/g;

function extractPhoneClusters(text: string): string[] {
  return text.match(PHONE_CLUSTER_RE) ?? [];
}

function extractPhoneAttemptCluster(text: string): string | null {
  const malformed = text.match(PHONE_ATTEMPT_CLUSTER_RE)?.[0];
  if (malformed) return malformed;
  return extractPhoneClusters(text)[0] ?? null;
}

/**
 * Extracts a normalized phone from a chat message.
 * Ignores scattered digits from cargo sizes, addresses, and prices.
 */
export function normalizePhoneFromMessage(text: string): string | null {
  for (const cluster of extractPhoneClusters(text)) {
    const normalized = normalizePhone(cluster);
    if (normalized) return normalized;
  }
  return null;
}

/** Digits from the first phone-like cluster, for invalid-phone retry flow. */
export function extractPhoneLikeDigits(text: string): string | null {
  const cluster = extractPhoneAttemptCluster(text);
  if (!cluster) return null;
  const digits = cluster.replace(/\D/g, '');
  return digits || null;
}
