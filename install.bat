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

:: Verify minimum PowerShell version (5.1)
for /f "usebackq tokens=*" %%v in (
    `powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.Major" 2^>nul`
) do set PS_MAJOR=%%v

if not defined PS_MAJOR (
    echo Error: Could not determine PowerShell version. >&2
    exit /b 1
)
if %PS_MAJOR% LSS 5 (
    echo Error: PowerShell 5.1 or later is required. Found version %PS_MAJOR%. >&2
    echo Please upgrade PowerShell: https://github.com/PowerShell/PowerShell/releases >&2
    exit /b 1
)

:: Delegate to install.ps1 in the same directory
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
