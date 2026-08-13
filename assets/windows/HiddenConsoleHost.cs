using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class HiddenConsoleHost
{
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const uint WM_QUIT = 0x0012;
    private const int OBJID_WINDOW = 0;
    private static int legacyRootPid;
    private static WinEventCallback legacyWindowCallback;

    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--hide-tree")
        {
            int rootPid;
            return Int32.TryParse(args[1], out rootPid) ? HideLegacyTree(rootPid) : 64;
        }
        if (args.Length == 2 && args[0] == "--terminate-tree")
        {
            int rootPid;
            return Int32.TryParse(args[1], out rootPid) ? TerminateTree(rootPid) : 64;
        }
        int first = args.Length > 0 && args[0] == "--" ? 1 : 0;
        if (args.Length <= first)
            return 64;

        string executable = args[first];
        var forwarded = new List<string>();
        for (int index = first + 1; index < args.Length; index++)
            forwarded.Add(args[index]);

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION process;
        StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));
        string tail = JoinArguments(forwarded);
        if (tail.Length > 0)
            commandLine.Append(' ').Append(tail);

        if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NEW_CONSOLE | CREATE_SUSPENDED, IntPtr.Zero, null, ref startup, out process))
            return Marshal.GetLastWin32Error();

        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateKillOnCloseJob();
            if (job != IntPtr.Zero)
                AssignProcessToJobObject(job, process.hProcess);
            if (ResumeThread(process.hThread) == UInt32.MaxValue)
            {
                TerminateProcess(process.hProcess, 1);
                return 1;
            }
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;
            WaitForSingleObject(process.hProcess, INFINITE);
            uint exitCode;
            return GetExitCodeProcess(process.hProcess, out exitCode) ? unchecked((int)exitCode) : 1;
        }
        finally
        {
            if (process.hThread != IntPtr.Zero)
                CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            if (job != IntPtr.Zero)
                CloseHandle(job);
        }
    }

    private static int HideLegacyTree(int rootPid)
    {
        bool ownsMutex;
        using (Mutex mutex = new Mutex(true, "Local\\FeishuAgentNotifier.HiddenTreeV2." + rootPid, out ownsMutex))
        {
            if (!ownsMutex)
                return 0;
            legacyRootPid = rootPid;
            HideCurrentTree(rootPid);
            legacyWindowCallback = OnLegacyWindowShown;
            IntPtr hook = SetWinEventHook(
                EVENT_OBJECT_SHOW,
                EVENT_OBJECT_SHOW,
                IntPtr.Zero,
                legacyWindowCallback,
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
            );
            uint threadId = GetCurrentThreadId();
            Thread watcher = new Thread(delegate()
            {
                while (ProcessExists(rootPid)) Thread.Sleep(100);
                PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            });
            watcher.IsBackground = true;
            watcher.Start();
            try
            {
                MSG message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            }
            finally
            {
                if (hook != IntPtr.Zero) UnhookWinEvent(hook);
            }
        }
        return 0;
    }

    private static void OnLegacyWindowShown(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime)
    {
        if (window == IntPtr.Zero || objectId != OBJID_WINDOW || !IsWindowVisible(window))
            return;
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (ReadProcessTree((uint)legacyRootPid).Contains(pid))
            ShowWindow(window, SW_HIDE);
    }

    private static void HideCurrentTree(int rootPid)
    {
        HashSet<uint> tree = ReadProcessTree((uint)rootPid);
        EnumWindows(delegate(IntPtr window, IntPtr data)
        {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (tree.Contains(pid) && IsWindowVisible(window))
                ShowWindow(window, SW_HIDE);
            return true;
        }, IntPtr.Zero);
    }

    private static bool ProcessExists(int pid)
    {
        try
        {
            using (Process process = Process.GetProcessById(pid))
                return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private static int TerminateTree(int rootPid)
    {
        HashSet<uint> tree = ReadProcessTree((uint)rootPid);
        foreach (uint pid in tree)
        {
            if (pid == (uint)rootPid)
                continue;
            TerminatePid(pid);
        }
        TerminatePid((uint)rootPid);
        for (int attempt = 0; attempt < 100 && ProcessExists(rootPid); attempt++)
            Thread.Sleep(50);
        return ProcessExists(rootPid) ? 1 : 0;
    }

    private static void TerminatePid(uint pid)
    {
        IntPtr process = OpenProcess(PROCESS_TERMINATE, false, pid);
        if (process == IntPtr.Zero)
            return;
        try
        {
            TerminateProcess(process, 0);
        }
        finally
        {
            CloseHandle(process);
        }
    }

    private static HashSet<uint> ReadProcessTree(uint rootPid)
    {
        var parents = new List<KeyValuePair<uint, uint>>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot != new IntPtr(-1))
        {
            try
            {
                PROCESSENTRY32 entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (Process32First(snapshot, ref entry))
                {
                    do
                    {
                        parents.Add(new KeyValuePair<uint, uint>(entry.th32ProcessID, entry.th32ParentProcessID));
                    }
                    while (Process32Next(snapshot, ref entry));
                }
            }
            finally
            {
                CloseHandle(snapshot);
            }
        }
        var tree = new HashSet<uint>();
        tree.Add(rootPid);
        bool changed;
        do
        {
            changed = false;
            foreach (KeyValuePair<uint, uint> pair in parents)
            {
                if (tree.Contains(pair.Value) && tree.Add(pair.Key))
                    changed = true;
            }
        }
        while (changed);
        return tree;
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            return IntPtr.Zero;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr value = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, value, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, value, (uint)size))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }
        finally
        {
            Marshal.FreeHGlobal(value);
        }
    }

    private static string JoinArguments(IEnumerable<string> args)
    {
        StringBuilder result = new StringBuilder();
        foreach (string arg in args)
        {
            if (result.Length > 0) result.Append(' ');
            result.Append(QuoteArgument(arg));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return arg;
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char value in arg)
        {
            if (value == '\\')
            {
                backslashes++;
            }
            else if (value == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
            }
            else
            {
                result.Append('\\', backslashes);
                result.Append(value);
                backslashes = 0;
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr data);
    private delegate void WinEventCallback(IntPtr hook, uint eventType, IntPtr window,
        int objectId, int childId, uint eventThread, uint eventTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module,
        WinEventCallback callback, uint processId, uint threadId, uint flags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, IntPtr window, uint minimum, uint maximum);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
}
