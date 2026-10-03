using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
// Acceptance harness only: creates a hidden isolated console and sends a real Ctrl+C.
class ConsoleInterruptTest {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Start {public uint Size;public string Reserved,Desktop,Title;public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;public ushort Show,ReservedSize;public IntPtr ReservedBytes,Input,Output,Error;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr Process,Thread;public uint Pid,Tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Start start,out PI p);
 [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
 [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint signal,uint group);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint timeout);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static int Main(string[] args) {
   PI p=new PI();try{
     var argv=new JavaScriptSerializer().Deserialize<string[]>(Encoding.UTF8.GetString(Convert.FromBase64String(args[0])));
     // Reset the inherited Ctrl+C-ignore flag before spawning the target console.
     SetConsoleCtrlHandler(IntPtr.Zero,false);
     var start=new Start();start.Size=(uint)Marshal.SizeOf(start);start.Flags=1;start.Show=0;
     var line=new StringBuilder("\""+argv[0]+"\" \""+argv[1]+"\"");
     if(!CreateProcess(argv[0],line,IntPtr.Zero,IntPtr.Zero,false,0x10,IntPtr.Zero,null,ref start,out p))return 2;
     int elapsed=0;while(!File.Exists(argv[2])&&elapsed<10000){Thread.Sleep(50);elapsed+=50;}
     if(!File.Exists(argv[2]))return 3;
     FreeConsole();if(!AttachConsole(p.Pid))return 4;SetConsoleCtrlHandler(IntPtr.Zero,true);
     bool sent=GenerateConsoleCtrlEvent(0,0);Thread.Sleep(200);FreeConsole();
     if(!sent||WaitForSingleObject(p.Process,5000)!=0)return 5;return 0;
   }catch{return 6;}finally{if(p.Process!=IntPtr.Zero){TerminateProcess(p.Process,9);CloseHandle(p.Process);}if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);}
 }
}
