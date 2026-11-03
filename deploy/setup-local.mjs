import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { createLocalCertificates } from './local-pki.mjs';

// Explicit creation only. No operator file is read, replaced or recursively deleted.
try {
  const path = process.argv[2];
  if (process.argv.length !== 3 || !path || !isAbsolute(path))
    throw new Error();
  mkdirSync(path, { mode: 0o700 }); // Exclusive directory: refuses existing paths.
  const directory = join(path, 'secrets');
  mkdirSync(directory, { mode: 0o700 });
  const certificates = createLocalCertificates();
  const write = (name, value) =>
    writeFileSync(join(directory, name), value, { flag: 'wx', mode: 0o600 });
  write('hmac.key', `${randomBytes(32).toString('base64url')}\n`);
  write('backup.key', `${randomBytes(32).toString('base64url')}\n`);
  write('echo-bearer', `${randomBytes(32).toString('base64url')}\n`);
  write('echo-server.key', certificates.key);
  write('echo-server.crt', certificates.cert);
  write('echo-ca.crt', certificates.ca);
  write('allowed-users', '42\n');
  write(
    'agents.json',
    `${JSON.stringify(
      {
        instance_id: 'jarvis-demo',
        subjects: [{ telegram_user_id: 42, subject_ref: 'owner-demo' }],
        agents: [
          {
            instance_id: 'jarvis-demo',
            descriptor: {
              protocol_version: '1.0',
              agent_id: 'demo.echo',
              agent_version: '0.1.0',
              name: 'Echo independiente local',
              capabilities: [
                {
                  name: 'echo.reply',
                  version: '1.0',
                  description:
                    'Demo local de lectura sin operaciones de negocio.',
                  effect: 'read',
                  supports_idempotency: true,
                  input_schema_id: 'demo.input.v1',
                  output_schema_id: 'demo.output.v1',
                },
              ],
            },
            enabled: true,
            availability: 'available',
            connection: {
              base_url: 'https://echo:8443',
              request_credential_ref: 'echo-request',
              event_key_ref: 'unused-events',
            },
            permissions: [
              {
                subject_ref: 'owner-demo',
                capabilities: [{ name: 'echo.reply', version: '1.0' }],
              },
            ],
          },
        ],
        allowed_endpoints: [
          { origin: 'https://echo:8443', private_addresses: ['172.30.77.10'] },
        ],
        credential_variables: { 'echo-request': 'JARVIS_ECHO_BEARER' },
        result_cache_ms: 60_000,
        ca_file: 'echo_ca',
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(path, 'backups'), { mode: 0o700 });
  mkdirSync(join(path, 'recovery'), { mode: 0o700 });
  process.stdout.write(
    'Local demo material created. Telegram token is NOT configured. Protect host permissions; see docs/LOCAL_DEPLOYMENT.md.\n',
  );
} catch {
  // Partial directories are kept for inspection. Never delete or overwrite them.
  process.stderr.write(
    'Local demo setup failed; no existing files were replaced.\n',
  );
  process.exitCode = 1;
}
