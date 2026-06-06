@echo off
ping 127.0.0.1 -n 3 > nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do (
    taskkill /f /pid %%a
)
wscript.exe "%~dp0start.vbs"
