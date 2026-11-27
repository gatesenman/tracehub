; Shown only on interactive installs. Silent /S (/S used by agent upgrades) skips this box.
!macro customInstall
  IfSilent +2
  MessageBox MB_OK "首次启动 TraceHub 时，会提示你开启实时页签权限。$\r$\n$\r$\n只有在 Chrome 或 Edge 中加载配套扩展并完成配对后，才能获取此刻打开的页签。$\r$\n$\r$\n选择稍后或跳过，不影响浏览历史同步，也不影响「从会话文件读取页签」。本安装程序不会替你安装或改动浏览器扩展。"
!macroend
