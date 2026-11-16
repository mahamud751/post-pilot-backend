import {config} from 'dotenv';
import {resolve} from 'path';

/**
 * Points the app at an isolated `e2e` schema in the same database as .env,
 * so tests never touch development data. Override with E2E_DATABASE_URL.
 */
export function e2eDatabaseUrl() {
  config({path: resolve(__dirname, '../.env')});
  if (process.env.E2E_DATABASE_URL) {
    return process.env.E2E_DATABASE_URL;
  }
  const url = new URL(String(process.env.DATABASE_URL));
  url.searchParams.set('schema', 'e2e');
  return url.toString();
}

process.env.DATABASE_URL = e2eDatabaseUrl();
process.env.JWT_SECRET = 'e2e-secret';
// Tests drive the publisher directly and use their own queue namespace, so a running dev
// server's worker never sees test jobs.
process.env.PUBLISH_WORKER = 'off';
process.env.QUEUE_PREFIX = 'postpilot-e2e';
process.env.BILLING_WEBHOOK_SECRET = 'e2e-webhook-secret';
process.env.EMAIL_DELIVERY = 'log';
process.env.APP_URL = 'http://localhost:9999/v1';
process.env.WEB_APP_URL = 'http://localhost:3999';
process.env.SUPER_ADMIN_EMAILS = 'root@e2e.test';
