"""Real kernel tests, only inside an isolated Linux container.

The production rule generator is copied into this test image. Public-looking IPs
are bound to loopback inside a private test namespace: no Telegram request is sent.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

APPROVED = '149.154.166.110'
NEGATIVE = '1.1.1.1'
METADATA = '169.254.169.254'
LINKLOCAL = '169.254.1.1'
SOURCE = '172.30.78.2'
SUBNET = '172.30.78.0/28'
NAMESPACES = ['bot', 'peer', 'outside']
stage = 'initialization'
processes = []
results = []


def run(args, *, data=None, namespace=None, required=True, timeout=8):
    if namespace:
        args = ['ip', 'netns', 'exec', namespace] + args
    result = subprocess.run(args, input=data, capture_output=True, text=True,
                            timeout=timeout, check=False)
    if required and result.returncode != 0:
        raise RuntimeError('kernel command failed at ' + stage)
    return result


def ok(name):
    results.append(name)


def restore(text, namespace=None, ipv6=False):
    run(['ip6tables-restore' if ipv6 else 'iptables-restore', '--noflush', '--wait', '2'],
        data=text, namespace=namespace)


def create_set(name, namespace=None, ttl=60):
    run(['ipset', 'create', name, 'hash:ip', 'family', 'inet', 'hashsize', '64',
         'maxelem', '16', 'timeout', '60', '-exist'], namespace=namespace)
    run(['ipset', 'flush', name], namespace=namespace)
    run(['ipset', 'add', name, APPROVED, 'timeout', str(ttl)], namespace=namespace)


def curl(address=APPROVED, namespace='bot', positive=True, port=443):
    destination = '[' + address + ']' if ':' in address else address
    result = run(['curl', '--noproxy', '*', '--silent', '--show-error', '--fail',
                  '--cacert', str(directory / 'cert.pem'), '--connect-timeout', '1',
                  '--max-time', '2', '--resolve',
                  'api.telegram.org:' + str(port) + ':' + destination,
                  'https://api.telegram.org:' + str(port) + '/'],
                 namespace=namespace, required=False, timeout=4)
    if positive:
        assert result.returncode == 0 and result.stdout == 'local-kernel-test-ok'
    else:
        assert result.returncode != 0


def veth(namespace, root_if, child_if, root_ip, child_ip, prefix, gateway):
    run(['ip', 'link', 'add', root_if, 'type', 'veth', 'peer', 'name', child_if])
    run(['ip', 'link', 'set', child_if, 'netns', namespace])
    run(['ip', 'addr', 'add', root_ip + '/' + str(prefix), 'dev', root_if])
    run(['ip', 'link', 'set', root_if, 'up'])
    run(['ip', '-n', namespace, 'addr', 'add', child_ip + '/' + str(prefix), 'dev', child_if])
    run(['ip', '-n', namespace, 'link', 'set', child_if, 'up'])
    run(['ip', '-n', namespace, 'route', 'add', 'default', 'via', gateway])


def start_server(namespace, address, ipv6=False, port=443):
    code = """
import http.server, socket, ssl, sys
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def do_GET(self):
  body=b'local-kernel-test-ok';self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
class Server(http.server.ThreadingHTTPServer):
 address_family=socket.AF_INET6 if sys.argv[4]=='v6' else socket.AF_INET
server=Server((sys.argv[1],int(sys.argv[5])),Handler)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(sys.argv[2],sys.argv[3]);server.socket=context.wrap_socket(server.socket,server_side=True)
server.serve_forever()
"""
    child = subprocess.Popen(['ip', 'netns', 'exec', namespace, 'python3', '-c', code,
                              address, str(directory / 'cert.pem'), str(directory / 'key.pem'),
                              'v6' if ipv6 else 'v4', str(port)], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    processes.append(child)


def established_connection_expires():
    code = """
import http.client,socket,ssl,sys,time
context=ssl.create_default_context(cafile=sys.argv[1])
tls=context.wrap_socket(socket.create_connection(('149.154.166.110',443),timeout=1),server_hostname='api.telegram.org')
connection=http.client.HTTPConnection('api.telegram.org',443,timeout=1);connection.sock=tls
connection.request('GET','/');response=connection.getresponse();assert response.status==200;assert response.read()==b'local-kernel-test-ok';assert not response.will_close
time.sleep(3)
try:
 connection.request('GET','/');response=connection.getresponse();response.read()
except (TimeoutError,socket.timeout,OSError):
 print('existing-connection-expired');sys.exit(0)
sys.exit(2)
"""
    result = run(['python3', '-c', code, str(directory / 'cert.pem')],
                 namespace='bot', timeout=8)
    assert result.stdout.strip() == 'existing-connection-expired'


try:
    assert os.geteuid() == 0
    started = time.monotonic()
    # The generator is the same file used by the operator, not a copied policy.
    stage = 'production-rule-generation'
    policy = json.loads(run(['node', '/lab/policy.mjs', 'rules', APPROVED]).stdout)
    host_set = policy.get('sets', {}).get('host', 'JRV1G_TG4')
    namespace_set = policy.get('sets', {}).get('namespace', 'JRV1G_NS_TG4')
    assert all(isinstance(policy[name], str) for name in ['host', 'namespace4', 'namespace6'])
    assert 'nf_tables' in run(['iptables', '--version']).stdout
    stage = 'production-rule-comparison-regression'
    regression = json.loads(run(['node', '/lab/rule-regression.mjs'], timeout=45).stdout)
    assert regression['status'] == 'passed-real-rule-regression'
    assert regression['realIptablesCommands'] and not regression['jarvisStarted']
    results.extend(regression['scenarios'])
    directory = pathlib.Path(tempfile.mkdtemp(prefix='jarvis-kernel-', dir='/tmp'))
    stage = 'ephemeral-tls'
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
         '-keyout', str(directory / 'key.pem'), '-out', str(directory / 'cert.pem'),
         '-days', '1', '-subj', '/CN=api.telegram.org', '-addext',
         'subjectAltName=DNS:api.telegram.org'], timeout=15)
    stage = 'private-topology'
    for namespace in NAMESPACES:
        run(['ip', 'netns', 'add', namespace])
        run(['ip', '-n', namespace, 'link', 'set', 'lo', 'up'])
    veth('bot', 'router-bot', 'bot0', '172.30.78.1', SOURCE, 28, '172.30.78.1')
    veth('peer', 'router-peer', 'peer0', '192.0.2.1', '192.0.2.2', 30, '192.0.2.1')
    veth('outside', 'router-other', 'other0', '172.30.79.1', '172.30.79.2', 28, '172.30.79.1')
    for address in [APPROVED, NEGATIVE, METADATA, LINKLOCAL]:
        run(['ip', '-n', 'peer', 'addr', 'add', address + '/32', 'dev', 'lo'])
        run(['ip', 'route', 'add', address + '/32', 'via', '192.0.2.2'])
    run(['sysctl', '-q', '-w', 'net.ipv4.ip_forward=1'])
    start_server('peer', '0.0.0.0')
    start_server('peer', '0.0.0.0', port=80)
    start_server('bot', '::1', True)
    time.sleep(0.3)
    stage = 'baseline-approved-https'; curl()
    stage = 'baseline-negative-https'; curl(NEGATIVE)
    stage = 'baseline-metadata-https'; curl(METADATA)
    stage = 'baseline-linklocal-https'; curl(LINKLOCAL)
    stage = 'baseline-other-port-https'; curl(port=80)
    stage = 'baseline-ipv6-https'; curl('::1')
    ok('local-tls-baseline-with-verified-ca-and-hostname')
    # These are test namespace chains, not any chains from the Docker host.
    run(['iptables', '-N', 'DOCKER-USER'])
    run(['iptables', '-I', 'FORWARD', '1', '-j', 'DOCKER-USER'])
    run(['iptables', '-A', 'DOCKER-USER', '-s', SUBNET, '-j', 'DROP'])
    run(['iptables', '-N', 'ufw-before-input'])
    run(['iptables', '-A', 'INPUT', '-p', 'tcp', '--dport', '22', '-j', 'ACCEPT'])
    run(['iptables', '-A', 'INPUT', '-j', 'ufw-before-input'])
    original_input = run(['iptables', '-S', 'INPUT']).stdout
    original_ufw = run(['iptables', '-S', 'ufw-before-input']).stdout
    stage = 'legacy-deny'
    curl(positive=False)
    ok('existing-scoped-drop-blocks-before-new-policy')
    stage = 'host-policy'
    create_set(host_set)
    restore(policy['host'])
    run(['iptables', '-I', 'DOCKER-USER', '1', '-s', SUBNET, '-j', 'JRV1G_EGRESS'])
    curl(); curl(NEGATIVE, positive=False); curl(METADATA, positive=False)
    curl(LINKLOCAL, positive=False); curl(port=80, positive=False)
    curl(namespace='outside')
    assert run(['iptables', '-S', 'INPUT']).stdout == original_input
    assert run(['iptables', '-S', 'ufw-before-input']).stdout == original_ufw
    ok('host-only-approved-https-with-metadata-and-unapproved-drops')
    ok('outside-subnet-and-ssh-ufw-input-chains-unchanged')
    stage = 'source-address-policy'
    run(['ip', '-n', 'bot', 'addr', 'del', SOURCE + '/28', 'dev', 'bot0'])
    run(['ip', '-n', 'bot', 'addr', 'add', '172.30.78.3/28', 'dev', 'bot0'])
    run(['ip', '-n', 'bot', 'route', 'replace', 'default', 'via', '172.30.78.1'])
    curl(positive=False)
    run(['ip', '-n', 'bot', 'addr', 'del', '172.30.78.3/28', 'dev', 'bot0'])
    run(['ip', '-n', 'bot', 'addr', 'add', SOURCE + '/28', 'dev', 'bot0'])
    run(['ip', '-n', 'bot', 'route', 'replace', 'default', 'via', '172.30.78.1'])
    ok('other-pilot-source-address-cannot-use-allowlist')
    stage = 'namespace-policy'
    create_set(namespace_set, 'bot')
    restore(policy['namespace4'], 'bot')
    restore(policy['namespace6'], 'bot', True)
    run(['iptables', '-t', 'raw', '-I', 'OUTPUT', '1', '-j', 'JRV1G_NS4'], namespace='bot')
    run(['ip6tables', '-t', 'raw', '-I', 'OUTPUT', '1', '-j', 'JRV1G_NS6'], namespace='bot')
    curl(); curl(NEGATIVE, positive=False); curl('::1', positive=False)
    ok('raw-output-allows-only-approved-https-and-denies-ipv6')
    stage = 'idempotent-private-chain-reload'
    for _ in range(3):
        restore(policy['host']); restore(policy['namespace4'], 'bot')
        restore(policy['namespace6'], 'bot', True)
    curl()
    assert run(['iptables', '-S', 'INPUT']).stdout == original_input
    assert run(['iptables', '-S', 'ufw-before-input']).stdout == original_ufw
    ok('repeated-private-chain-reload-preserves-global-chains')
    stage = 'kernel-timeout-expiration'
    create_set(host_set, ttl=2)
    create_set(namespace_set, 'bot')
    established_connection_expires()
    curl(positive=False)
    ok('host-ipset-timeout-revokes-established-https-without-watchdog')
    create_set(host_set)
    create_set(namespace_set, 'bot', ttl=2)
    established_connection_expires()
    curl(positive=False)
    ok('namespace-ipset-timeout-revokes-established-https-without-watchdog')
    stage = 'closed-reload-after-expiration'
    restore(policy['host']); restore(policy['namespace4'], 'bot')
    curl(positive=False)
    create_set(host_set)
    create_set(namespace_set, 'bot')
    curl()
    ok('reload-does-not-refill-expired-addresses-unless-explicitly-approved')
    # Docker's embedded resolver is exercised in this container's own namespace,
    # backed only by a local DNS fixture on an internal Docker network.
    stage = 'docker-dns-baseline'
    dns = os.environ.get('LAB_DNS_IP')
    assert dns and pathlib.Path('/etc/resolv.conf').read_text().find('127.0.0.11') >= 0
    baseline = run(['dig', '+short', '+time=1', '+tries=1', '@127.0.0.11',
                    'allow.lab.invalid', 'A'])
    assert baseline.stdout.strip() == APPROVED
    stage = 'docker-dns-raw-guard'
    create_set(namespace_set)
    restore(policy['namespace4'])
    run(['iptables', '-t', 'raw', '-I', 'OUTPUT', '1', '-j', 'JRV1G_NS4'])
    for destination, protocol in [('127.0.0.11', []), ('127.0.0.11', ['+tcp']),
                                   (dns, []), (dns, ['+tcp'])]:
        result = run(['dig', '+short', '+time=1', '+tries=1', '@' + destination,
                      'blocked.lab.invalid', 'A'] + protocol, required=False, timeout=3)
        assert result.returncode != 0 and APPROVED not in result.stdout
    ok('embedded-and-direct-dns-udp-tcp-blocked-before-docker-forwarding')
    print(json.dumps({'status': 'passed-isolated-linux-kernel', 'scenarios': results,
                      'ruleRegression': {key: regression[key] for key in [
                          'realDenyExecutions', 'kernelHostCommentQuoted',
                          'kernelEscapedCommentQuoted', 'dockerIdentityAdapter']},
                      'iptables': run(['iptables', '--version']).stdout.strip(),
                      'node': run(['node', '--version']).stdout.strip(),
                      'systemd': run(['systemd-analyze', '--version']).stdout.splitlines()[0],
                      'kernelRelease': os.uname().release,
                      'durationMs': round((time.monotonic() - started) * 1000),
                      'awsCalls': 0, 'publicHttpsCalls': 0,
                      'hostFirewallChanged': False, 'realHostRebootTested': False}), flush=True)
except Exception:
    print('Isolated egress kernel lab failed at ' + stage + '.', file=sys.stderr, flush=True)
    sys.exitCode = 1
finally:
    for child in processes:
        child.terminate()
    for namespace in NAMESPACES:
        run(['ip', 'netns', 'delete', namespace], required=False)
    if hasattr(sys, 'exitCode'):
        sys.exit(sys.exitCode)
