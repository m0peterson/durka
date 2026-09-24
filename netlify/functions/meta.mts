import type { Config } from "@netlify/functions";
import { effectiveAccessCode, loadConfig, usableEntries } from "../lib/config.mts";
import { json } from "../lib/util.mts";

export default async () => {
  const cfg = await loadConfig();
  return json({
    codeRequired: Boolean(effectiveAccessCode(cfg)),
    configured: usableEntries(cfg).length > 0,
  });
};

export const config: Config = {
  path: "/api/meta",
  method: "GET",
};
