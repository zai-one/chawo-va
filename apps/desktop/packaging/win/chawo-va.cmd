@echo off
rem chawo-va CLI for the installed / portable Windows build: the same app executable in Node mode
rem (ELECTRON_RUN_AS_NODE), running out\main\cli.js from resources\app.asar. Nothing extra to install.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0ChawoVoiceAssistant.exe" "%~dp0resources\app.asar\out\main\cli.js" %*
exit /b %ERRORLEVEL%
