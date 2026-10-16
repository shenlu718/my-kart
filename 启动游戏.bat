@echo off
chcp 65001 >nul
cd /d "%~dp0"
title my-kart 开发服务器

echo.
echo   ============================================
echo      my-kart 开发服务器
echo   ============================================
echo.
echo   即将启动，浏览器会自动打开游戏页面。
echo.
echo   要停止服务：直接关掉这个黑窗口，或按 Ctrl + C
echo.

node dev-server.mjs

echo.
echo   服务器已停止。
echo.
pause
