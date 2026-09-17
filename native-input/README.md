# ClassRelay InputGuard (Windows optional input lock helper)

[한국어](README.ko.md)

`InputGuard.exe` is an optional Windows-only helper for the Student Agent. It uses current-interactive-session low-level keyboard and mouse hooks (`WH_KEYBOARD_LL`, `WH_MOUSE_LL`), without administrator rights and without `BlockInput`.

Build on Windows PowerShell:

```powershell
.\native-input\build.ps1
```

The executable reads UTF-8 text commands from standard input and emits status lines on standard output:

```text
LOCK 42       # lock or renew revision 42 for at most 15 seconds
UNLOCK        # release immediately
```

Each `LOCK <revision>` extends the lease by no more than 15 seconds. If the controller/agent stops renewing, the helper releases input automatically. EOF also releases input and terminates the process. `Ctrl+Shift+F12` is always an emergency release and reports `UNLOCKED emergency`; the same revision remains latched unlocked until `UNLOCK` or a newer lock revision arrives.

Run the non-invasive state test:

```powershell
.\native-input\dist\InputGuard.exe --self-test
```

Limitations: secure-attention keys such as Ctrl+Alt+Del run on Windows' secure desktop and cannot be intercepted or suppressed. This is a best-effort current-session input lock, not a security boundary; an administrator, another session, policy controls, or a reboot can defeat it. No input events or keystrokes are recorded.
