' Starts Saqme To Do without a console window (used by the shortcuts, the saqme: link and start-with-Windows).
' A saqme: link (saqme://join?... from a shared list's invite page) comes as the first argument; it reaches the app
' in SAQME_OPEN_URL, an environment variable rather than the command line, so there is no quoting to get wrong.
' The app asks before it joins anything.
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
  url = WScript.Arguments(0)
  If LCase(Left(url, 6)) = "saqme:" And Len(url) < 4096 Then sh.Environment("Process")("SAQME_OPEN_URL") = url
End If
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & dir & "\widget.ps1""", 0, False
