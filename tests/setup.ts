// Test environment defaults — applied before modules load so env validation
// passes without a real database (health tests do not touch the DB).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/mozudkhata_test?schema=public";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
