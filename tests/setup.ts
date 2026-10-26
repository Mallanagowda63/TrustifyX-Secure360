import fs from "node:fs";
import path from "node:path";

// Load .env if present, then point the suite at the dedicated test database.
const envFile = path.resolve(__dirname, "../.env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL ??= "postgresql://invalid/unused";
process.env.APP_URL = "http://localhost:3000";
process.env.MONITOR_ALLOW_PRIVATE_TARGETS = "false";
process.env.MONITOR_DOWN_THRESHOLD = "2";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
// SMTP is replaced by a capturing transport in the tests that need it.
process.env.SMTP_HOST = "";
// Billing: deterministic test-mode credentials (a fake gateway is injected in billing tests).
process.env.RAZORPAY_KEY_ID = "rzp_test_fakekey";
process.env.RAZORPAY_KEY_SECRET = "test_key_secret_123";
process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret_456";
process.env.BILLING_MODE = "recurring";
process.env.BILLING_ANNUAL_ENABLED = "true";
process.env.BILLING_TAX_RATE_BP = "1800";
process.env.BILLING_PRICES_INCLUDE_TAX = "false";
process.env.BILLING_GRACE_DAYS = "7";
// Isolate queue/rate-limit keys from the development worker.
process.env.REDIS_URL = `${(process.env.REDIS_URL ?? "redis://localhost:6379").replace(/\/\d+$/, "")}/15`;
