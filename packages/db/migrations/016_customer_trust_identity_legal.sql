ALTER TABLE account ADD COLUMN email_verified_at timestamptz;

CREATE TABLE legal_acceptance (
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('terms','consent')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 80),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind, version)
);

CREATE TABLE customer_email_proof (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('verify','reset')),
  issuer_hash text REFERENCES session(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  CHECK ((purpose = 'verify') = (issuer_hash IS NOT NULL)),
  UNIQUE (account_id, purpose, active)
);
CREATE INDEX customer_email_proof_expiry ON customer_email_proof(expires_at);

-- Returning to a previously used address must not restore its verification or links.
CREATE FUNCTION clear_changed_email_proofs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.email_verified_at := NULL;
  DELETE FROM customer_email_proof WHERE account_id = OLD.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_email_change BEFORE UPDATE OF email ON account
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email) EXECUTE FUNCTION clear_changed_email_proofs();
