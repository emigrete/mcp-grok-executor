import { access, constants } from "node:fs/promises";
import { config } from "./config.js";

export type AuthStatus = {
  ok: boolean;
  authPath: string;
  message: string;
};

export async function checkGrokAuth(): Promise<AuthStatus> {
  const authPath = config.authPath;
  try {
    await access(authPath, constants.R_OK);
    return {
      ok: true,
      authPath,
      message: `Grok auth found at ${authPath}`,
    };
  } catch {
    return {
      ok: false,
      authPath,
      message:
        `Grok is not logged in (missing ${authPath}). ` +
        `Run \`grok login\` once (SuperGrok / X Premium+ OAuth). ` +
        `Do not put XAI_API_KEY in this bridge unless you intentionally want pay-as-you-go billing.`,
    };
  }
}
