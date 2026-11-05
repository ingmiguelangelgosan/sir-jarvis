import {
  SUBNET,
  CHAIN_HOST,
  CHAIN_NS4,
  CHAIN_NS6,
  SET_HOST,
  SET_NS,
  firewallRules,
  validatePolicy,
} from './policy.mjs';

const fail = () =>
  new Error(
    'Egress operation failed; keep Jarvis stopped and the subnet denied.',
  );

/** Decode iptables -S/save quoting into argv. Never execute or expand shell text. */
export function ruleTokens(line) {
  if (typeof line !== 'string' || line.length > 65536 || /[\0\r\n]/.test(line))
    throw fail();
  const result = [];
  let token = '',
    quoted = false,
    started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '\\') {
      const next = line[++index];
      // xtables escapes double quotes, backslashes and apostrophes in strings.
      if (!quoted || !['"', '\\', "'"].includes(next)) throw fail();
      token += next;
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (char === ' ' || char === '\t')) {
      if (started) result.push(token);
      token = '';
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quoted) throw fail();
  if (started) result.push(token);
  return result;
}

function normalized(tokens) {
  // Normalize only known option operands. Comment contents are opaque data,
  // including values that look like options or contain address suffixes.
  const arities = new Map([
    ['-A', 1],
    ['-s', 1],
    ['-d', 1],
    ['-p', 1],
    ['-m', 1],
    ['--comment', 1],
    ['-j', 1],
    ['--dport', 1],
    ['--match-set', 2],
  ]);
  const options = [];
  for (let index = 0; index < tokens.length;) {
    const option = tokens[index],
      arity = arities.get(option);
    // Unknown extensions are never silently discarded or reinterpreted.
    if (arity === undefined || index + arity >= tokens.length) return tokens;
    options.push([option, ...tokens.slice(index + 1, index + arity + 1)]);
    index += arity + 1;
  }
  const tcp = options.some(
    ([option, value]) => option === '-p' && value === 'tcp',
  );
  return options.flatMap(([option, ...values]) => {
    if (tcp && option === '-m' && values[0] === 'tcp') return [];
    if (['-s', '-d'].includes(option))
      values[0] = values[0].replace(/^(\d+\.\d+\.\d+\.\d+)\/32$/, '$1');
    return [option, ...values];
  });
}

export function sameRule(actual, expected) {
  const a = normalized(actual),
    b = normalized(expected);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

export function ruleRows(output) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('-A '))
    .map(ruleTokens);
}

/** Same production checks used by the host controller and real-kernel lab. */
export function createRuleManager({ ip, run, ns, assertIdentity }) {
  function uniqueFirst(chain, args) {
    const wanted = ['-A', chain, ...args];
    let rows = ruleRows(ip(['-S', chain]));
    if (!rows[0] || !sameRule(rows[0], wanted)) ip(['-I', chain, '1', ...args]);
    rows = ruleRows(ip(['-S', chain]));
    for (let index = rows.length - 1; index > 0; index--)
      if (sameRule(rows[index], wanted)) ip(['-D', chain, String(index + 1)]);
    const after = ruleRows(ip(['-S', chain]));
    if (
      !after[0] ||
      !sameRule(after[0], wanted) ||
      after.filter((row) => sameRule(row, wanted)).length !== 1
    )
      throw fail();
  }

  function assertPrivateRules(save, table, chain, expected) {
    const section = save.split(`*${table}\n`)[1]?.split('COMMIT')[0];
    if (!section) throw fail();
    const inChain = (output) =>
      ruleRows(output).filter((row) => row[1] === chain);
    const lines = inChain(section),
      planned = inChain(expected);
    if (
      lines.length !== planned.length ||
      !lines.every((line, index) => sameRule(line, planned[index]))
    )
      throw fail();
  }

  function assertRules(policy, id, identity) {
    validatePolicy(policy);
    assertIdentity(id, identity);
    const rules = firewallRules(policy.addresses);
    const first = ruleRows(ip(['-S', 'DOCKER-USER']))[0];
    if (
      !first ||
      !sameRule(first, ['-A', 'DOCKER-USER', '-s', SUBNET, '-j', CHAIN_HOST])
    )
      throw fail();
    const inputFirst = ruleRows(ip(['-S', 'INPUT']))[0];
    if (
      !inputFirst ||
      !sameRule(inputFirst, [
        '-A',
        'INPUT',
        '-s',
        SUBNET,
        '-m',
        'comment',
        '--comment',
        'jarvis-1g-host-deny',
        '-j',
        'DROP',
      ])
    )
      throw fail();
    assertPrivateRules(run('save'), 'filter', CHAIN_HOST, rules.host);
    assertPrivateRules(
      ns(identity.pid, 'save'),
      'raw',
      CHAIN_NS4,
      rules.namespace4,
    );
    assertPrivateRules(
      ns(identity.pid, 'save6'),
      'raw',
      CHAIN_NS6,
      rules.namespace6,
    );
    for (const [p, name] of [
      [undefined, SET_HOST],
      [identity.pid, SET_NS],
    ]) {
      const saved = p
        ? ns(p, 'ipset', ['save', name])
        : run('ipset', ['save', name]);
      const rows = saved.split('\n').filter((line) => line.startsWith('add '));
      if (rows.length !== policy.addresses.length) throw fail();
      const found = [];
      for (const row of rows) {
        const match = new RegExp(
          `^add ${name} ([0-9.]+) timeout ([0-9]+)$`,
        ).exec(row);
        if (
          !match ||
          !policy.addresses.includes(match[1]) ||
          Number(match[2]) < 1 ||
          Number(match[2]) > Math.ceil((policy.expiresAt - Date.now()) / 1000)
        )
          throw fail();
        found.push(match[1]);
      }
      if (found.sort().join(',') !== [...policy.addresses].sort().join(','))
        throw fail();
      for (const address of policy.addresses) {
        if (p) ns(p, 'ipset', ['test', name, address]);
        else run('ipset', ['test', name, address]);
      }
    }
    for (const [tool, chain] of [
      ['iptables', CHAIN_NS4],
      ['ip6tables', CHAIN_NS6],
    ]) {
      const output = ruleRows(
        ns(identity.pid, tool, ['-t', 'raw', '-S', 'OUTPUT']),
      )[0];
      if (!output || !sameRule(output, ['-A', 'OUTPUT', '-j', chain]))
        throw fail();
    }
  }
  return { uniqueFirst, assertRules };
}
