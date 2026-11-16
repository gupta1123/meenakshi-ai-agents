Option Explicit
Dim shell, arguments, command, code
Set shell = CreateObject("WScript.Shell")
Set arguments = WScript.Arguments
If arguments.Count <> 2 Then WScript.Quit 2
shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
command = Chr(34) & arguments(0) & Chr(34) & " " & Chr(34) & arguments(1) & Chr(34) & " start"
code = shell.Run(command, 0, True)
WScript.Quit code
