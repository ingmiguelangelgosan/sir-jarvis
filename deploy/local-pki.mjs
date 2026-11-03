// Development PKI only. A fresh CA signs a 30-day Echo certificate; its signing
// key is never persisted. Regeneration requires a new private directory.
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function der(tag, ...parts) {
  const content = Buffer.concat(parts);
  const length = [];
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

const sequence = (...parts) => der(0x30, ...parts);
function oid(value) {
  const components = value.split('.').map(Number);
  const bytes = [components[0] * 40 + components[1]];
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

const name = (value) =>
  sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(value)))));
const time = (value) =>
  der(
    0x18,
    Buffer.from(
      value
        .toISOString()
        .replace(/[-:T]/g, '')
        .replace(/\.\d{3}Z$/, 'Z'),
    ),
  );
const extension = (id, value, critical = false) =>
  sequence(
    oid(id),
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    der(0x04, value),
  );
function pem(label, value) {
  const text = Buffer.from(value).toString('base64');
  return `-----BEGIN ${label}-----\n${text.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

function certificate(subject, issuer, publicKey, signer, extensions, now) {
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 1;
  const body = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    issuer,
    sequence(
      time(new Date(now - 60_000)),
      time(new Date(now + 30 * 86_400_000)),
    ),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(...extensions)),
  );
  return pem(
    'CERTIFICATE',
    sequence(
      body,
      algorithm,
      der(0x03, Buffer.from([0]), sign('sha256', body, signer)),
    ),
  );
}

export function createLocalCertificates() {
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const issuer = name('Sir Jarvis local demonstration CA');
  const now = Date.now();
  return {
    ca: certificate(
      issuer,
      issuer,
      ca.publicKey,
      ca.privateKey,
      [
        extension('2.5.29.19', sequence(der(0x01, Buffer.from([0xff]))), true),
        extension('2.5.29.15', der(0x03, Buffer.from([1, 0x06])), true),
      ],
      now,
    ),
    cert: certificate(
      name('echo'),
      issuer,
      leaf.publicKey,
      ca.privateKey,
      [
        extension('2.5.29.19', sequence(), true),
        extension('2.5.29.15', der(0x03, Buffer.from([7, 0x80])), true),
        extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1'))),
        extension('2.5.29.17', sequence(der(0x82, Buffer.from('echo')))),
      ],
      now,
    ),
    key: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
