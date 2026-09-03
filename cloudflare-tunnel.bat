@echo off
setlocal

set "CF_SERVICE=Cloudflared"
set "CF_ACTION=%~1"
if not defined CF_ACTION set "CF_ACTION=start"

sc.exe query "%CF_SERVICE%" >nul 2>&1
if errorlevel 1 (
    echo [Cloudflare] Service "%CF_SERVICE%" tidak ditemukan.
    echo [Cloudflare] Web tetap akan dijalankan tanpa mengubah tunnel.
    exit /b 0
)

if /i "%CF_ACTION%"=="restart" goto restart

:start
sc.exe query "%CF_SERVICE%" | findstr /C:"RUNNING" >nul
if not errorlevel 1 (
    echo [Cloudflare] Tunnel sudah berjalan.
    exit /b 0
)

echo [Cloudflare] Menjalankan tunnel...
sc.exe start "%CF_SERVICE%" >nul
call :wait_running
exit /b 0

:restart
echo [Cloudflare] Merestart tunnel...
sc.exe query "%CF_SERVICE%" | findstr /C:"RUNNING" >nul
if not errorlevel 1 (
    sc.exe stop "%CF_SERVICE%" >nul 2>&1
    if errorlevel 1 (
        echo [Cloudflare] Tidak punya izin merestart service; tunnel dibiarkan tetap aktif.
        echo [Cloudflare] Jalankan restart.bat sebagai Administrator untuk merestart tunnel.
        exit /b 0
    )
    call :wait_stopped
)
sc.exe start "%CF_SERVICE%" >nul 2>&1
call :wait_running
exit /b 0

:wait_running
for /l %%i in (1,1,15) do (
    sc.exe query "%CF_SERVICE%" | findstr /C:"RUNNING" >nul
    if not errorlevel 1 (
        echo [Cloudflare] Tunnel aktif.
        exit /b 0
    )
    ping 127.0.0.1 -n 2 >nul
)
echo [Cloudflare] Tunnel belum bisa dijalankan. Jalankan batch sebagai Administrator.
exit /b 0

:wait_stopped
for /l %%i in (1,1,15) do (
    sc.exe query "%CF_SERVICE%" | findstr /C:"STOPPED" >nul
    if not errorlevel 1 exit /b 0
    ping 127.0.0.1 -n 2 >nul
)
exit /b 0
