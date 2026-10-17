@echo off
setlocal
call npm --prefix "%~dp0apps\web-profile" run start:local
if errorlevel 1 pause
