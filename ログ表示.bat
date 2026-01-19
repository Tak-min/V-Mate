@echo off
chcp 65001 > nul
cls

echo ========================================
echo    AIWife ログ表示
echo ========================================
echo.
echo リアルタイムでログを表示します
echo 終了するには Ctrl+C を押してください
echo.
echo ========================================
echo.

docker-compose logs -f
