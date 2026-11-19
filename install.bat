@echo off
:: install.bat — Easy DevOps Bootstrap Installer (Windows)
:: Thin launcher: checks for PowerShell 5.1+ and delegates to install.ps1
::
:: Usage:
::   install.bat [OPTIONS]
::
:: Options are passed through to install.ps1:
::   --help            Print usage and exit
::   --version VERSION Skip picker; use the specified Node.js version
::   --keep-node       Skip Node.js management

setlocal EnableDelayedExpansion

:: Check that PowerShell is available
where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo Error: PowerShell is required but was not found on PATH. >&2
    echo Please install PowerShell 5.1 or later: >&2
    echo   https://github.com/PowerShell/PowerShell/releases >&2
    exit /b 1
)

:: Verify minimum PowerShell version (5.1). Windows PowerShell 5.0 and the
:: 4.x that ships with older Windows releases cannot run install.ps1.
for /f "usebackq tokens=1,2 delims=." %%a in (
    `powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.Major.ToString() + '.' + $PSVersionTable.PSVersion.Minor.ToString()" 2^>nul`
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

:: Delegate to install.ps1 in the same directory
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
