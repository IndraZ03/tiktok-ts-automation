@echo off
echo Menghentikan proses di port 5000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do (
    echo Menghentikan PID: %%a
    taskkill /f /pid %%a
)
echo Selesai.
pause
