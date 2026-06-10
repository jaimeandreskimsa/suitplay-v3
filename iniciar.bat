@echo off
rem SuitPlay Pro - arranque del servidor
rem Requiere Node.js 22+. Puerto por defecto: 8080 (set PORT=80 para cambiarlo)
cd /d "%~dp0"
echo Iniciando SuitPlay Pro en http://localhost:%PORT%...
node --experimental-sqlite server.js
pause
