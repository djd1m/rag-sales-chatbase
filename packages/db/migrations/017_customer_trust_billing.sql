ALTER TABLE payment_intent
  DROP CONSTRAINT payment_intent_status_check,
  ADD CHECK (status IN ('created','succeeded','canceled','reconciliation_required')),
  ADD COLUMN offer_version text,
  ADD COLUMN offer_digest text,
  ADD COLUMN offer_accepted_at timestamptz,
  ADD COLUMN checkout_snapshot jsonb,
  ADD COLUMN first_post_at timestamptz,
  ADD COLUMN applied_paid_until timestamptz;
CREATE INDEX payment_intent_open_owner ON payment_intent(account_id) WHERE status IN ('created','reconciliation_required');

ALTER TABLE payment DROP CONSTRAINT payment_review_reason_check;
ALTER TABLE payment ADD CHECK (review_reason IN ('amount_mismatch','refund','unknown_intent','account_erasing','plan_conflict','binding_conflict'));

CREATE TABLE purchase_mail_delivery (
  intent_id uuid PRIMARY KEY REFERENCES payment_intent(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL UNIQUE REFERENCES payment(id),
  account_id uuid NOT NULL REFERENCES account(id),
  recipient text,
  plan text NOT NULL CHECK (plan IN ('nobadge','studio')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  paid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','permanent','revoked','reconciliation_required')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  due_at timestamptz NOT NULL DEFAULT now(),
  first_send_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  message text,
  delivery_key text,
  provider_id text
);
CREATE INDEX purchase_mail_due ON purchase_mail_delivery(due_at) WHERE state IN ('pending','sending');
CREATE INDEX purchase_mail_owner ON purchase_mail_delivery(account_id);
