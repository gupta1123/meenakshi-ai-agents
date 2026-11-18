Option Explicit
Dim shell, arguments, command, code, retryDelay, started
Set shell = CreateObject("WScript.Shell")
Set arguments = WScript.Arguments
If arguments.Count <> 2 Then WScript.Quit 2
shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
command = Chr(34) & arguments(0) & Chr(34) & " " & Chr(34) & arguments(1) & Chr(34) & " start"
retryDelay = 5000
Do
  started = Now
  code = shell.Run(command, 0, True)
  If code = 0 Or code = 2 Then Exit Do
  ' Recover in the hidden parent even if Windows does not retry the task.
  ' The connector's OS-owned lock prevents concurrent Tally readers.
  If DateDiff("s", started, Now) >= 60 Then retryDelay = 5000
  WScript.Sleep retryDelay
  If retryDelay < 60000 Then retryDelay = retryDelay * 2
  If retryDelay > 60000 Then retryDelay = 60000
Loop
WScript.Quit code
