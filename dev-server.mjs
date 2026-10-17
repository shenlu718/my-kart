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
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { exec } from 'node:child_process';
import { networkInterfaces } from 'node:os';
// 复用游戏侧同一份「新鲜度」判定：给新连上的游戏页推首帧时必须过一遍，
// 否则手机锁屏后服务器留着的 forward:1 会让刚刷新的游戏页以为油门按着。
import { freshSnapshotOrZero } from './src/remote-input.js';

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

// 诊断日志：手机到底取没取到"新页面/新模块"、到底有没有按下键。
// 心跳是 60ms 一次（一秒 16 次），所以只记「第一次」和「非零输入」，不然会刷屏。
let sawFirstInputPost = false;
let lastNonZeroLogAt = 0;

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
      // 会话 id 也透传：手机页刷新后 seq 会从 0 重来，游戏侧靠 sid 认出"这是新会话"，
      // 否则新包会被当成过期包全部丢掉 —— 表现就是"刷新一次页面，手柄永久失灵"。
      const sid = typeof (msg && msg.sid) === 'string' && msg.sid.length <= 64 ? msg.sid : undefined;
      remoteInput = { forward: num(msg && msg.forward), turn: num(msg && msg.turn), seq, sid, at: Date.now() };

      if (!sawFirstInputPost) {
        sawFirstInputPost = true;
        console.log('  ✓ 收到手机的第一条输入（说明手柄页在跑）');
      }
      if ((remoteInput.forward !== 0 || remoteInput.turn !== 0) &&
          Date.now() - lastNonZeroLogAt > 1000) {
        lastNonZeroLogAt = Date.now();
        console.log(`  ← 手机按键：油门 ${remoteInput.forward}  转向 ${remoteInput.turn}`);
      }
      broadcastInput();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
    return;
  }

  // 2c. 给游戏页面自报"手机该打开哪个地址"
  // ★ 为什么（用户反复卡在这里）：手机热点的 IP 每次切换网络都会变，
  //   而地址只打在服务器控制台上 —— 用户看不到控制台（它是后台进程），
  //   于是每次都问"地址是多少"。让游戏页面自己显示，就不用问了。
  if (urlPath === '/api/info') {
    const lan = lanAddresses()[0];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      phoneUrl: lan ? `http://${lan.address}:${PORT}/phone/` : '',
      phoneUrlHttps: lan ? `https://${lan.address}:8443/phone/` : '',
    }));
    return;
  }

  if (urlPath === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });
    // ★ 首帧只给「还新鲜」的快照：手机锁屏/划掉后服务器会一直留着 forward:1，
    //   直接推给刚刷新的游戏页会让车自己往前冲最多 800ms（复现：按住油门 → 飞行模式 → 刷新游戏页）。
    res.write(`data: ${JSON.stringify(freshSnapshotOrZero(remoteInput, Date.now()))}\n\n`);
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
  //    诊断：手机上"是不是真的重新加载了"看这一行 —— 只有真正刷新才会取到新模块
  if (urlPath.startsWith('/phone/') || urlPath === '/src/pad-input.js') {
    console.log(`  ← 取文件：${urlPath}`);
  }
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

// ---------------------------------------------------------------------------
//  追加一个 HTTPS 监听（体感转向需要「安全上下文」）
//
//  MDN：DeviceOrientationEvent 只在安全上下文（HTTPS）可用 —— 安卓也一样，
//  不是 iOS 专属。所以 http://192.168.x.x 上体感是拿不到数据的，必须 https。
//
//  这里**复用上面那个 request 监听器**，不复制一份逻辑（复制迟早两边跑偏）。
//  证书没有就静默跳过：不影响现在能玩的 HTTP 那条路。
// ---------------------------------------------------------------------------
const CERT = resolve(ROOT, 'certs', 'cert.pem');
const KEY = resolve(ROOT, 'certs', 'key.pem');
const HTTPS_PORT = 8443;
if (existsSync(CERT) && existsSync(KEY)) {
  const requestHandler = server.listeners('request')[0];
  https.createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, requestHandler)
    .listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log('');
      console.log(`  🔒 HTTPS 已开（体感转向要用这个）：端口 ${HTTPS_PORT}`);
      console.log('     手机第一次会警告"连接不私密" → 选「高级 → 继续前往」');
    });
}


/**
 * 打开游戏页面。
 *
 * ★ 用户诉求：「网页一堆地址栏、广告、提示，太繁琐」。
 *   成本最低的一步：用 Chrome / Edge 的**应用窗口**（--app=）打开 ——
 *   没有地址栏、没有书签栏、没有标签页，看起来就是一个独立软件。
 *   找不到这两个浏览器再退回系统默认（行为和以前一样）。
 *   这是桌面端对应的做法；手机端对应 PWA（phone\manifest.json）。
 */
const APP_WINDOW_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 用系统默认浏览器打开网址 */
function openBrowser(url) {
  if (process.platform === 'win32') {
    const exe = APP_WINDOW_BROWSERS.find((p) => existsSync(p));
    if (exe) {
      exec(`"${exe}" --app=${url} --window-size=1280,800`);
      return;
    }
    exec(`start "" ${url}`);
    return;
  }
  if (process.platform === 'darwin') { exec(`open ${url}`); return; }
  exec(`xdg-open ${url}`);
}


/** 打印一遍手机手柄的可用地址（地址没变就不重复打印） */
let lastLanKey = '';
function printLanAddresses(force = false) {
  const lan = lanAddresses();
  const key = lan.map((e) => e.address).join(',');
  if (!force && key === lastLanKey) return;
  lastLanKey = key;
  if (!lan.length) return;
  console.log('');
  console.log('  📱 手机手柄（手机不用装任何东西，浏览器直接开）：');
  for (const entry of lan) {
    const mark = entry === lan[0] ? '→' : ' ';
    console.log(`   ${mark} http://${entry.address}:${PORT}/phone/`);
    console.log(`       ${entry.hint}   [网卡 ${entry.name}]`);
  }
  console.log('     ★ 校园网 / 公司网常有「设备互相隔离」，手机够不到电脑。');
  console.log('       那种情况下【手机开热点 → 电脑连上它】，这里会自动出现新地址。');
}

// 网络一变（比如电脑连上了手机热点）就自动重印地址 —— 不用重启服务器
setInterval(() => printLanAddresses(), 3000);

// 绑 0.0.0.0 而不是 127.0.0.1：手机要能从局域网连进来 —— 这就是做手柄的前提。
// 代价：同一个 WiFi 下的其他设备也能访问这个开发服务器（它只服务本项目的文件、
// 没有隐私数据，但你应该知道这件事）。不想要就把这行改回 '127.0.0.1'。
server.listen(PORT, '0.0.0.0', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  ✓ 游戏已启动');
  console.log(`    地址：${url}`);
  printLanAddresses(true);
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
