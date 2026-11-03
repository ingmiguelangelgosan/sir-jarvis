import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Ephemeral test PKI. Keys never touch disk or logs and are not production assets. */
export interface TestCertificates {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
}

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const content = Buffer.concat(parts);
  const length: number[] = [];
  let remaining = content.length;
  do {
    length.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return Buffer.concat([
    Buffer.from([
      tag,
      ...(content.length < 128
        ? [content.length]
        : [0x80 | length.length, ...length]),
    ]),
    content,
  ]);
}

function sequence(...parts: readonly Uint8Array[]): Buffer {
  return der(0x30, ...parts);
}

function oid(value: string): Buffer {
  const components = value.split('.').map(Number);
  const bytes = [(components[0] ?? 0) * 40 + (components[1] ?? 0)];
  for (const component of components.slice(2)) {
    const encoded = [component & 0x7f];
    let rest = Math.floor(component / 128);
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function commonName(value: string): Buffer {
  return sequence(
    der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(value)))),
  );
}

function generalizedTime(value: Date): Buffer {
  const text = value
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return der(0x18, Buffer.from(text));
}

function extension(id: string, value: Uint8Array, critical = false): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    der(0x04, value),
  );
}

function pem(label: string, value: Uint8Array): string {
  const base64 = Buffer.from(value).toString('base64');
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${label}-----\n`;
}

function certificate(options: {
  readonly subject: Buffer;
  readonly issuer: Buffer;
  readonly publicKey: KeyObject;
  readonly signingKey: KeyObject;
  readonly extensions: readonly Buffer[];
  readonly notBefore: Date;
  readonly notAfter: Date;
}): string {
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 1;
  const body = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    options.issuer,
    sequence(
      generalizedTime(options.notBefore),
      generalizedTime(options.notAfter),
    ),
    options.subject,
    options.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(...options.extensions)),
  );
  return pem(
    'CERTIFICATE',
    sequence(
      body,
      algorithm,
      der(0x03, Buffer.from([0]), sign('sha256', body, options.signingKey)),
    ),
  );
}

export function createTestCertificates(
  options: { readonly expired?: boolean; readonly wrongHost?: boolean } = {},
): TestCertificates {
  const caKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leafKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = Date.now();
  const notBefore = new Date(now - 86_400_000);
  const notAfter = new Date(now + 86_400_000);
  const issuer = commonName('Ephemeral test CA');
  const ca = certificate({
    subject: issuer,
    issuer,
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    notBefore,
    notAfter,
    extensions: [
      extension('2.5.29.19', sequence(der(0x01, Buffer.from([0xff]))), true),
      extension('2.5.29.15', der(0x03, Buffer.from([1, 0x06])), true),
    ],
  });
  const names = options.wrongHost
    ? [der(0x82, Buffer.from('wrong.example.invalid'))]
    : [
        der(0x82, Buffer.from('echo.test')),
        der(0x82, Buffer.from('localhost')),
        der(0x87, Buffer.from([127, 0, 0, 1])),
        der(0x87, Buffer.from([...Array<number>(15).fill(0), 1])),
      ];
  const cert = certificate({
    subject: commonName(
      options.wrongHost ? 'wrong.example.invalid' : 'echo.test',
    ),
    issuer,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    notBefore: options.expired ? new Date(now - 3 * 86_400_000) : notBefore,
    notAfter: options.expired ? new Date(now - 2 * 86_400_000) : notAfter,
    extensions: [
      extension('2.5.29.19', sequence(), true),
      extension('2.5.29.15', der(0x03, Buffer.from([7, 0x80])), true),
      extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', sequence(...names)),
    ],
  });
  return {
    ca,
    cert,
    key: leafKeys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}
