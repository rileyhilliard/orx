import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Paths } from "~/config";
import { expandCommand, loadCommands, parseMarkdown, withArguments } from "~/core/commands";
import { expandSkill, loadSkills, loadSlash } from "~/core/skills";
import { SkillTools, skillToolLayer } from "~/tools/skill";

/** A workspace root and a user config dir (`~/.config/orx`), both empty temp dirs. */
const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), "orx-slash-"));
  const root = join(base, "repo");
  const userDir = join(base, "config", "orx");
  mkdirSync(root, { recursive: true });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const layer = Layer.merge(
    NodeServices.layer,
    Layer.succeed(Paths, {
      configFile: join(userDir, "config.json"),
      dataDir: join(base, "data"),
      logFile: Option.none(),
    }),
  );
  return {
    root,
    workspace: (rel: string, text: string) => write(join(root, ".orx", rel), text),
    user: (rel: string, text: string) => write(join(userDir, rel), text),
    run: <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Paths>) =>
      Effect.runPromise(Effect.provide(effect, layer)),
  };
};

describe("parseMarkdown", () => {
  it("reads scalar fields, quotes, and block values, and ignores what it doesn't know", () => {
    const { fields, body } = parseMarkdown(
      [
        "---",
        'description: "Review: the diff"',
        "model: 'acme/model'",
        "allowed-tools:",
        "  - Bash",
        "long: >",
        "  one",
        "  two",
        "---",
        "",
        "Body $ARGUMENTS",
      ].join("\r\n"),
    );
    expect(fields.description).toBe("Review: the diff");
    expect(fields.model).toBe("acme/model");
    expect(fields.long).toBe("one two");
    expect(body).toBe("Body $ARGUMENTS");
  });

  it("treats a file without frontmatter as all body", () => {
    expect(parseMarkdown("# Title\ntext")).toEqual({ fields: {}, body: "# Title\ntext" });
  });
});

describe("custom commands", () => {
  it("loads workspace and user commands, namespaces subdirectories, and the workspace wins", async () => {
    const f = fixture();
    f.user("commands/review.md", "---\ndescription: user review\n---\nuser body");
    f.user("commands/only-user.md", "Say hi to $ARGUMENTS");
    f.workspace(
      "commands/review.md",
      "---\ndescription: repo review\nmodel: acme/reviewer\nargument-hint: <path>\n---\nrepo body",
    );
    f.workspace("commands/git/commit.md", "---\ndescription: Commit\n---\nCommit it");
    f.workspace("commands/notes.txt", "not a command");
    const { items, warnings } = await f.run(loadCommands(f.root));
    expect(warnings).toEqual([]);
    expect(items.map((c) => [c.name, c.description])).toEqual([
      ["git:commit", "Commit"],
      ["only-user", "Say hi to $ARGUMENTS"],
      ["review", "repo review"],
    ]);
    expect(items.find((c) => c.name === "review")?.model).toBe("acme/reviewer");
  });

  it("skips a command whose name can't be typed, and falls back to the body's first line", async () => {
    const f = fixture();
    f.workspace("commands/listy.md", "---\ndescription:\n  - a list\n---\n# Tidy up\nbody");
    f.workspace("commands/has space.md", "body");
    const { items, warnings } = await f.run(loadCommands(f.root));
    expect(items.map((c) => [c.name, c.description])).toEqual([["listy", "Tidy up"]]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("has space.md");
  });

  it("returns nothing when neither directory exists", async () => {
    const f = fixture();
    expect(await f.run(loadCommands(f.root))).toEqual({ items: [], warnings: [] });
  });

  it("replaces $ARGUMENTS, or appends ARGUMENTS when the body has none", () => {
    const base = { name: "x", description: "", file: "x.md" };
    expect(expandCommand({ ...base, body: "Fix $ARGUMENTS now ($ARGUMENTS)" }, " #12 ")).toEqual({
      text: "Fix #12 now (#12)",
    });
    expect(expandCommand({ ...base, body: "Review", model: "m/1" }, "src/a.ts")).toEqual({
      text: "Review\n\nARGUMENTS: src/a.ts",
      model: "m/1",
    });
    expect(expandCommand({ ...base, body: "Review" }, "  ")).toEqual({ text: "Review" });
    // A `$&` in the arguments is text, not a replacement pattern.
    expect(withArguments("a $ARGUMENTS b", "$&")).toBe("a $& b");
  });
});

describe("skills", () => {
  it("loads SKILL.md directories, the workspace winning a clash", async () => {
    const f = fixture();
    f.user("skills/pdf/SKILL.md", "---\nname: pdf\ndescription: user pdf\n---\nuser");
    f.user("skills/tables/SKILL.md", "---\ndescription: Tables\n---\nMake tables");
    f.workspace(
      "skills/pdf/SKILL.md",
      "---\nname: pdf\ndescription: repo pdf\nallowed-tools: Bash\n---\nRead forms.md",
    );
    f.workspace("skills/empty/README.md", "no SKILL.md here");
    const { items, warnings } = await f.run(loadSkills(f.root));
    expect(warnings).toEqual([]);
    expect(items.map((s) => [s.name, s.description, s.body])).toEqual([
      ["pdf", "repo pdf", "Read forms.md"],
      ["tables", "Tables", "Make tables"],
    ]);
    expect(items[0]?.dir).toBe(join(f.root, ".orx", "skills", "pdf"));
  });

  it("warns about a long body or description but still loads the skill", async () => {
    const f = fixture();
    const long = Array.from({ length: 501 }, (_, i) => `line ${i}`).join("\n");
    f.workspace("skills/big/SKILL.md", `---\ndescription: ${"d".repeat(1025)}\n---\n${long}`);
    const { items, warnings } = await f.run(loadSkills(f.root));
    expect(items.map((s) => s.name)).toEqual(["big"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("501 lines");
    expect(warnings[1]).toContain("1025 characters");
  });

  it("skips a skill with no description or a bad name, with a warning", async () => {
    const f = fixture();
    f.workspace("skills/nodesc/SKILL.md", "---\nname: nodesc\n---\nbody");
    f.workspace("skills/badname/SKILL.md", "---\nname: a:b\ndescription: x\n---\nbody");
    const { items, warnings } = await f.run(loadSkills(f.root));
    expect(items).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it("warns when a skill and a command share a name; both stay loaded", async () => {
    const f = fixture();
    f.workspace("commands/deploy.md", "Deploy it");
    f.workspace("skills/deploy/SKILL.md", "---\ndescription: Deploying\n---\nsteps");
    const { commands, skills, warnings } = await f.run(loadSlash(f.root));
    expect(commands.map((c) => c.name)).toEqual(["deploy"]);
    expect(skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(warnings).toEqual(['Skill "deploy" has a command\'s name; /deploy runs the command']);
  });

  it("expands /skill args into the body with ARGUMENTS appended", () => {
    const skill = { name: "pdf", description: "d", dir: "/s/pdf", body: "Fill the form." };
    expect(expandSkill(skill, "a.pdf")).toBe("Fill the form.\n\nARGUMENTS: a.pdf");
    expect(expandSkill(skill, "")).toBe("Fill the form.");
  });
});

describe("the skill tool", () => {
  const skills = [{ name: "pdf", description: "PDFs", dir: "/home/u/skills/pdf", body: "Steps" }];
  const call = (name: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* SkillTools;
        const stream = yield* toolkit.handle("skill", { name });
        const results = yield* Stream.runCollect(stream);
        return results.at(-1);
      }).pipe(Effect.provide(skillToolLayer(skills))),
    );

  it("returns the body with the skill's directory", async () => {
    const result = await call("pdf");
    expect(result?.isFailure).toBe(false);
    expect(result?.result).toContain("/home/u/skills/pdf");
    expect(result?.result).toContain("Steps");
  });

  it("returns an unknown name to the model with the names it can use", async () => {
    const result = await call("nope");
    expect(result?.isFailure).toBe(true);
    expect(result?.result).toBe('Unknown skill "nope". Skills: pdf.');
  });
});
