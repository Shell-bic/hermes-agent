$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class Pb02ProcessHandleMonitor : IDisposable
{
    const uint TH32CS_SNAPPROCESS = 2, PROCESS_TERMINATE = 1;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x100000;
    const uint WAIT_TIMEOUT = 0x102;
    readonly Dictionary<int, PinnedProcess> pinned = new Dictionary<int, PinnedProcess>();
    PinnedProcess launcher;
    PinnedProcess monitorSelf;
    int launcherPid;
    int bootstrapPid;
    long bootstrapIdentity;
    int electronRootPid;
    long electronRootIdentity;
    bool quiescing;

    public int AttachBootstrap(int requestedLauncherPid, int pid)
    {
        launcherPid = requestedLauncherPid;
        bootstrapPid = pid;
        launcher = OpenProcessIdentity(launcherPid, true, false);
        monitorSelf = OpenProcessIdentity(Process.GetCurrentProcess().Id, true, false);
        var root = OpenProcessIdentity(pid, true, true);
        try {
            ValidateInitialControlChain(root);
            bootstrapIdentity = root.Identity;
            pinned.Add(pid, root);
            return pinned.Count;
        } catch {
            root.Dispose();
            launcher.Dispose();
            monitorSelf.Dispose();
            launcher = null;
            monitorSelf = null;
            throw;
        }
    }

    public int AttachElectronRoot(int pid)
    {
        EnsureOpen();
        if (electronRootPid != 0) throw new InvalidOperationException("electron_root_duplicate");
        var root = OpenProcessIdentity(pid, true, true);
        try {
            ValidateElectronRoot(root);
            AddPinned(root);
            electronRootPid = pid;
            electronRootIdentity = root.Identity;
            return pinned.Count;
        } catch {
            root.Dispose();
            throw;
        }
    }

    public int PinReported(long sampledAtFileTime, int[] pids)
    {
        EnsureOpen();
        if (electronRootPid == 0) throw new InvalidOperationException("electron_root_missing");
        VerifyStillSame(launcher);
        VerifyStillSame(pinned[bootstrapPid]);
        VerifyStillSame(pinned[electronRootPid]);
        long now = DateTime.UtcNow.ToFileTimeUtc();
        if (sampledAtFileTime < electronRootIdentity || sampledAtFileTime > now + TimeSpan.TicksPerSecond)
            throw new InvalidOperationException("snapshot_invalid");
        if (pids == null || pids.Length == 0 || pids.Length > 64 || pids.Distinct().Count() != pids.Length)
            throw new InvalidOperationException("snapshot_invalid");
        foreach (int pid in pids.OrderBy(value => value)) {
            PinnedProcess existing;
            if (pinned.TryGetValue(pid, out existing)) {
                using (var current = OpenProcessIdentity(pid, false, false)) {
                    if (current != null && current.Identity != existing.Identity)
                        throw new InvalidOperationException("process_identity_changed");
                }
                continue;
            }
            var process = OpenProcessIdentity(pid, true, true);
            if (process.Identity < electronRootIdentity || process.Identity > sampledAtFileTime) {
                process.Dispose();
                throw new InvalidOperationException("process_identity_changed");
            }
            AddPinned(process);
        }
        return pinned.Count;
    }

    public int Quiesce()
    {
        EnsureOpen();
        quiescing = true;
        var grace = Stopwatch.StartNew();
        while (grace.Elapsed < TimeSpan.FromMilliseconds(500) && pinned.Values.Any(entry => IsAlive(entry.Handle)))
            Thread.Sleep(25);

        foreach (var entry in pinned.Values.OrderByDescending(value => value.Identity)) {
            if (!IsAlive(entry.Handle)) continue;
            if (!TerminateProcess(entry.Handle, 1) && IsAlive(entry.Handle))
                throw new InvalidOperationException("process_terminate_failed");
        }

        var wait = Stopwatch.StartNew();
        while (wait.Elapsed < TimeSpan.FromSeconds(15)) {
            if (pinned.Values.All(entry => !IsAlive(entry.Handle))) return pinned.Count;
            Thread.Sleep(25);
        }
        throw new InvalidOperationException("tree_not_quiescent");
    }

    void EnsureOpen()
    {
        if (quiescing) throw new InvalidOperationException("monitor_quiescing");
    }

    void ValidateInitialControlChain(PinnedProcess bootstrap)
    {
        int monitorPid = monitorSelf.Pid;
        if (launcher.Identity > monitorSelf.Identity || monitorSelf.Identity > bootstrap.Identity)
            throw new InvalidOperationException("control_creation_order_invalid");
        for (int pass = 0; pass < 2; pass++) {
            VerifyStillSame(launcher);
            VerifyStillSame(monitorSelf);
            VerifyStillSame(bootstrap);
            var parents = SnapshotParents();
            int monitorParent, bootstrapParent;
            if (!parents.TryGetValue(monitorPid, out monitorParent) || monitorParent != launcherPid ||
                !parents.TryGetValue(bootstrap.Pid, out bootstrapParent) || bootstrapParent != launcherPid)
                throw new InvalidOperationException("control_parent_invalid");
            VerifyStillSame(launcher);
            VerifyStillSame(monitorSelf);
            VerifyStillSame(bootstrap);
            if (pass == 0) Thread.Sleep(5);
        }
    }

    void ValidateElectronRoot(PinnedProcess root)
    {
        if (root.Identity < bootstrapIdentity) throw new InvalidOperationException("process_identity_changed");
        for (int pass = 0; pass < 2; pass++) {
            VerifyStillSame(launcher);
            VerifyStillSame(pinned[bootstrapPid]);
            VerifyStillSame(root);
            var parents = SnapshotParents();
            int parentPid;
            if (!parents.TryGetValue(root.Pid, out parentPid) || parentPid != bootstrapPid)
                throw new InvalidOperationException("electron_root_parent_invalid");
            VerifyStillSame(pinned[bootstrapPid]);
            VerifyStillSame(root);
            if (pass == 0) Thread.Sleep(5);
        }
    }

    static void VerifyStillSame(PinnedProcess expected)
    {
        if (expected == null || !IsAlive(expected.Handle)) throw new InvalidOperationException("process_identity_changed");
        using (var current = OpenProcessIdentity(expected.Pid, true, false)) {
            if (current.Identity != expected.Identity || !IsAlive(current.Handle))
                throw new InvalidOperationException("process_identity_changed");
        }
    }

    void AddPinned(PinnedProcess process)
    {
        PinnedProcess existing;
        if (pinned.TryGetValue(process.Pid, out existing)) {
            if (existing.Identity != process.Identity) {
                process.Dispose();
                throw new InvalidOperationException("process_identity_changed");
            }
            process.Dispose();
            return;
        }
        pinned.Add(process.Pid, process);
    }

    static PinnedProcess OpenProcessIdentity(int pid, bool required, bool allowTerminate)
    {
        uint access = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
        if (allowTerminate) access |= PROCESS_TERMINATE;
        var handle = OpenProcess(access, false, (uint)pid);
        if (handle.IsInvalid) {
            handle.Dispose();
            if (required) throw new InvalidOperationException("process_missing");
            return null;
        }
        long identity;
        if (!TryReadIdentity(handle, out identity)) {
            handle.Dispose();
            if (required) throw new InvalidOperationException("process_missing");
            return null;
        }
        return new PinnedProcess(pid, identity, handle);
    }

    static bool TryReadIdentity(SafeProcessHandle handle, out long identity)
    {
        FILETIME creation, exit, kernel, user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
            identity = 0;
            return false;
        }
        identity = ((long)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
        return identity > 0;
    }

    static bool IsAlive(SafeProcessHandle handle)
    {
        return !handle.IsInvalid && !handle.IsClosed && WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
    }

    static Dictionary<int, int> SnapshotParents()
    {
        var result = new Dictionary<int, int>();
        using (var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)) {
            if (snapshot.IsInvalid) throw new InvalidOperationException("snapshot_failed");
            var entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            if (!Process32First(snapshot, ref entry)) throw new InvalidOperationException("snapshot_failed");
            do {
                result[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
                entry.dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>();
            } while (Process32Next(snapshot, ref entry));
        }
        return result;
    }

    public static bool IdentityMismatchRejectedForTest()
    {
        var identities = new Dictionary<int, long> { { 42, 1001 } };
        long existing;
        bool rejected = identities.TryGetValue(42, out existing) && existing != 1002;
        return rejected && identities.Count == 1 && identities[42] == 1001;
    }

    public void Dispose()
    {
        foreach (var process in pinned.Values) process.Dispose();
        pinned.Clear();
        if (launcher != null) launcher.Dispose();
        if (monitorSelf != null) monitorSelf.Dispose();
        launcher = null;
        monitorSelf = null;
    }

    sealed class PinnedProcess : IDisposable
    {
        public readonly int Pid;
        public readonly long Identity;
        public readonly SafeProcessHandle Handle;
        public PinnedProcess(int pid, long identity, SafeProcessHandle handle) { Pid = pid; Identity = identity; Handle = handle; }
        public void Dispose() { Handle.Dispose(); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PROCESSENTRY32 { public uint dwSize,cntUsage,th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID,cntThreads,th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile; }
    [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint dwLowDateTime,dwHighDateTime; }
    sealed class SafeProcessHandle : SafeHandleZeroOrMinusOneIsInvalid { SafeProcessHandle():base(true){} protected override bool ReleaseHandle(){return CloseHandle(handle);} }
    sealed class SafeSnapshotHandle : SafeHandleMinusOneIsInvalid { SafeSnapshotHandle():base(true){} protected override bool ReleaseHandle(){return CloseHandle(handle);} }
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint a,bool b,uint c);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle a,out FILETIME b,out FILETIME c,out FILETIME d,out FILETIME e);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle a,uint b);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(SafeProcessHandle a,uint b);
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeSnapshotHandle CreateToolhelp32Snapshot(uint a,uint b);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32First(SafeSnapshotHandle a,ref PROCESSENTRY32 b);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32Next(SafeSnapshotHandle a,ref PROCESSENTRY32 b);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr a);
}
'@

try {
    Add-Type -TypeDefinition $source -Language CSharp
    if ($env:PB02_HANDLE_MONITOR_IDENTITY_SELF_TEST -ceq '1') {
        if (-not [Pb02ProcessHandleMonitor]::IdentityMismatchRejectedForTest()) { throw 'identity_self_test_failed' }
        [Console]::Out.WriteLine('IDENTITY_SELF_TEST_PASS')
        [Console]::Out.Flush()
        exit 0
    }
    [Console]::Out.WriteLine('MONITOR_READY')
    [Console]::Out.Flush()
    $attach = [Console]::In.ReadLine()
    if ($attach -notmatch '^ATTACH ([1-9][0-9]{0,9}) ([1-9][0-9]{0,9})$') { throw 'invalid_start' }
    $monitor = [Pb02ProcessHandleMonitor]::new()
    try {
        $null = $monitor.AttachBootstrap([int]$Matches[1], [int]$Matches[2])
        [Console]::Out.WriteLine('READY')
        [Console]::Out.Flush()
        while ($true) {
            $command = [Console]::In.ReadLine()
            if ($null -eq $command) { throw 'command_eof' }
            if ($command -match '^ELECTRON_ROOT ([1-9][0-9]{0,9})$') {
                $count = $monitor.AttachElectronRoot([int]$Matches[1])
                [Console]::Out.WriteLine("ROOT_PINNED $count")
            }
            elseif ($command -match '^PIN ([1-9][0-9]{0,9}) ([1-9][0-9]{16,18}) ((?:[1-9][0-9]{0,9})(?:,(?:[1-9][0-9]{0,9})){0,63})$') {
                $sequence = $Matches[1]
                $sampledAtFileTime = [long]$Matches[2]
                $pids = @($Matches[3].Split(',') | ForEach-Object { [int]$_ })
                $count = $monitor.PinReported($sampledAtFileTime, $pids)
                [Console]::Out.WriteLine("PINNED $sequence $count")
            }
            elseif ($command -ceq 'QUIESCE') {
                $count = $monitor.Quiesce()
                [Console]::Out.WriteLine("QUIESCENT $count")
                [Console]::Out.Flush()
                break
            }
            else { throw 'command_invalid' }
            [Console]::Out.Flush()
        }
    }
    finally { if ($null -ne $monitor) { $monitor.Dispose() } }
}
catch {
    [Console]::Out.WriteLine('FAIL tree_monitor_failed')
    [Console]::Out.Flush()
    exit 1
}
