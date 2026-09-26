// PreToolUse (Edit|Write): deny writes that contain something shaped like a real credential:
// cloud and SaaS API keys, private keys, tokens, connection strings with embedded passwords.
//
// High-confidence formats only, to keep false positives rare. Placeholder-looking values (your-,
// changeme, example, xxx...) are ignored by the generic rule, and a line containing "pragma:
// allowlist secret" is skipped entirely (the same marker the detect-secrets tool uses), for test
// fixtures that must look real.
import { basename } from "node:path";
import { deny, readPayload, text, writtenText } from "./_lib";

// Files where example credentials are expected, or that can't hold one.
const SKIPPED = [
  ".example",
  ".sample",
  ".template",
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".lock",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
];

const S = "[ \\t\\n\\v\\f\\r]";
const PLACEHOLDER =
  /(your[-_]|changeme|replace|example|placeholder|xxxx|fake|dummy|redacted|TODO|FIXME|<[^>]*>)/i;

function findings(lines: string[]): string[] {
  const has = (re: RegExp) => lines.some((line) => re.test(line));
  // Some line matches and doesn't look like a placeholder.
  const hasReal = (re: RegExp) => lines.some((line) => re.test(line) && !PLACEHOLDER.test(line));
  const found: string[] = [];
  const add = (label: string) => found.push(label);

  if (has(/AKIA[0-9A-Z]{16}/)) add("AWS access key ID");
  if (
    has(
      new RegExp(
        `(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)${S}*[:=]${S}*["']?[A-Za-z0-9/+=]{40}`,
      ),
    )
  ) {
    add("AWS secret access key");
  }
  if (has(/(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}/))
    add("GitHub token");
  if (has(/glpat-[A-Za-z0-9_-]{20,}/)) add("GitLab token");
  if (
    has(
      /xox[baprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
    )
  ) {
    add("Slack token or webhook");
  }
  if (has(/(sk|rk)_live_[A-Za-z0-9]{20,}/)) add("Stripe live key");
  if (has(/sk_test_[A-Za-z0-9]{20,}/)) add("Stripe/Clerk test secret key");
  if (hasReal(/sk-ant-[A-Za-z0-9_-]{20,}/)) add("Anthropic API key");
  if (hasReal(/sk-(proj-)?[A-Za-z0-9_-]{40,}/) && !has(/sk-ant-/)) add("OpenAI-style API key");
  if (has(/AIza[0-9A-Za-z_-]{35}/)) add("Google API key");
  if (has(/npm_[A-Za-z0-9]{36}/)) add("npm token");
  if (has(/-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/)) add("Private key (PEM)");
  if (
    has(
      /(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:/ \t\n\v\f\r]+:[^@ \t\n\v\f\r]{8,}@/,
    ) &&
    !has(/:\/\/[^:]+:(password|postgres|changeme|secret|pass|example)@/i)
  ) {
    add("Connection string with an embedded password");
  }
  if (has(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/)) add("JWT");
  // Generic: a long high-entropy literal assigned to a secret-looking name.
  if (
    hasReal(
      new RegExp(
        `(api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key)["']?${S}*[:=]${S}*["'][A-Za-z0-9/+=_-]{32,}["']`,
      ),
    )
  ) {
    add("Long literal assigned to a secret-looking name");
  }
  return found;
}

const payload = readPayload();
const filePath = text(payload?.tool_input?.file_path);
if (!SKIPPED.some((ext) => filePath.endsWith(ext))) {
  // Allowlisted lines are dropped before scanning.
  const lines = writtenText(payload?.tool_input)
    .split("\n")
    .filter((line) => !line.includes("pragma: allowlist secret"));
  const found = lines.some((line) => line !== "") ? findings(lines) : [];
  if (found.length > 0) {
    deny(
      `BLOCKED: possible secret in the write to ${basename(filePath)}.

Detected:
${found.map((label) => `- ${label}\n`).join("")}
Read credentials from environment variables (document them in .env.example) or a secrets manager.
If this is a deliberate fixture, ask the user, then mark the line with a "pragma: allowlist secret" comment.`,
    );
  }
}
