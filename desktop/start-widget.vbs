' Starts Saqme To Do without a console window (used by the shortcuts, the saqme: link and start-with-Windows).
' A saqme: link (saqme://join?... from a shared list's invite page) comes as the first argument; it reaches the app
' in SAQME_OPEN_URL, an environment variable rather than the command line, so there is no quoting to get wrong.
' The app asks before it joins anything.
' Installed, this file sits next to versions\ and starts the version current.txt names (the updater switches it;
' previous.txt is the one before, used while current.txt names a folder that is not there). Next to widget.ps1
' itself (a version's folder, a copy of the repository, an install before 1.1.0) it starts that one.
Set fs = CreateObject("Scripting.FileSystemObject")
dir = fs.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
  url = WScript.Arguments(0)
  If LCase(Left(url, 6)) = "saqme:" And Len(url) < 4096 Then sh.Environment("Process")("SAQME_OPEN_URL") = url
End If

Function VersionDir(name)
  VersionDir = ""
  p = dir & "\" & name
  If Not fs.FileExists(p) Then Exit Function
  Set f = fs.OpenTextFile(p, 1)
  v = ""
  If Not f.AtEndOfStream Then v = Trim(f.ReadLine)
  f.Close
  If Len(v) > 0 And Len(v) < 40 And InStr(v, "\") = 0 And InStr(v, "/") = 0 And InStr(v, "..") = 0 Then
    If fs.FileExists(dir & "\versions\" & v & "\widget.ps1") Then VersionDir = dir & "\versions\" & v
  End If
End Function

app = VersionDir("current.txt")
If app = "" Then app = VersionDir("previous.txt")
If app = "" Then app = dir
' the window starts in the tray only when the updater restarts an app whose window was hidden (SAQME_START_HIDDEN,
' passed on with the rest of the environment)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & app & "\widget.ps1""", 0, False
