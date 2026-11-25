import type { Pool, PoolClient } from 'pg';
import { transaction } from './quota.js';

type Purpose = 'verify' | 'reset';
type Identity = { account_id: string; email: string; verified: boolean };
type Proof = { account_id: string; email: string; issuer_hash: string | null };

export class CustomerEmailProofStore {
  constructor(private readonly pool: Pool) { }

  async viewer(sessionHash: string): Promise<Identity | null> {
    const rows = await this.pool.query<Identity>(`SELECT a.id AS account_id, a.email, a.email_verified_at IS NOT NULL AS verified
      FROM session s JOIN account a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp() AND a.status='active'`, [sessionHash]);
    return rows.rows[0] ?? null;
  }

  private async lockAccount(tx: PoolClient, accountId: string, email: string, purpose: Purpose) {
    const row = await tx.query(`SELECT id FROM account WHERE id=$1 AND email=$2 AND status='active'
      AND ($3 <> 'verify' OR email_verified_at IS NULL) FOR UPDATE`, [accountId, email, purpose]);
    return row.rowCount === 1;
  }

  private async lockSessions(tx: PoolClient, accountId: string, hashes: string[]) {
    const required = [...new Set(hashes)];
    const rows = await tx.query(`SELECT token_hash FROM session WHERE account_id=$1 AND token_hash=ANY($2::text[])
      AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY token_hash FOR SHARE`, [accountId, required]);
    return rows.rowCount === required.length;
  }

  async prepare(purpose: Purpose, email: string, digest: string, issuer: string | null) {
    return transaction(this.pool, async tx => {
      const account = (await tx.query<{ id: string }>(`SELECT id FROM account WHERE email=$1 AND status='active'
        AND ($2 <> 'verify' OR email_verified_at IS NULL) FOR UPDATE`, [email, purpose])).rows[0];
      if (!account || (purpose === 'verify' && (!issuer || !await this.lockSessions(tx, account.id, [issuer])))) return false;
      // One pending candidate, one active link. A late sender cannot activate a replaced candidate.
      await tx.query('DELETE FROM customer_email_proof WHERE account_id=$1 AND purpose=$2 AND NOT active', [account.id, purpose]);
      await tx.query(`INSERT INTO customer_email_proof(digest, account_id, purpose, email, issuer_hash, expires_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp() + make_interval(hours => $6))`,
        [digest, account.id, purpose, email, issuer, purpose === 'verify' ? 24 : 1]);
      return true;
    });
  }

  private async reference(tx: PoolClient, digest: string, purpose: Purpose, active: boolean) {
    return (await tx.query<Proof>(`SELECT account_id,email,issuer_hash FROM customer_email_proof
      WHERE digest=$1 AND purpose=$2 AND active=$3 AND expires_at>clock_timestamp()`, [digest, purpose, active])).rows[0];
  }

  async activate(purpose: Purpose, digest: string) {
    return transaction(this.pool, async tx => {
      const proof = await this.reference(tx, digest, purpose, false);
      if (!proof || !await this.lockAccount(tx, proof.account_id, proof.email, purpose)) return false;
      if (proof.issuer_hash && !await this.lockSessions(tx, proof.account_id, [proof.issuer_hash])) return false;
      const candidate = await tx.query(`SELECT 1 FROM customer_email_proof WHERE digest=$1 AND NOT active
        AND expires_at>clock_timestamp() FOR UPDATE`, [digest]);
      if (candidate.rowCount !== 1) return false;
      await tx.query('DELETE FROM customer_email_proof WHERE account_id=$1 AND purpose=$2 AND active', [proof.account_id, purpose]);
      await tx.query('UPDATE customer_email_proof SET active=true WHERE digest=$1', [digest]);
      return true;
    });
  }

  async confirm(digest: string, currentSession: string) {
    return transaction(this.pool, async tx => {
      const proof = await this.reference(tx, digest, 'verify', true);
      if (!proof?.issuer_hash || !await this.lockAccount(tx, proof.account_id, proof.email, 'verify') ||
        !await this.lockSessions(tx, proof.account_id, [proof.issuer_hash, currentSession])) return false;
      const used = await tx.query('DELETE FROM customer_email_proof WHERE digest=$1 AND active AND expires_at>clock_timestamp() RETURNING digest', [digest]);
      if (!used.rowCount) return false;
      await tx.query("DELETE FROM customer_email_proof WHERE account_id=$1 AND purpose='verify'", [proof.account_id]);
      await tx.query('UPDATE account SET email_verified_at=clock_timestamp() WHERE id=$1', [proof.account_id]);
      return true;
    });
  }

  async canReset(digest: string) {
    const row = await this.pool.query(`SELECT 1 FROM customer_email_proof p JOIN account a ON a.id=p.account_id
      WHERE p.digest=$1 AND p.active AND p.purpose='reset' AND p.expires_at>clock_timestamp() AND a.email=p.email AND a.status='active'`, [digest]);
    return row.rowCount === 1;
  }

  async reset(digest: string, passwordHash: string) {
    return transaction(this.pool, async tx => {
      const proof = await this.reference(tx, digest, 'reset', true);
      if (!proof || !await this.lockAccount(tx, proof.account_id, proof.email, 'reset')) return false;
      // Take session locks before the final expiry check. Logout may already hold one.
      await tx.query('SELECT id FROM session WHERE account_id=$1 AND revoked_at IS NULL ORDER BY id FOR UPDATE', [proof.account_id]);
      const used = await tx.query(`DELETE FROM customer_email_proof WHERE digest=$1 AND active
        AND purpose='reset' AND expires_at>clock_timestamp() RETURNING digest`, [digest]);
      if (!used.rowCount) return false;
      await tx.query('UPDATE session SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL', [proof.account_id]);
      await tx.query('DELETE FROM customer_email_proof WHERE account_id=$1', [proof.account_id]);
      await tx.query('UPDATE account SET password_hash=$2 WHERE id=$1', [proof.account_id, passwordHash]);
      return true;
    });
  }

  async purgeExpired() {
    const result = await this.pool.query(`DELETE FROM customer_email_proof WHERE digest IN
      (SELECT digest FROM customer_email_proof WHERE expires_at<=now() ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED)`);
    return result.rowCount ?? 0;
  }
}
