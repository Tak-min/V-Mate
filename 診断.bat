@echo off
chcp 65001 > nul
cls

echo ========================================
echo    AIWife トラブルシューティング
echo ========================================
echo.

echo [1] Docker Desktopの状態確認
echo ----------------------------------------
docker info >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo ✓ Docker Desktopは正常に動作しています
    docker --version
) else (
    echo ❌ Docker Desktopが起動していません
    echo.
    echo 📌 解決方法:
    echo    1. Docker Desktopを起動してください
    echo    2. タスクバーにDockerアイコンが表示されるまで待ちます
    echo    3. アイコンをクリックして「Engine running」を確認
    echo.
    goto :error
)
echo.

echo [2] .envファイルの確認
echo ----------------------------------------
if exist ".env" (
    echo ✓ .envファイルが存在します
    findstr /C:"GEMINI_API_KEY" .env >nul
    if %ERRORLEVEL% EQU 0 (
        echo ✓ GEMINI_API_KEYが設定されています
    ) else (
        echo ❌ GEMINI_API_KEYが設定されていません
        echo.
        echo 📌 .envファイルにGEMINI_API_KEYを追加してください
        goto :error
    )
) else (
    echo ❌ .envファイルが見つかりません
    echo.
    echo 📌 .envファイルを作成してください
    goto :error
)
echo.

echo [3] 必要なファイルの確認
echo ----------------------------------------
set "missing_files="
if not exist "Dockerfile.backend" set "missing_files=%missing_files% Dockerfile.backend"
if not exist "Dockerfile.frontend" set "missing_files=%missing_files% Dockerfile.frontend"
if not exist "docker-compose.yml" set "missing_files=%missing_files% docker-compose.yml"
if not exist "src" set "missing_files=%missing_files% src/"
if not exist "frontend" set "missing_files=%missing_files% frontend/"

if "%missing_files%"=="" (
    echo ✓ すべての必要なファイルが揃っています
) else (
    echo ❌ 以下のファイル/フォルダが見つかりません:
    echo    %missing_files%
    echo.
    goto :error
)
echo.

echo [4] ポートの使用状況確認
echo ----------------------------------------
netstat -ano | findstr ":5000" >nul
if %ERRORLEVEL% EQU 0 (
    echo ⚠ ポート5000が既に使用されています
    echo   他のアプリケーションを終了してください
) else (
    echo ✓ ポート5000は使用可能です
)

netstat -ano | findstr ":3000" >nul
if %ERRORLEVEL% EQU 0 (
    echo ⚠ ポート3000が既に使用されています
    echo   他のアプリケーションを終了してください
) else (
    echo ✓ ポート3000は使用可能です
)
echo.

echo [5] Dockerコンテナの状態
echo ----------------------------------------
docker-compose ps 2>nul
if %ERRORLEVEL% EQU 0 (
    echo.
) else (
    echo   コンテナは起動していません
)
echo.

echo ========================================
echo ✓ 診断が完了しました
echo ========================================
echo.
echo 問題が見つかった場合は、上記の指示に従ってください。
echo 詳しくは DOCKER_SETUP_GUIDE.md を参照してください。
echo.
goto :end

:error
echo.
echo ========================================
echo ❌ 問題が見つかりました
echo ========================================
echo.
echo 詳しい解決方法は DOCKER_SETUP_GUIDE.md を
echo 参照してください。
echo.

:end
pause
