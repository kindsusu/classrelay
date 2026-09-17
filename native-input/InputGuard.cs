// InputGuard is deliberately a narrow current-session helper. It never calls BlockInput.
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class InputGuard
{
    private const int LeaseSeconds = 15;
    private static readonly object Gate = new object();
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static long _leaseUntilTicks;
    private static long _revision = -1;
    private static long _emergencyRevision = -1;
    private static int _locked;
    private static ApplicationContext _context;
    private static System.Threading.Timer _leaseTimer;
    private static IntPtr _keyboardHook;
    private static IntPtr _mouseHook;
    private static HookProc _keyboardProc;
    private static HookProc _mouseProc;
    private static readonly ConcurrentQueue<string> StatusQueue = new ConcurrentQueue<string>();
    private static int _statusWriterRunning;
    private static int _ctrlMask;
    private static int _shiftMask;
    private static uint _messageThreadId;
    private static bool _selfTest;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") { _selfTest = true; return SelfTest(); }
        if (args.Length != 0) { Console.Error.WriteLine("Usage: InputGuard.exe [--self-test]"); return 2; }

        Application.EnableVisualStyles();
        _messageThreadId = GetCurrentThreadId();
        _keyboardProc = KeyboardHook;
        _mouseProc = MouseHook;
        _keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, GetModuleHandle(null), 0);
        _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, GetModuleHandle(null), 0);
        if (_keyboardHook == IntPtr.Zero || _mouseHook == IntPtr.Zero)
        {
            Console.Error.WriteLine("ERROR unable to install low-level input hooks");
            DisposeHooks();
            return 1;
        }

        _context = new ApplicationContext();
        _leaseTimer = new System.Threading.Timer(CheckLease, null, 250, 250);
        WriteStatus("UNLOCKED startup");
        ThreadPool.QueueUserWorkItem(ReadProtocol);
        Application.Run(_context);
        Unlock("shutdown");
        _leaseTimer.Dispose();
        DisposeHooks();
        return 0;
    }

    private static void ReadProtocol(object ignored)
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null) HandleCommand(line);
        }
        finally
        {
            Unlock("stdin-eof");
            if (_messageThreadId != 0) PostThreadMessage(_messageThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }
    }

    // LOCK <monotonically increasing revision>. Every renewal is capped at 15 seconds.
    private static void HandleCommand(string line)
    {
        if (line == "UNLOCK")
        {
            bool changed;
            lock (Gate)
            {
                _emergencyRevision = -1;
                changed = Interlocked.Exchange(ref _locked, 0) != 0;
            }
            if (changed) ReportStatus("UNLOCKED command");
            return;
        }
        if (!line.StartsWith("LOCK ", StringComparison.Ordinal)) { Console.Error.WriteLine("ERROR invalid command"); return; }
        long revision;
        if (!Int64.TryParse(line.Substring(5), out revision) || revision < 0)
        { Console.Error.WriteLine("ERROR invalid revision"); return; }

        lock (Gate)
        {
            // An emergency release stays effective until an explicit UNLOCK or a newer lock revision.
            if (_emergencyRevision == revision) return;
            if (_emergencyRevision >= 0 && revision > _emergencyRevision) _emergencyRevision = -1;
            if (_revision > revision) { Console.Error.WriteLine("ERROR stale revision"); return; }
            bool enteringLock = Volatile.Read(ref _locked) == 0;
            _revision = revision;
            _leaseUntilTicks = Clock.ElapsedTicks + LeaseTicks();
            // Query once only when entering a lock, then preserve independent modifier state.
            if (enteringLock && !_selfTest)
            {
                _ctrlMask = InitialModifierMask(VK_CONTROL, VK_LCONTROL, VK_RCONTROL);
                _shiftMask = InitialModifierMask(VK_SHIFT, VK_LSHIFT, VK_RSHIFT);
            }
            Volatile.Write(ref _locked, 1);
        }
        WriteStatus("LOCKED " + revision);
    }

    private static void CheckLease(object ignored)
    {
        bool expired = false;
        lock (Gate)
        {
            if (Volatile.Read(ref _locked) != 0 && Clock.ElapsedTicks >= Interlocked.Read(ref _leaseUntilTicks))
            {
                Interlocked.Exchange(ref _locked, 0);
                expired = true;
            }
        }
        if (expired) ReportStatus("UNLOCKED lease-expired");
    }

    private static void Unlock(string reason)
    {
        bool changed;
        lock (Gate) changed = Interlocked.Exchange(ref _locked, 0) != 0;
        if (changed) ReportStatus("UNLOCKED " + reason);
    }

    private static void EmergencyUnlock()
    {
        bool changed;
        lock (Gate)
        {
            _emergencyRevision = _revision;
            changed = Interlocked.Exchange(ref _locked, 0) != 0;
        }
        if (changed) ReportStatus("UNLOCKED emergency");
    }

    private static long LeaseTicks() { return (long)(Stopwatch.Frequency * LeaseSeconds); }
    private static bool IsLocked() { return Volatile.Read(ref _locked) != 0; }

    private static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && IsLocked())
        {
            int message = wParam.ToInt32();
            int key = Marshal.ReadInt32(lParam);
            UpdateModifiers(message, key);
            if ((message == WM_KEYDOWN || message == WM_SYSKEYDOWN) && key == VK_F12 && CtrlShiftDown())
            {
                EmergencyUnlock();
                return CallNextHookEx(_keyboardHook, code, wParam, lParam);
            }
            return (IntPtr)1;
        }
        if (code >= 0)
            UpdateModifiers(wParam.ToInt32(), Marshal.ReadInt32(lParam));
        return CallNextHookEx(_keyboardHook, code, wParam, lParam);
    }

    private static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
    {
        return code >= 0 && IsLocked() ? (IntPtr)1 : CallNextHookEx(_mouseHook, code, wParam, lParam);
    }

    private static bool CtrlShiftDown()
    {
        return Volatile.Read(ref _ctrlMask) != 0 && Volatile.Read(ref _shiftMask) != 0;
    }

    private static bool IsKeyDown(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    private static int InitialModifierMask(int generic, int left, int right)
    {
        int mask = 0;
        if (IsKeyDown(generic)) mask |= 4;
        if (IsKeyDown(left)) mask |= 1;
        if (IsKeyDown(right)) mask |= 2;
        return mask;
    }
    private static void UpdateModifiers(int message, int key)
    {
        bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
        if (!down && !up) return;
        if (key == VK_CONTROL || key == VK_LCONTROL || key == VK_RCONTROL) SetModifierBit(ref _ctrlMask, ModifierBit(key, VK_CONTROL, VK_LCONTROL), down);
        if (key == VK_SHIFT || key == VK_LSHIFT || key == VK_RSHIFT) SetModifierBit(ref _shiftMask, ModifierBit(key, VK_SHIFT, VK_LSHIFT), down);
    }
    private static int ModifierBit(int key, int generic, int left) { return key == generic ? 4 : key == left ? 1 : 2; }
    private static void SetModifierBit(ref int target, int bit, bool down)
    {
        int before, after;
        do
        {
            before = Volatile.Read(ref target);
            after = down ? before | bit : before & ~bit;
        } while (Interlocked.CompareExchange(ref target, after, before) != before);
    }
    private static void WriteStatus(string status) { Console.Out.WriteLine(status); Console.Out.Flush(); }
    // Hook callbacks must never synchronously wait for a parent process reading stdout.
    private static void ReportStatus(string status)
    {
        StatusQueue.Enqueue(status);
        if (Interlocked.Exchange(ref _statusWriterRunning, 1) == 0)
            ThreadPool.QueueUserWorkItem(DrainStatus);
    }
    private static void DrainStatus(object ignored)
    {
        try { string status; while (StatusQueue.TryDequeue(out status)) WriteStatus(status); }
        finally
        {
            Interlocked.Exchange(ref _statusWriterRunning, 0);
            if (!StatusQueue.IsEmpty && Interlocked.Exchange(ref _statusWriterRunning, 1) == 0)
                ThreadPool.QueueUserWorkItem(DrainStatus);
        }
    }
    private static void DisposeHooks()
    {
        if (_keyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(_keyboardHook); _keyboardHook = IntPtr.Zero; }
        if (_mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(_mouseHook); _mouseHook = IntPtr.Zero; }
    }

    private static int SelfTest()
    {
        // This covers state/lease math only. It does not install hooks or suppress host input.
        if (LeaseTicks() != Stopwatch.Frequency * LeaseSeconds) return 1;
        UpdateModifiers(WM_KEYDOWN, VK_LCONTROL);
        UpdateModifiers(WM_KEYDOWN, VK_RSHIFT);
        HandleCommand("LOCK 7");
        if (!IsLocked() || !CtrlShiftDown()) return 1;
        HandleCommand("LOCK 7"); // renewal must preserve swallowed modifier state.
        if (!CtrlShiftDown()) return 1;
        UpdateModifiers(WM_KEYUP, VK_LCONTROL);
        if (Volatile.Read(ref _ctrlMask) != 0 || CtrlShiftDown()) return 1;
        UpdateModifiers(WM_KEYUP, VK_RSHIFT);
        if (CtrlShiftDown()) return 1;
        EmergencyUnlock();
        if (IsLocked()) return 1;
        HandleCommand("LOCK 7");
        if (IsLocked()) return 1;
        HandleCommand("UNLOCK");
        HandleCommand("LOCK 6");
        if (IsLocked()) return 1; // stale revisions cannot relock.
        HandleCommand("LOCK 8");
        if (!IsLocked()) return 1;
        // No sleep: force a past monotonic deadline and exercise the lease-expiry path.
        Interlocked.Exchange(ref _leaseUntilTicks, Clock.ElapsedTicks - 1);
        CheckLease(null);
        if (IsLocked()) return 1;
        Console.WriteLine("SELF-TEST OK");
        return 0;
    }

    private const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105, WM_QUIT = 0x0012;
    private const int VK_CONTROL = 0x11, VK_SHIFT = 0x10, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_F12 = 0x7B;
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessage(uint threadId, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
}
