export interface PageLocation {
  protocol: string;
  hostname: string;
  port: string;
  host: string;
}

export function syncUrl(where: PageLocation): string {
  const protocol = where.protocol === "https:" ? "wss:" : "ws:";
  const host =
    where.hostname === "localhost"
      ? "127.0.0.1" + (where.port ? ":" + where.port : "")
      : where.host;
  return protocol + "//" + host + "/sync";
}
