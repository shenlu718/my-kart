// ============================================================================
//  dev-server.mjs —— 专门给这个项目用的开发服务器
//
//  为什么不直接用 `python -m http.server`？三个它不解决的问题：
//
//  1. 缓存坑（最重要）
//     它只发 Last-Modified、不发 Cache-Control，浏览器就自己猜一个缓存期
//     （文件多久没变，就缓存它 10% 的时间）。结果就是：你改了代码，
//     浏览器却拿几十小时前的旧文件来跑，你看到的是旧画面。
//     这个服务器明确发 `no-store`：每次都问我要最新的。
//
//  2. 不会自动开浏览器
//     每次都要自己去地址栏输网址。这个服务器启动后自动帮你打开。
//
//  3. MIME 类型靠猜
//     .mjs / .js 这类文件如果类型发错，浏览器会拒绝执行（type="module"
//     的脚本对 MIME 很挑剔）。这里显式列出来。
//
//  启动：双击同目录下的「启动游戏.bat」，或在这个目录里执行
//        node dev-server.mjs
// ============================================================================

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { exec } from 'node:child_process';
import { networkInterfaces } from 'node:os';

/** 项目根目录 = 本文件所在目录 */
const ROOT = resolve(import.meta.dirname);

/** 端口。如果 8000 被占用，改这里就行 */
const PORT = 8000;

/** 浏览器靠它决定怎么处理文件；发错了就会不执行或者变成下载 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};


// ---------------------------------------------------------------------------
//  手机手柄的输入通道（零依赖）
//
//      手机页 --POST /api/input--> 这里 --SSE /api/stream--> 游戏页
//
//  为什么 POST 而不是 WebSocket：不需要任何依赖、不需要证书，
//  调试时用浏览器就能看到请求。输入只有"油门/转向"两个数，够用。
//  为什么 SSE 而不是 WebSocket 推回去：我们只需要**单向**推"当前输入"，
//  SSE 是纯 HTTP，服务端零依赖，方向刚好对。
//
//  ★ 超时判定在游戏侧（src/remote-input.js，有测试）：手机切后台/锁屏时
//    不保证发出"松手"，靠心跳 + 超时把车停下来。
// ---------------------------------------------------------------------------
let remoteInput = { forward: 0, turn: 0, at: 0 };
const sseClients = new Set();

function broadcastInput() {
  const line = `data: ${JSON.stringify(remoteInput)}\n\n`;
  for (const client of sseClients) {
    try { client.write(line); } catch { sseClients.delete(client); }
  }
}

/**
 * 列出本机所有局域网 IPv4 地址，并**按用途标注**。
 *
 * 为什么要挑（实测踩到三次）：
 *   ① Tailscale 的 100.64/10 段 —— 手机不装 Tailscale 就连不上；
 *   ② Windows「移动热点 / Internet 连接共享」是 192.168.137.1 的虚拟网卡 ——
 *      但它**恰恰是校园网下最靠谱的入口**（手机连电脑热点时用这个）；
 *   ③ 校园网普遍做设备隔离，普通 WiFi 地址（本例 10.2.11.122）手机往往够不到。
 * 所以不"挑一个"，而是**全列出来、各自标清楚什么时候用哪个**。
 */
function lanAddresses() {
  const VIRTUAL = /tailscale|vethernet|vmware|virtualbox|hyper-?v|loopback|bluetooth|zerotier|docker|wsl/i;
  const WIRELESS = /wlan|wi-?fi|wireless|无线|wlp|en0/i;
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const isHotspot = ni.address.startsWith('192.168.137.');
      const isTailscale = ni.address.startsWith('100.') && Number(ni.address.split('.')[1]) >= 64;
      const [a, b] = ni.address.split('.').map(Number);
      const isPrivate =
        (a === 192 && b === 168) || a === 10 || (a === 172 && b >= 16 && b <= 31);
      let score = 2;
      if (isPrivate && !isHotspot) score = 1;                 // 普通私网地址
      if (WIRELESS.test(name) && !VIRTUAL.test(name)) score = 0; // 真无线网卡优先展示
      if (isHotspot) score = 2;                               // 热点地址要单独说明用法
      if (VIRTUAL.test(name) || isTailscale) score = 4;       // 虚拟网卡排最后
      found.push({
        address: ni.address,
        name,
        score,
        hint: isHotspot ? '手机连「本机热点」时用这个'
          : isTailscale ? '手机也装了 Tailscale 时用这个'
          : '手机和电脑在同一个 WiFi 时用这个',
      });
    }
  }
  return found.sort((x, y) => x.score - y.score);
}


const server = http.createServer(async (req, res) => {
  // 1. 解析请求的路径
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('网址格式不对');
    return;
  }

  // 2. 访问根目录就给 index.html；目录也给它的 index.html（比如手机手柄页 /phone/）
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // 2b. 手机手柄 API（放在文件服务之前，别被当成文件路径）
  if (urlPath === '/api/input' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();     // 别让畸形请求吃内存
    });
    req.on('end', () => {
      let msg = null;
      try { msg = JSON.parse(body); } catch { msg = null; }
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
      };
      // 序号原样透传（游戏侧用它丢弃乱序/重复的包）。没带就不放这个字段。
      const seq = Number.isSafeInteger(msg && msg.seq) && msg.seq >= 0 ? msg.seq : undefined;
      remoteInput = { forward: num(msg && msg.forward), turn: num(msg && msg.turn), seq, at: Date.now() };
      broadcastInput();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
    return;
  }

  if (urlPath === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(remoteInput)}\n\n`);   // 连上先给当前值
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // 3. 安全检查：把路径限制在本项目里，防止 ../../ 读到项目外的文件
  const filePath = resolve(join(ROOT, normalize(urlPath)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('不许访问项目目录之外的文件');
    return;
  }

  // 4. 读文件并返回
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      // ★ 整个文件存在的理由就是下面这一行 ★
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 找不到这个文件：${urlPath}\n\n检查一下文件名有没有拼错。`);
  }
});


/** 用系统默认浏览器打开网址 */
function openBrowser(url) {
  if (process.platform === 'win32') exec(`start "" ${url}`);
  else if (process.platform === 'darwin') exec(`open ${url}`);
  else exec(`xdg-open ${url}`);
}


// 绑 0.0.0.0 而不是 127.0.0.1：手机要能从局域网连进来 —— 这就是做手柄的前提。
// 代价：同一个 WiFi 下的其他设备也能访问这个开发服务器（它只服务本项目的文件、
// 没有隐私数据，但你应该知道这件事）。不想要就把这行改回 '127.0.0.1'。
server.listen(PORT, '0.0.0.0', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  ✓ 游戏已启动');
  console.log(`    地址：${url}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('');
    console.log('  📱 手机手柄（手机不用装任何东西，浏览器直接开）：');
    for (const entry of lan) {
      const mark = entry === lan[0] ? '→' : ' ';
      console.log(`   ${mark} http://${entry.address}:${PORT}/phone/`);
      console.log(`       ${entry.hint}   [网卡 ${entry.name}]`);
    }
    console.log('     ★ 校园网 / 公司网常有「设备互相隔离」，手机够不到电脑。');
    console.log('       那种情况下开电脑的「移动热点」，让手机连它，用上面带「本机热点」的地址。');
  }
  console.log('    浏览器应该已经自动打开了');
  console.log('');
  console.log('  停止服务：直接关掉这个窗口，或者按 Ctrl + C');
  console.log('');
  openBrowser(url);
});


server.on('error', (err) => {
  console.error('');
  if (err.code === 'EADDRINUSE') {
    console.error(`  ✗ 端口 ${PORT} 已经被占用了。`);
    console.error('');
    console.error('    多半是你已经开着一个服务器了（比如上一次的窗口没关）。');
    console.error('    把那个窗口关掉，再双击一次本脚本。');
    console.error('');
    console.error('    要查是谁占用的，在终端里执行：');
    console.error(`      netstat -ano | findstr :${PORT}`);
  } else {
    console.error('  ✗ 启动失败：' + err.message);
  }
  console.error('');
  process.exit(1);
});
