using System;
using System.IO;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

// CreateNew with a security descriptor: private bytes are never created with an
// inherited public ACL. Existing configuration ACLs are retained on replacements.
class SafeFile {
  public static int Main(string[] args) {
    try {
      if(args.Length<2 || !Path.IsPathRooted(args[1]))return 125;
      if(args[0]=="inspect") {
        var security=File.GetAccessControl(args[1]);var rules=new List<object>();
        foreach(FileSystemAccessRule rule in security.GetAccessRules(true,true,typeof(SecurityIdentifier)))rules.Add(new {sid=rule.IdentityReference.Value,inherited=rule.IsInherited,rights=(int)rule.FileSystemRights,type=rule.AccessControlType.ToString()});
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {owner=security.GetOwner(typeof(SecurityIdentifier)).Value,protectedAcl=security.AreAccessRulesProtected,rules=rules,sddl=security.GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner)}));return 0;
      }
      FileSecurity acl;
      if(args[0]=="private" && args.Length==2) {
        var sid=WindowsIdentity.GetCurrent().User;if(sid==null)return 125;
        acl=new FileSecurity();acl.SetOwner(sid);acl.SetAccessRuleProtection(true,false);
        acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
      } else if(args[0]=="preserve" && args.Length==3 && Path.IsPathRooted(args[2]))acl=File.GetAccessControl(args[2],AccessControlSections.Access|AccessControlSections.Owner);
      else return 125;
      using(var input=Console.OpenStandardInput())
      using(var output=new FileStream(args[1],FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,4096,FileOptions.WriteThrough,acl)) {
        byte[] buffer=new byte[4096];int count,total=0;while((count=input.Read(buffer,0,buffer.Length))>0){total+=count;if(total>2*1024*1024)return 125;output.Write(buffer,0,count);}output.Flush(true);
      }
      // Reapply an existing descriptor so Windows updates its inheritance control
      // bits as well as the ACE list (CreateFile alone can clear AUTO_INHERITED).
      if(args[0]=="preserve")File.SetAccessControl(args[1],acl);
      return 0;
    }catch{return 125;}
  }
}
