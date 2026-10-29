process.env.NODE_ENV = 'test';
process.env.JOBS_ENABLED = 'false';
process.env.AUTH_RATE_LIMIT = '10000';
process.env.DATABASE_OWNER_URL ??= 'postgres://kora_owner:kora_owner_dev@localhost:5432/kora_test';
process.env.DATABASE_APP_URL ??= 'postgres://kora_app:kora_app_dev@localhost:5432/kora_test';
process.env.DATABASE_PLATFORM_URL ??= 'postgres://kora_platform:kora_platform_dev@localhost:5432/kora_test';
