// A slow DNS server on loopback for scripts/test-card-pictures.sh (its /etc/resolv.conf, bound over the real one in the
// test's own mount namespace, names only this): every name under `.test` is 127.0.0.1 (an A query; any other type gets
// no records), answered after `delayMs`, as a busy resolver answers. Each query is a JSON line on stdout {name, type}.
// Usage: node fake-dns.mjs <delayMs>   (listens on 127.0.0.1:53: root of the test's network namespace)
import dgram from "node:dgram";

const DELAY = Number(process.argv[2] ?? 0);
const sock = dgram.createSocket("udp4");
sock.on("message", (q, from) => {
  // the question: labels from byte 12, then QTYPE
  let i = 12; const labels = [];
  while (i < q.length && q[i] !== 0) { labels.push(q.toString("latin1", i + 1, i + 1 + q[i])); i += q[i] + 1; }
  const qEnd = i + 5, type = q.readUInt16BE(i + 1), name = labels.join(".");
  process.stdout.write(JSON.stringify({ t: Date.now(), name, type }) + "\n");
  const ours = /\.test$/i.test(name), a = ours && type === 1;
  const head = Buffer.alloc(12);
  q.copy(head, 0, 0, 2);                         // the query's id
  head.writeUInt16BE(0x8180 | (ours ? 0 : 3), 2); // a response, recursion available; NXDOMAIN outside .test
  head.writeUInt16BE(1, 4);                      // one question
  head.writeUInt16BE(a ? 1 : 0, 6);              // one answer for an A query
  const parts = [head, q.subarray(12, qEnd)];
  if (a) parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1])); // name → 127.0.0.1, TTL 60 s
  setTimeout(() => sock.send(Buffer.concat(parts), from.port, from.address), DELAY);
});
sock.bind(53, "127.0.0.1", () => process.stdout.write(JSON.stringify({ ready: true }) + "\n"));
