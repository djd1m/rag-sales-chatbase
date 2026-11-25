import type { Pool } from 'pg';
import { transaction } from './quota.js';

interface Lease { intent_id: string; account_id: string; lease_id: string }
interface Delivery extends Lease {
  recipient: string; plan: 'nobadge' | 'studio'; amount_minor: number; paid_until: Date;
  message: string | null; delivery_key: string | null;
}

// All deadlines are evaluated by PostgreSQL. The admission commit is the point
// at which one specific HTTP attempt may have started, even if the process dies.
const expired = `(attempts >= 5 OR (first_send_at IS NOT NULL AND first_send_at <= clock_timestamp()-interval '23 hours 50 minutes')
  OR (first_send_at IS NULL AND created_at <= clock_timestamp()-interval '7 days'))`;
const clearPersonal = 'recipient=NULL,message=NULL,lease_id=NULL,lease_until=NULL';

export class PurchaseMailDeliveryStore {
  constructor(private readonly pool: Pool) { }

  async expire(): Promise<void> {
    await this.pool.query(`UPDATE purchase_mail_delivery SET state='reconciliation_required',${clearPersonal}
      WHERE intent_id IN (SELECT intent_id FROM purchase_mail_delivery WHERE state IN ('pending','sending')
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND ${expired}
        ORDER BY due_at LIMIT 5 FOR UPDATE SKIP LOCKED)`);
  }

  async lease(enabled: boolean): Promise<Lease | null> {
    if (!enabled) return null;
    const res = await this.pool.query<Lease>(`UPDATE purchase_mail_delivery SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds'
      WHERE intent_id=(SELECT intent_id FROM purchase_mail_delivery WHERE state IN ('pending','sending') AND due_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND NOT ${expired}
        ORDER BY due_at,intent_id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING intent_id,account_id,lease_id`);
    return res.rows[0] ?? null;
  }

  async admit(lease: Lease, render: (row: Delivery) => string): Promise<{ message: string; key: string; validUntil: Date } | null> {
    return transaction(this.pool, async tx => {
      const active = await tx.query("SELECT id FROM account WHERE id=$1 AND status='active' FOR NO KEY UPDATE", [lease.account_id]);
      if (!active.rowCount) return null;
      const args = [lease.intent_id, lease.lease_id];
      const row = (await tx.query<Delivery>(`SELECT * FROM purchase_mail_delivery WHERE intent_id=$1 AND lease_id=$2
        AND lease_until>clock_timestamp() AND state IN ('pending','sending') AND NOT ${expired} FOR UPDATE`, args)).rows[0];
      if (!row) return null;
      const message = row.message ?? render(row);
      const key = row.delivery_key ?? 'sufler-purchase-' + row.intent_id;
      const admitted = await tx.query<{ valid_until: Date }>(`UPDATE purchase_mail_delivery SET message=$3,delivery_key=$4,state='sending',
        first_send_at=COALESCE(first_send_at,clock_timestamp()),attempts=attempts+1,
        due_at=clock_timestamp()+make_interval(mins=>(ARRAY[1,5,30,120,120])[attempts+1])
        WHERE intent_id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() AND NOT ${expired}
        RETURNING LEAST(lease_until,first_send_at+interval '23 hours 50 minutes') AS valid_until`, [...args, message, key]);
      return admitted.rowCount ? { message, key, validUntil: admitted.rows[0]!.valid_until } : null;
    });
  }

  async finish(lease: Lease, result: { status: 'accepted'; providerId: string } | { status: 'permanent' | 'retryable' | 'unknown' }): Promise<boolean> {
    const res = await this.pool.query(`WITH outcome AS (
      SELECT intent_id,CASE WHEN $3 IN ('accepted','permanent') THEN $3 WHEN ${expired} THEN 'reconciliation_required' ELSE 'pending' END AS state
      FROM purchase_mail_delivery WHERE intent_id=$1 AND lease_id=$2 AND state='sending' AND lease_until>clock_timestamp() FOR UPDATE
    ) UPDATE purchase_mail_delivery d SET state=o.state,lease_id=NULL,lease_until=NULL,provider_id=$4,
      recipient=CASE WHEN o.state='pending' THEN d.recipient END,message=CASE WHEN o.state='pending' THEN d.message END
      FROM outcome o WHERE d.intent_id=o.intent_id`, [lease.intent_id, lease.lease_id, result.status, result.status === 'accepted' ? result.providerId : null]);
    return res.rowCount === 1;
  }
}
