import {execSync} from 'child_process';
import {resolve} from 'path';
import {e2eDatabaseUrl} from './e2e-env';

export default function globalSetup() {
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env: {...process.env, DATABASE_URL: e2eDatabaseUrl()},
    stdio: 'ignore',
  });
}
