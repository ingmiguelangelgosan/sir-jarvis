"""Local test-only DNS endpoint. No recursive lookup and no public network calls."""
import json
import socketserver
import struct
import threading
from pathlib import Path

counter = 0
lock = threading.Lock()


def reply(message):
    global counter
    with lock:
        counter += 1
        Path('/tmp/dns-count').write_text(str(counter), encoding='ascii')
    if len(message) < 12:
        return b''
    offset = 12
    while offset < len(message) and message[offset] != 0:
        offset += message[offset] + 1
    offset += 5
    if offset > len(message):
        return b''
    question = message[12:offset]
    # One fixed local answer; never forward or resolve a supplied hostname.
    return (message[:2] + struct.pack('!HHHHH', 0x8180, 1, 1, 0, 0)
            + question + b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 60, 4)
            + bytes([149, 154, 166, 110]))


class UDP(socketserver.BaseRequestHandler):
    def handle(self):
        message, sock = self.request
        sock.sendto(reply(message), self.client_address)


class TCP(socketserver.BaseRequestHandler):
    def handle(self):
        header = self.request.recv(2)
        if len(header) != 2:
            return
        expected = struct.unpack('!H', header)[0]
        message = b''
        while len(message) < expected:
            chunk = self.request.recv(expected - len(message))
            if not chunk:
                return
            message += chunk
        response = reply(message)
        self.request.sendall(struct.pack('!H', len(response)) + response)


Path('/tmp/dns-count').write_text('0', encoding='ascii')
udp = socketserver.ThreadingUDPServer(('0.0.0.0', 53), UDP)
tcp = socketserver.ThreadingTCPServer(('0.0.0.0', 53), TCP)
threading.Thread(target=udp.serve_forever, daemon=True).start()
print(json.dumps({'status': 'local-dns-fixture-ready'}), flush=True)
tcp.serve_forever()
