import { createHmac } from 'node:crypto';

// The caller obtains the token from a validated session. This value cannot authorize a mutation.
export function previewClaimContext(secret: string, sessionToken: string): string {
  return createHmac('sha256', secret).update('sufler-preview-claim-context-v1\0').update(sessionToken).digest('base64url');
}
