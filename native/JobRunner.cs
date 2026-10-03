using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// Starts the target suspended, assigns it before any code runs, and owns the only
// inheritable-disabled job handle. Closing or killing this runner closes the job.
class JobRunner {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Count; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Limits; public IO Counters; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref Extended info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder line,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup start,out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint time);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint time);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Quote(string value) {
    var s=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++;continue; } if(c=='"') { s.Append('\\',slashes*2+1);s.Append(c); } else { s.Append('\\',slashes);s.Append(c); } slashes=0; }
    s.Append('\\',slashes*2);s.Append('"');return s.ToString();
  }
  public static int Main(string[] args) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero; ProcessInfo p=new ProcessInfo();
    try {
      if(args.Length!=2)return 125;
      parent=OpenProcess(0x100000,false,uint.Parse(args[1]));if(parent==IntPtr.Zero)return 125;
      var argv=new JavaScriptSerializer().Deserialize<string[]>(Encoding.UTF8.GetString(Convert.FromBase64String(args[0])));
      if(argv.Length<1 || !System.IO.Path.IsPathRooted(argv[0]))return 125;
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero)return 125;
      var limits=new Extended();limits.Limits.Flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)))return 125;
      var start=new Startup();start.Size=(uint)Marshal.SizeOf(start);start.Flags=0x100;
      start.Input=GetStdHandle(-10);start.Output=GetStdHandle(-11);start.Error=GetStdHandle(-12);
      foreach(var h in new[]{start.Input,start.Output,start.Error})if(!SetHandleInformation(h,1,1))return 125;
      var line=new StringBuilder();foreach(string value in argv){if(line.Length>0)line.Append(' ');line.Append(Quote(value));}
      if(!CreateProcess(argv[0],line,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref start,out p))return 125;
      if(!AssignProcessToJobObject(job,p.Process)){TerminateProcess(p.Process,125);return 125;}
      if(ResumeThread(p.Thread)==0xffffffff){TerminateProcess(p.Process,125);return 125;}
      var wait=WaitForMultipleObjects(2,new[]{p.Process,parent},false,0xffffffff);if(wait!=0)return 130;uint code;GetExitCodeProcess(p.Process,out code);return unchecked((int)code);
    } catch { return 125; }
    finally { if(job!=IntPtr.Zero)CloseHandle(job);if(parent!=IntPtr.Zero)CloseHandle(parent);if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);if(p.Process!=IntPtr.Zero)CloseHandle(p.Process); }
  }
}
