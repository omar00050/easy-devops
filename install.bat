@echo off
:: install.bat — Easy DevOps Bootstrap Installer (Windows)
:: Thin launcher: checks for PowerShell 5.1+ and delegates to install.ps1
::
:: Usage:
::   install.bat [OPTIONS]
::
:: Options are mapped to install.ps1's parameter names:
::   --help / -h           -> -Help
::   --version VERSION     -> -Version VERSION  (also --version=VERSION)
::   --keep-node           -> -KeepNode
::   --service             -> -Service
::   --no-service          -> -NoService
::   --pm2                 -> -Pm2
::   --no-pm2              -> -NoPm2
::   --yes / -y            -> -Yes
::   --non-interactive     -> -NonInteractive
::
:: Anything else is passed through to install.ps1 unchanged.

setlocal EnableDelayedExpansion

:: Check that PowerShell is available
where powershell >nul 2>&1
if errorlevel 1 (
    echo Error: PowerShell is required but was not found on PATH. >&2
    echo Please install PowerShell 5.1 or later: >&2
    echo   https://github.com/PowerShell/PowerShell/releases >&2
    exit /b 1
)

:: Verify minimum PowerShell version (5.1). Windows PowerShell 5.0 and the
:: 4.x that ships with older Windows releases cannot run install.ps1.
for /f "usebackq tokens=1,2 delims=." %%a in (
    `powershell -NoProfile -Command "$PSVersionTable.PSVersion.Major.ToString() + '.' + $PSVersionTable.PSVersion.Minor.ToString()" 2^>nul`
) do (
    set PS_MAJOR=%%a
    set PS_MINOR=%%b
)

if not defined PS_MAJOR (
    echo Error: Could not determine PowerShell version. >&2
    exit /b 1
)
if not defined PS_MINOR set PS_MINOR=0
set /a PS_VERSION_NUM=PS_MAJOR*100+PS_MINOR
if %PS_VERSION_NUM% LSS 501 (
    echo Error: PowerShell 5.1 or later is required. Found %PS_MAJOR%.%PS_MINOR%. >&2
    echo Install Windows Management Framework 5.1, which upgrades Windows PowerShell to 5.1: >&2
    echo   https://www.microsoft.com/download/details.aspx?id=54616 >&2
    exit /b 1
)

:: Map the documented long options to install.ps1 parameter names. Anything
:: unrecognised is forwarded unchanged so an advanced caller is never blocked.
set "PS_ARGS="
:parse_args
if "%~1"=="" goto run_installer

if /i "%~1"=="--help" (
    set "PS_ARGS=!PS_ARGS! -Help"
    shift
    goto parse_args
)
if /i "%~1"=="-h" (
    set "PS_ARGS=!PS_ARGS! -Help"
    shift
    goto parse_args
)
if /i "%~1"=="--keep-node" (
    set "PS_ARGS=!PS_ARGS! -KeepNode"
    shift
    goto parse_args
)
if /i "%~1"=="--service" (
    set "PS_ARGS=!PS_ARGS! -Service"
    shift
    goto parse_args
)
if /i "%~1"=="--no-service" (
    set "PS_ARGS=!PS_ARGS! -NoService"
    shift
    goto parse_args
)
if /i "%~1"=="--pm2" (
    set "PS_ARGS=!PS_ARGS! -Pm2"
    shift
    goto parse_args
)
if /i "%~1"=="--no-pm2" (
    set "PS_ARGS=!PS_ARGS! -NoPm2"
    shift
    goto parse_args
)
if /i "%~1"=="--yes" (
    set "PS_ARGS=!PS_ARGS! -Yes"
    shift
    goto parse_args
)
if /i "%~1"=="-y" (
    set "PS_ARGS=!PS_ARGS! -Yes"
    shift
    goto parse_args
)
if /i "%~1"=="--non-interactive" (
    set "PS_ARGS=!PS_ARGS! -NonInteractive"
    shift
    goto parse_args
)

if /i "%~1"=="--version" (
    if "%~2"=="" (
        echo Error: --version requires a value, for example --version 20. >&2
        exit /b 1
    )
    set "PS_ARGS=!PS_ARGS! -Version %~2"
    shift
    shift
    goto parse_args
)

set "_arg=%~1"
if /i "!_arg:~0,10!"=="--version=" (
    set "PS_ARGS=!PS_ARGS! -Version !_arg:~10!"
    shift
    goto parse_args
)

set "PS_ARGS=!PS_ARGS! %~1"
shift
goto parse_args

:run_installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" !PS_ARGS!
exit /b %ERRORLEVEL%
