@echo off
chcp 65001 > nul
cls

echo ========================================
echo    AIWife アプリケーション停止
echo ========================================
echo.

echo Dockerコンテナを停止しています...
docker-compose down

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✓ 正常に停止しました
) else (
    echo.
    echo ⚠ 停止中にエラーが発生しました
)

echo.
pause
