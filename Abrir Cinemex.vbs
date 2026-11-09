' Abre o Cinemex sem janela de consola (compila a interface se ainda não existir).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FileExists(dir & "\dist\index.html") Then sh.Run "cmd /c pnpm vite build", 0, True
sh.Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 1, False
