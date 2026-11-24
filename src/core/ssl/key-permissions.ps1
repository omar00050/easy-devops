param([Parameter(Mandatory=$true)][string]$Directory, [switch]$ServerMode)
$ErrorActionPreference = 'Stop'

# Pin each path component until both ACL changes finish. Denying delete sharing
# prevents a directory or key being renamed out from under a path-based ACL write.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class KeyPath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr templateFile);
    [StructLayout(LayoutKind.Sequential)]
    struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static SafeFileHandle Pin(string path, bool directory) {
        var h = CreateFile(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            Info info;
            if (!GetFileInformationByHandle(h, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory
                || (!directory && info.Links != 1)) throw new Exception("Unsafe private key path: " + path);
            return h;
        } catch { h.Dispose(); throw; }
    }
}
"@

function Protect-Item($item, $isDirectory) {
    $acl = $item.GetAccessControl()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
        $acl.RemoveAccessRuleSpecific($rule)
    }
    $inherit = if ($isDirectory) { 'ContainerInherit, ObjectInherit' } else { 'None' }
    foreach ($sid in $identities) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    $item.SetAccessControl($acl)
}

$identities = @(
    [Security.Principal.WindowsIdentity]::GetCurrent().User
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)
if ($ServerMode) {
    $identities += [Security.Principal.NTAccount]::new('NT SERVICE\EasyDevOps').Translate([Security.Principal.SecurityIdentifier])
}
$pins = [Collections.Generic.List[IDisposable]]::new()
try {
    $dir = [IO.DirectoryInfo]::new($Directory)
    $chain = [Collections.Generic.Stack[string]]::new()
    for ($part = $dir; $null -ne $part; $part = $part.Parent) { $chain.Push($part.FullName) }
    foreach ($part in $chain) { $pins.Add([KeyPath]::Pin($part, $true)) }
    Protect-Item $dir $true
    $name = if ($dir.Name -eq '.account') { 'account.key' } else { 'privkey.pem' }
    $file = [IO.FileInfo]::new([IO.Path]::Combine($Directory, $name))
    if ($file.Exists) {
        $pins.Add([KeyPath]::Pin($file.FullName, $false))
        Protect-Item $file $false
    }
} finally {
    foreach ($pin in $pins) { $pin.Dispose() }
}
