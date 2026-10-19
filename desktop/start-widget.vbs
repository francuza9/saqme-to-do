' Starts Saqme To Do without a console window (used by the shortcuts, the saqme: link and start-with-Windows).
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & dir & "\widget.ps1""", 0, False
