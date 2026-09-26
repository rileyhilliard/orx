import { join } from "node:path";
import {
  Config,
  ConfigProvider,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  type LogLevel,
  Option,
  Redacted,
  Schema,
  SchemaIssue,
} from "effect";
import { InvalidConfig } from "./errors";
import type { LoggerOptions } from "./logging";
import { ConfigFile } from "./schemas";

/** Used when OPENROUTER_MODEL is empty or unset. Keep in step with .env.example. */
export const FALLBACK_DEFAULT_MODEL = "openai/gpt-6-luna";

/** Used when SYSTEM_PROMPT is empty or unset. */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful, concise assistant running in a terminal.",
  "Answer in plain language; use Markdown only when it helps.",
  "When the user asks about the current time somewhere, call the currentTime tool instead of guessing.",
].join(" ");

/** Where `orx update` and install.sh look for releases. Pending: set before the first tag. */
export const DEFAULT_RELEASES_REPO = "rileyhilliard/orx";

export type ProviderSort = "price" | "throughput" | "latency";

export interface AppConfigShape {
  /** None when OPENROUTER_API_KEY is unset or empty: model commands fail with NotConfigured. */
  readonly apiKey: Option.Option<Redacted.Redacted<string>>;
  /** OpenRouter API base URL. Tests and `bun run stub` point it at a local stub server. */
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly systemPrompt: string;
  readonly routing: {
    readonly fallbackModels: ReadonlyArray<string>;
    readonly providerSort: Option.Option<ProviderSort>;
    readonly allowFallbacks: boolean;
    readonly dataCollection: "allow" | "deny";
    readonly zdr: boolean;
  };
  readonly limits: {
    readonly maxOutputTokens: number;
    readonly maxToolSteps: number;
    readonly maxStreamDuration: Duration.Duration;
  };
  readonly modelsCacheTtl: Duration.Duration;
  readonly releases: {
    /** GitHub API base URL (tests point it at a stub). */
    readonly apiUrl: string;
    readonly repo: string;
  };
}

/** A string that counts as unset when empty (`.env` files often carry `NAME=`). */
const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value.trim() !== "")),
    Config.map(Option.map((value) => value.trim())),
  );

const stringOr = (name: string, fallback: string) =>
  optionalString(name).pipe(Config.map(Option.getOrElse(() => fallback)));

/** A config error that names the variable, e.g. `MAX_TOOL_STEPS: Expected a positive integer, got "x"`. */
const invalid = (name: string, message: string) =>
  Effect.fail(
    new Config.ConfigError(new ConfigProvider.SourceError({ message: `${name}: ${message}` })),
  );

const positiveInt = (name: string, fallback: number) =>
  optionalString(name).pipe(
    Config.mapEffect((value) => {
      if (Option.isNone(value)) return Effect.succeed(fallback);
      const parsed = Number(value.value);
      return Number.isInteger(parsed) && parsed > 0
        ? Effect.succeed(parsed)
        : invalid(name, `Expected a positive integer, got "${value.value}"`);
    }),
  );

const boolOr = (name: string, fallback: boolean) =>
  optionalString(name).pipe(
    Config.mapEffect((value) => {
      if (Option.isNone(value)) return Effect.succeed(fallback);
      const v = value.value.toLowerCase();
      if (v === "true" || v === "1") return Effect.succeed(true);
      if (v === "false" || v === "0") return Effect.succeed(false);
      return invalid(name, `Expected true or false, got "${value.value}"`);
    }),
  );

const oneOf = <T extends string>(name: string, values: ReadonlyArray<T>) =>
  optionalString(name).pipe(
    Config.mapEffect((value) => {
      if (Option.isNone(value)) return Effect.succeed(Option.none<T>());
      const match = values.find((v) => v === value.value.toLowerCase());
      return match
        ? Effect.succeed(Option.some(match))
        : invalid(name, `Expected one of ${values.join(", ")}, got "${value.value}"`);
    }),
  );

const csv = (name: string) =>
  optionalString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [] as ReadonlyArray<string>,
        onSome: (value) =>
          value
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part !== ""),
      }),
    ),
  );

/**
 * Where `orx update` looks for releases. Env only, and read on its own (not through
 * AppConfig), so a broken config file can't block the update that might fix it.
 */
export const releasesConfig = Config.all({
  apiUrl: stringOr("ORX_RELEASES_URL", "https://api.github.com"),
  repo: stringOr("ORX_RELEASES_REPO", DEFAULT_RELEASES_REPO),
});

/** Every setting a command can read, from env (or the config file, which fills the same names). */
export const appConfig: Config.Config<AppConfigShape> = Config.all({
  apiKey: Config.Redacted("OPENROUTER_API_KEY").pipe(
    Config.option,
    Config.map(Option.filter((key) => Redacted.value(key).trim() !== "")),
  ),
  baseUrl: stringOr("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  defaultModel: stringOr("OPENROUTER_MODEL", FALLBACK_DEFAULT_MODEL),
  systemPrompt: stringOr("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
  routing: Config.all({
    fallbackModels: csv("OPENROUTER_FALLBACK_MODELS"),
    providerSort: oneOf<ProviderSort>("OPENROUTER_PROVIDER_SORT", [
      "price",
      "throughput",
      "latency",
    ]),
    allowFallbacks: boolOr("OPENROUTER_ALLOW_FALLBACKS", true),
    dataCollection: oneOf("OPENROUTER_DATA_COLLECTION", ["allow", "deny"] as const).pipe(
      Config.map(Option.getOrElse(() => "allow" as const)),
    ),
    zdr: boolOr("OPENROUTER_ZDR", false),
  }),
  limits: Config.all({
    maxOutputTokens: positiveInt("MAX_OUTPUT_TOKENS", 1024),
    maxToolSteps: positiveInt("MAX_TOOL_STEPS", 5),
    maxStreamDuration: positiveInt("MAX_STREAM_SECONDS", 120).pipe(Config.map(Duration.seconds)),
  }),
  modelsCacheTtl: Config.succeed(Duration.minutes(10)),
  releases: releasesConfig,
});

/** Where orx keeps its files. Can't fail: every path has a default. */
export interface PathsShape {
  readonly configFile: string;
  readonly dataDir: string;
  /** Also append JSON log lines here. `bun run orx` sets it to logs/orx.jsonl. */
  readonly logFile: Option.Option<string>;
}

export const pathsConfig: Config.Config<PathsShape> = Config.all({
  home: stringOr("HOME", "."),
  xdgConfig: optionalString("XDG_CONFIG_HOME"),
  xdgData: optionalString("XDG_DATA_HOME"),
  dataDir: optionalString("ORX_DATA_DIR"),
  logFile: optionalString("ORX_LOG_FILE"),
}).pipe(
  Config.map(({ home, xdgConfig, xdgData, dataDir, logFile }) => ({
    configFile: join(
      Option.getOrElse(xdgConfig, () => join(home, ".config")),
      "orx",
      "config.json",
    ),
    dataDir: Option.getOrElse(dataDir, () =>
      join(
        Option.getOrElse(xdgData, () => join(home, ".local", "share")),
        "orx",
      ),
    ),
    logFile,
  })),
);

export class Paths extends Context.Service<Paths, PathsShape>()("orx/Paths") {
  static readonly layer = Layer.effect(Paths, pathsConfig.pipe(Effect.orDie));
}

/** Config file keys as the env var names they stand in for. */
const fileToEnv = (file: ConfigFile): Record<string, string> => {
  const entries: Array<[string, string | undefined]> = [
    ["OPENROUTER_MODEL", file.model],
    ["SYSTEM_PROMPT", file.systemPrompt],
    ["OPENROUTER_FALLBACK_MODELS", file.fallbackModels?.join(",")],
    ["OPENROUTER_PROVIDER_SORT", file.providerSort],
    ["OPENROUTER_ALLOW_FALLBACKS", file.allowFallbacks?.toString()],
    ["OPENROUTER_DATA_COLLECTION", file.dataCollection],
    ["OPENROUTER_ZDR", file.zdr?.toString()],
    ["MAX_OUTPUT_TOKENS", file.maxOutputTokens?.toString()],
    ["MAX_TOOL_STEPS", file.maxToolSteps?.toString()],
    ["MAX_STREAM_SECONDS", file.maxStreamSeconds?.toString()],
  ];
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
};

const formatIssue = SchemaIssue.makeFormatterDefault();
const decodeConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile), {
  onExcessProperty: "error",
});

/** The config file's values, or none when it doesn't exist. A bad file is InvalidConfig. */
const readConfigFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return {};
    const text = yield* fs
      .readFileString(path)
      .pipe(
        Effect.mapError(
          (error) => new InvalidConfig({ message: `Can't read ${path}: ${error.message}` }),
        ),
      );
    const file = yield* decodeConfigFile(text).pipe(
      Effect.mapError(
        (error) => new InvalidConfig({ message: `${path}: ${formatIssue(error.issue)}` }),
      ),
    );
    return fileToEnv(file);
  });

/**
 * Loads env over the config file, once per process (cached). Commands call it only when they
 * need settings, so a broken config file never breaks `--help`, `--version`, or `update`.
 */
const makeLoad = Effect.gen(function* () {
  const { configFile } = yield* Paths;
  const env = yield* ConfigProvider.ConfigProvider;
  const services = yield* Effect.context<FileSystem.FileSystem>();
  return yield* Effect.cached(
    Effect.gen(function* () {
      const fromFile = yield* readConfigFile(configFile);
      return yield* appConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(env, ConfigProvider.fromUnknown(fromFile)),
        ),
        Effect.mapError((error) => new InvalidConfig({ message: error.message })),
      );
    }).pipe(Effect.provideContext(services)),
  );
});

export interface AppConfigService {
  readonly load: Effect.Effect<AppConfigShape, InvalidConfig>;
}

export class AppConfig extends Context.Service<AppConfig, AppConfigService>()("orx/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.map(makeLoad, (load) => ({ load })),
  );
}

/** The settings, loaded on first use. */
export const loadConfig = Effect.flatMap(AppConfig, (config) => config.load);

const logLevels: Record<"debug" | "info" | "warn" | "error", LogLevel.LogLevel> = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
};

/**
 * Logging goes to stderr (stdout is for results), `warn` and up by default so a normal run is
 * quiet; `bun run orx` defaults LOG_LEVEL to info. ORX_LOG_FORMAT=json makes stderr lines
 * JSON; ORX_LOG_FILE also appends JSON lines to a file, at the same level. The built-in
 * `--log-level` flag overrides the level for one run. A bad value falls back to the default
 * rather than breaking every command (including --help).
 */
export const logConfig: Config.Config<LoggerOptions> = Config.all({
  level: oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"] as const).pipe(
    Config.orElse(() => Config.succeed(Option.none())),
  ),
  format: oneOf("ORX_LOG_FORMAT", ["pretty", "json"] as const).pipe(
    Config.orElse(() => Config.succeed(Option.none())),
  ),
  noColor: optionalString("NO_COLOR"),
  forceColor: optionalString("FORCE_COLOR"),
  paths: pathsConfig,
}).pipe(
  Config.map(({ level, format, noColor, forceColor, paths }) => ({
    format: Option.getOrElse(format, () => "pretty" as const),
    color:
      Option.isNone(noColor) &&
      Option.match(forceColor, {
        onNone: () => process.stderr.isTTY === true,
        onSome: (value) => value !== "0",
      }),
    minimumLevel: logLevels[Option.getOrElse(level, () => "warn" as const)],
    ...(Option.isSome(paths.logFile) ? { file: paths.logFile.value } : {}),
  })),
);

/** Whether human-facing stderr lines (Output.note) may use color. */
export const outputConfig = Config.all({
  noColor: optionalString("NO_COLOR"),
  forceColor: optionalString("FORCE_COLOR"),
}).pipe(
  Config.map(({ noColor, forceColor }) => ({
    color:
      Option.isNone(noColor) &&
      Option.match(forceColor, {
        onNone: () => process.stderr.isTTY === true,
        onSome: (value) => value !== "0",
      }),
  })),
);
