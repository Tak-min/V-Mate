@echo off
echo Starting AI Wife Development Server...
echo.
echo [1/2] Starting Backend Server...
start /B cmd /c "cd src && python app.py"

echo Waiting for backend to start (5 seconds)...
timeout /t 5 /nobreak >nul

echo.
echo [2/2] Starting Frontend Server...
npm run dev:frontend

echo.
echo Development servers are running!
echo Backend: http://localhost:5000
echo Frontend: http://localhost:3000
