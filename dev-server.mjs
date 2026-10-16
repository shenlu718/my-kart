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
};


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

  // 2. 访问根目录就给 index.html
  if (urlPath === '/') urlPath = '/index.html';

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


server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  ✓ 游戏已启动');
  console.log(`    地址：${url}`);
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
