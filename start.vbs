Option Explicit

Dim WshShell, objFSO, strPath, strFolder, batPath, logPath, command
Set WshShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

strPath = WScript.ScriptFullName
strFolder = objFSO.GetParentFolderName(strPath)
batPath = objFSO.BuildPath(strFolder, "start.bat")
logPath = objFSO.BuildPath(strFolder, "start-vbs.log")

If Not objFSO.FileExists(batPath) Then
  WshShell.Popup "start.bat tidak ditemukan:" & vbCrLf & batPath, 10, "TikTok Automation", 16
  WScript.Quit 1
End If

WshShell.CurrentDirectory = strFolder
command = Quote(WshShell.ExpandEnvironmentStrings("%ComSpec%")) _
        & " /d /c call " & Quote(batPath) _
        & " >> " & Quote(logPath) & " 2>&1"
WshShell.Run command, 0, True

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
