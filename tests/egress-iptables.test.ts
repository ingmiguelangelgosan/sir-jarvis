import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { ruleTokens, sameRule, ruleRows } = await import(
  pathToFileURL(resolve('deploy/egress/iptables.mjs')).href
);

test('iptables quoted and unquoted comments produce the same argv rule', () => {
  const prefix = '-A INPUT -s 172.30.78.0/28 -m comment --comment ';
  assert.ok(
    sameRule(
      ruleTokens(`${prefix}"jarvis-1g-host-deny" -j DROP`),
      ruleTokens(`${prefix}jarvis-1g-host-deny -j DROP`),
    ),
  );
  assert.deepEqual(
    ruleRows('-P INPUT ACCEPT\n' + prefix + '"hello world" -j DROP'),
    [
      [
        '-A',
        'INPUT',
        '-s',
        '172.30.78.0/28',
        '-m',
        'comment',
        '--comment',
        'hello world',
        '-j',
        'DROP',
      ],
    ],
  );
});

test('iptables escapes are decoded as literal data without shell expansion', () => {
  const value =
    'quote " slash \\ apostrophe \' $HOME $(whoami) `whoami`; /32 -m tcp';
  const escaped = value.replace(/["\\']/g, (char) => `\\${char}`);
  assert.deepEqual(ruleTokens(`--comment "${escaped}"`), ['--comment', value]);
});

test('iptables preserves empty comments, quoted spaces and argument boundaries', () => {
  assert.deepEqual(ruleTokens('  --comment ""\t-j DROP  '), [
    '--comment',
    '',
    '-j',
    'DROP',
  ]);
  assert.deepEqual(ruleTokens('--comment "two  spaces"'), [
    '--comment',
    'two  spaces',
  ]);
  assert.equal(
    sameRule(ruleTokens('--comment "hello world"'), [
      '--comment',
      'hello',
      'world',
    ]),
    false,
  );
});

test('iptables rejects incomplete quoting, invalid escapes and control records', () => {
  for (const line of [
    '--comment "unfinished',
    '--comment "bad\\q"',
    '--comment trailing\\',
    '--comment "line\nbreak"',
    '-j DROP\r',
    '-j DROP\0',
  ]) {
    assert.throws(() => ruleTokens(line), /Egress operation failed/);
  }
  assert.throws(() => ruleTokens('a'.repeat(65537)));
});

test('iptables normalizes only address operands and the explicit tcp match module', () => {
  assert.ok(
    sameRule(
      ruleTokens(
        '-A TEST -s 172.30.78.2/32 -d 149.154.166.110/32 -p tcp -m tcp --dport 443 -j ACCEPT',
      ),
      ruleTokens(
        '-A TEST -s 172.30.78.2 -d 149.154.166.110 -p tcp --dport 443 -j ACCEPT',
      ),
    ),
  );
  assert.equal(
    sameRule(
      ruleTokens('-A TEST -s 172.30.78.0/28 -j DROP'),
      ruleTokens('-A TEST -s 172.30.78.0 -j DROP'),
    ),
    false,
  );
});

test('iptables normalization never rewrites values inside comments', () => {
  for (const [actual, wanted] of [
    ['literal/32', 'literal'],
    ['172.30.78.2/32', '172.30.78.2'],
    ['value -m tcp', 'value'],
    ['-p tcp', 'tcp'],
    ['-m', ''],
  ]) {
    const before = ['-A', 'INPUT', '-m', 'comment', '--comment'];
    assert.equal(
      sameRule(
        [...before, actual, '-j', 'DROP'],
        [...before, wanted, '-j', 'DROP'],
      ),
      false,
    );
  }
});

test('iptables checks reject extra matches, changed targets, protocols and operand boundaries', () => {
  const wanted = ruleTokens('-A OUTPUT -p tcp --dport 443 -j ACCEPT');
  for (const line of [
    '-A OUTPUT -p tcp --dport 80 -j ACCEPT',
    '-A OUTPUT -p udp --dport 443 -j ACCEPT',
    '-A OUTPUT -p tcp --dport 443 -j DROP',
    '-A OUTPUT -p tcp --dport 443 -m comment --comment extra -j ACCEPT',
    '-A OUTPUT -p tcp --dport 443 -j ACCEPT --unknown value',
    '-A OUTPUT -p tcp --dport "443 -j ACCEPT"',
  ])
    assert.equal(sameRule(ruleTokens(line), wanted), false);
});

test('iptables option-shaped comment values cannot grant protocol normalization', () => {
  assert.equal(
    sameRule(
      ['-A', 'INPUT', '--comment', '-p', '-m', 'tcp', '-j', 'DROP'],
      ['-A', 'INPUT', '--comment', '-p', '-j', 'DROP'],
    ),
    false,
  );
});
