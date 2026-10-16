// ============================================================================
//  make-cert.mjs —— 生成本机自签证书（体感转向的前置条件）
//
//  ★ 为什么需要：MDN 明确写「DeviceOrientationEvent 只在安全上下文（HTTPS）可用」。
//    手机访问 `http://192.168.x.x` 不是安全上下文，所以**安卓也需要 HTTPS**，
//    不是 iOS 专属。我们自己的开发服务器是明文 HTTP，所以要补一张证书。
//
//  ★ 为什么必须把 IP 签进 SAN：现代浏览器对"IP 地址 + 无 SAN"的证书**直接拒绝**，
//    连"继续访问（不安全）"的按钮都不给。所以证书里要列出你实际访问用的那些 IP。
//    换了网络（比如电脑连上手机热点）IP 会变 —— **重新跑一次这个脚本**。
//
//  用法： node tools/make-cert.mjs
//  产物： certs/cert.pem  certs/key.pem （已在 .gitignore 里，不进仓库）
// ============================================================================

import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'certs');

/** 收齐本机所有 IPv4（证书要把它们都签进去，换一个地址也不用重签）*/
const ips = ['127.0.0.1'];
const names = [];
for (const [name, list] of Object.entries(networkInterfaces())) {
  for (const ni of list || []) {
    if (ni.family !== 'IPv4') continue;
    ips.push(ni.address);
    names.push(`${ni.address} [${name}]`);
  }
}
const uniq = [...new Set(ips)];
const san = ['DNS:localhost', ...uniq.map((ip) => `IP:${ip}`)].join(',');

mkdirSync(OUT, { recursive: true });

console.log('正在生成自签证书…');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', resolve(OUT, 'key.pem'),
  '-out', resolve(OUT, 'cert.pem'),
  '-days', '3650',
  '-subj', '/CN=my-kart-dev',
  '-addext', `subjectAltName=${san}`,
], { stdio: ['ignore', 'ignore', 'inherit'] });

console.log('✓ 已生成 certs/cert.pem + certs/key.pem');
console.log('  证书覆盖这些地址（手机用其中任意一个都能过）:');
for (const n of ['127.0.0.1 [本机]', ...names]) console.log('    ' + n);
console.log('');
console.log('  手机第一次访问 https 时会警告"连接不私密" —— 选"高级 / 继续前往"即可（自签证书的正常提示）。');
