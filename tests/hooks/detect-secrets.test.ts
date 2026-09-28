import { describe, expect, it } from "bun:test";
import { denyReason, edit, REPO, runHook, write } from "../helpers/hooks";

// Credential-shaped values are assembled at runtime, so this file holds none itself (the hook
// would refuse to write it).
const chars = (n: number) => "Zq8Xw3Rt6Yp1Kd4Mv7Nb2".repeat(8).slice(0, n);
const secrets = {
  aws: `AKIA${"ABCDEFGHIJKLMNOP"}`,
  awsSecret: `aws_secret_access_key = "${chars(40)}"`,
  github: `ghp_${chars(36)}`,
  gitlab: `glpat-${chars(20)}`,
  slack: `xoxb-${chars(12)}`,
  slackHook: `https://hooks.slack.com/services/T${"ABC123"}/B${"DEF456"}/${chars(24)}`,
  stripeLive: `sk_live_${chars(24)}`,
  stripeTest: `sk_test_${chars(24)}`,
  anthropic: `sk-ant-${chars(40)}`,
  openai: `sk-proj-${chars(48)}`,
  // This project's own key: sk-or-v1- and 64 hex characters.
  openrouter: ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-"),
  google: `AIza${chars(35)}`,
  npm: `npm_${chars(36)}`,
  pem: `-----BEGIN RSA ${"PRIVATE KEY"}-----`,
  connection: `postgres://app:${chars(12)}@db.internal:5432/app`,
  jwt: `eyJ${chars(12)}.eyJ${chars(12)}.${chars(12)}`,
  generic: `api_key = "${chars(40)}"`,
};

const scan = (content: string, filePath = `${REPO}/src/config.ts`) =>
  runHook("PreToolUse", "detect-secrets", write(filePath, content));

describe.concurrent("detect-secrets denies", () => {
  it.each([
    ["AWS access key ID", secrets.aws],
    ["AWS secret access key", secrets.awsSecret],
    ["GitHub token", secrets.github],
    ["GitLab token", secrets.gitlab],
    ["Slack token or webhook", secrets.slack],
    ["Slack token or webhook", secrets.slackHook],
    ["Stripe live key", secrets.stripeLive],
    ["Stripe/Clerk test secret key", secrets.stripeTest],
    ["Anthropic API key", secrets.anthropic],
    ["OpenAI-style API key", secrets.openai],
    ["OpenAI-style API key", secrets.openrouter],
    ["Google API key", secrets.google],
    ["npm token", secrets.npm],
    ["Private key (PEM)", secrets.pem],
    ["Connection string with an embedded password", secrets.connection],
    ["JWT", secrets.jwt],
    ["Long literal assigned to a secret-looking name", secrets.generic],
  ])("%s", async (label, secret) => {
    expect(denyReason(await scan(`const value = "${secret}";\n`))).toContain(`- ${label}`);
  });

  it("names the file and lists every finding", async () => {
    const reason = denyReason(await scan(`${secrets.aws}\n${secrets.github}\n`));
    expect(reason).toMatch(/^BLOCKED: possible secret in the write to config\.ts\.\n\nDetected:\n/);
    expect(reason).toContain("- AWS access key ID\n- GitHub token\n");
    expect(reason).toContain('mark the line with a "pragma: allowlist secret" comment.');
  });

  it("checks an Edit's new_string", async () => {
    const payload = edit(`${REPO}/src/core/x.ts`, secrets.github);
    expect(denyReason(await runHook("PreToolUse", "detect-secrets", payload))).toContain(
      "GitHub token",
    );
  });

  it("scans content with no file path", async () => {
    const payload = write(undefined, secrets.aws);
    expect(denyReason(await runHook("PreToolUse", "detect-secrets", payload))).toContain(
      "AWS access key ID",
    );
  });

  it("finds a secret at the end of a large write", async () => {
    const content = `${"const filler = 1;\n".repeat(12_000)}${secrets.github}\n`;
    expect(content.length).toBeGreaterThan(200_000);
    expect(denyReason(await scan(content))).toContain("GitHub token");
  });

  it("reports an Anthropic key once, not also as OpenAI-style", async () => {
    const reason = denyReason(await scan(secrets.anthropic));
    expect(reason).toContain("Anthropic API key");
    expect(reason).not.toContain("OpenAI-style");
  });
});

describe.concurrent("detect-secrets allows", () => {
  it.each([
    ["a placeholder key", "ANTHROPIC_API_KEY=sk-ant-your-key-goes-here-0123456789"],
    ["a placeholder in angle brackets", `api_key = "<${chars(40)}>"`],
    ["an allowlisted line", `const k = "${secrets.aws}"; // pragma: allowlist secret`],
    ["a connection string with a stock password", "postgres://user:password@localhost:5432/db"],
    ["ordinary code", "export const answer = 42;\n"],
  ])("%s", async (_, content) => {
    const result = await scan(content);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each(["README.md", ".env.example", "bun.lock", "notes.txt"])(
    "anything in %s",
    async (name) => {
      expect((await scan(secrets.aws, `${REPO}/${name}`)).stdout).toBe("");
    },
  );
});
