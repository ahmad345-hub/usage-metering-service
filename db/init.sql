-- Schema and predefined plans. The service runs this file at every start (src/db/migrate.ts),
-- so it must be safe to run repeatedly: every statement is idempotent.

CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    plan_type VARCHAR(20) NOT NULL,
    account_id INTEGER,
    monthly_limit BIGINT NOT NULL,
    max_per_request INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_plan_type
        CHECK (plan_type IN ('account', 'user')),

    CONSTRAINT valid_monthly_limit
        CHECK (monthly_limit >= 0),

    CONSTRAINT valid_max_per_request
        CHECK (max_per_request > 0)
);

-- Added after the first version: set whenever a custom plan is edited.
-- (Also upgrades a database that was created from the older init.sql.)
ALTER TABLE plans
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();


CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    api_key_hash VARCHAR(255) NOT NULL UNIQUE,
    plan_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_account_plan
        FOREIGN KEY (plan_id)
        REFERENCES plans(id)
);

-- The API accepts account names up to 255 characters (was 100).
ALTER TABLE accounts
ALTER COLUMN name TYPE VARCHAR(255);


CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL,
    external_id VARCHAR(100) NOT NULL,
    plan_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_user_account
        FOREIGN KEY (account_id)
        REFERENCES accounts(id),

    CONSTRAINT fk_user_plan
        FOREIGN KEY (plan_id)
        REFERENCES plans(id),

    CONSTRAINT unique_account_user
        UNIQUE (account_id, external_id),

    CONSTRAINT unique_user_account
        UNIQUE (id, account_id)
);


CREATE TABLE IF NOT EXISTS usage_records (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL,
    user_id INTEGER,
    month DATE NOT NULL,
    used_units BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT fk_usage_account
        FOREIGN KEY (account_id)
        REFERENCES accounts(id),

    CONSTRAINT fk_usage_user_account
        FOREIGN KEY (user_id, account_id)
        REFERENCES users(id, account_id),

    CONSTRAINT valid_used_units
        CHECK (used_units >= 0),

    CONSTRAINT valid_usage_month
        CHECK (EXTRACT(DAY FROM month) = 1)
);


CREATE UNIQUE INDEX IF NOT EXISTS unique_account_month
ON usage_records (account_id, month)
WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unique_user_month
ON usage_records (user_id, month)
WHERE user_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS usage_requests (
    id BIGSERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    request_id VARCHAR(100) NOT NULL,
    units INTEGER NOT NULL,
    accepted BOOLEAN NOT NULL,
    rejection_level VARCHAR(20),
    rejection_rule VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_request_account
        FOREIGN KEY (account_id)
        REFERENCES accounts(id),

    CONSTRAINT fk_request_user_account
        FOREIGN KEY (user_id, account_id)
        REFERENCES users(id, account_id),

    CONSTRAINT unique_account_request
        UNIQUE (account_id, request_id),

    CONSTRAINT valid_request_units
        CHECK (units > 0),

    CONSTRAINT valid_rejection_level
        CHECK (
            rejection_level IS NULL
            OR rejection_level IN ('account', 'user')
        ),

    CONSTRAINT valid_rejection_rule
        CHECK (
            rejection_rule IS NULL
            OR rejection_rule IN ('monthly_limit', 'max_per_request')
        ),

    CONSTRAINT valid_request_decision
        CHECK (
            (
                accepted = TRUE
                AND rejection_level IS NULL
                AND rejection_rule IS NULL
            )
            OR
            (
                accepted = FALSE
                AND rejection_level IS NOT NULL
                AND rejection_rule IS NOT NULL
            )
        )
);


-- ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS, so check the catalog first.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_plan_owner'
    ) THEN
        ALTER TABLE plans
        ADD CONSTRAINT fk_plan_owner
        FOREIGN KEY (account_id)
        REFERENCES accounts(id);
    END IF;
END $$;


CREATE UNIQUE INDEX IF NOT EXISTS unique_default_plan
ON plans (plan_type, name)
WHERE account_id IS NULL;


CREATE UNIQUE INDEX IF NOT EXISTS unique_custom_plan
ON plans (account_id, plan_type, name)
WHERE account_id IS NOT NULL;


CREATE INDEX IF NOT EXISTS idx_usage_requests_history
ON usage_requests (account_id, created_at DESC);

-- History filtered by one user (GET /api/usage/history?external_id=...).
CREATE INDEX IF NOT EXISTS idx_usage_requests_user_history
ON usage_requests (user_id, created_at DESC);


CREATE INDEX IF NOT EXISTS idx_usage_records_month
ON usage_records (account_id, month);



INSERT INTO plans (
    name,
    plan_type,
    account_id,
    monthly_limit,
    max_per_request
)
VALUES
    ('Starter', 'account', NULL, 2400, 35),
    ('Pro', 'account', NULL, 18000, 250),
    ('Basic', 'user', NULL, 180, 12),
    ('Premium', 'user', NULL, 1800, 85)
ON CONFLICT DO NOTHING;
