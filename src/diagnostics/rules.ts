import type { DiagnosticClient, Finding, RuleDefinition } from "./types.js";
export const verifiedVersions: Partial<Record<DiagnosticClient, string[]>> = {codex:["0.159.2"],claude:["2.1.89"],vscode:["1.120.0"]};
const groups = [
  {pattern:/TRANSPORT/,versions:true,precondition:"已知传输字段与宿主版本规则",impact:"宿主可能不接受所选传输类型",recheck:"相同版本原生入口核对传输并重新连接",counterexample:"URL 后缀和诊断器支持范围不证明宿主不支持"},
  {pattern:/PARSE|DUPLICATE|ROOT|REQUIRED|COMPLEXITY|UNSAFE|UNREADABLE/, versions: false, precondition:"已知路径的文件读取或格式校验结果",impact:"配置可能无法解析或字段不可读取",recheck:"重新扫描，格式有效后再核对原生加载",counterexample:"诊断器拒绝链接或无权限，不证明客户端也无法读取"},
  {pattern:/SHADOW|TRUST|PROFILE|MANAGED|OVERRIDE|APPROVAL|DISABLED|FILTERED|FIELD/,versions:true,precondition:"相关作用域配置及入口规则可见",impact:"定义可能被覆盖、跳过或限制",recheck:"相同工作区、Profile 和启动参数的原生配置/权限检查",counterexample:"覆盖、禁用和权限限制可以是有意设置"},
  {pattern:/VAR|INPUT|ENVFILE/,versions:true,precondition:"字段包含对应宿主的表达式或环境引用",impact:"值可能未解析或未传入服务",recheck:"核对表达式方言及目标进程环境，再重新发现工具",counterexample:"诊断器缺少变量不证明已有客户端也缺少"},
  {pattern:/COMMAND|CWD|RELATIVE|INSTALL|LAUNCHER|TRANSPORT/,versions:false,precondition:"已知入口字段与诊断进程文件系统/PATH",impact:"启动位置或传输方式可能不符合预期",recheck:"目标入口核对 PATH、cwd 和服务安装说明",counterexample:"诊断器和 IDE 的 PATH 不同，终端成功不证明 IDE 成功"},
  {pattern:/PROXY|CERT|AUTH|NETWORK/,versions:false,precondition:"已知配置和诊断进程的网络来源或选中检查的明确状态",impact:"代理、证书或目标认证可能阻断连接",recheck:"在相同原生入口复查选中端点；不扩大凭据传递",counterexample:"代理不同可能有意；TCP 可达不证明 TLS、认证或模型正常"},
];
export function ruleFor(finding: Pick<Finding,"code"|"client"|"detail"|"nextStep">, version: string|null): RuleDefinition {
  const group=groups.find(item=>item.pattern.test(finding.code));
  const versions=verifiedVersions[finding.client]??[];
  return { id:finding.code,applicableVersions:group?.versions?versions:["文件事实/诊断进程，不依赖客户端版本"],precondition:group?.precondition??"尚未取得相应入口的直接证据",impact:group?.impact??finding.detail,recheck:group?.recheck??finding.nextStep,counterexample:group?.counterexample??"文件变化不代表已有会话或工具缓存已刷新",versionStatus:!group?.versions?"independent":version&&versions.includes(version)?"verified":finding.client==="cursor"?"documented":"unknown" };
}
