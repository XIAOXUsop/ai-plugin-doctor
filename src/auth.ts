export function isExpectedAuthReply(value: unknown): boolean {
  return typeof value === "string" && /^OK[.!]?$/i.test(value.trim());
}
